"""
FoodCatch – proof of concept.

Viser ugens Netto-tilbud på sunde basisvarer i nærheden af en adresse og
sammenligner kiloprisen med:
  1) tilbud fra andre kæder med en butik i nærheden (samme uge)
  2) Rema 1000's normalpriser (hele sortimentet, ikke-kampagne)
  3) egen historik (alt gemmes i SQLite ved hver kørsel)

Datakilder (ingen login/nøgle):
  - Tjek / eTilbudsavis  https://squid-api.tjek.com/v2   (Netto.dk bruger selv denne)
  - Rema 1000 katalog    https://cphapp.rema1000.dk/api/v3
  - OpenStreetMap Nominatim til geokodning af adressen

Varegenkendelse: se matching.py (evalueres med eval_matching.py).

Kør:  python3 foodcatch_poc.py "Nørrebrogade 10, 2200 København N"
"""

from __future__ import annotations

import argparse
import math
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from matching import Match, classify, comparability, is_healthy_staple

TJEK = "https://squid-api.tjek.com/v2"
REMA = "https://cphapp.rema1000.dk/api/v3"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
UA = "foodcatch-poc/0.1"
DB_PATH = Path(__file__).parent / "data" / "foodcatch.db"

NETTO_ID = "9ba51"
# Kæder vi sammenligner med (Tjek dealer-id -> navn)
COMPETITORS = {
    "11deC": "REMA 1000",
    "71c90": "Lidl",
    "bdf5A": "føtex",
    "DWZE1w": "365discount",
    "93f13": "Bilka",
    "65caN": "Løvbjerg",
    "0b1e8": "SuperBrugsen",
    "c1edq": "Kvickly",
    "267e1m": "MENY",
}

# ---------------------------------------------------------------------------
# HTTP-hjælpere
# ---------------------------------------------------------------------------
session = requests.Session()
session.headers["User-Agent"] = UA


def get_json(url: str, **params):
    for attempt in range(3):
        r = session.get(url, params=params, timeout=30)
        if r.status_code == 429:
            time.sleep(2 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Datakilder
# ---------------------------------------------------------------------------
def geocode(address: str) -> tuple[float, float, str]:
    res = get_json(NOMINATIM, q=address, format="json", limit=1, countrycodes="dk")
    if not res:
        sys.exit(f"Kunne ikke finde adressen: {address}")
    return float(res[0]["lat"]), float(res[0]["lon"]), res[0]["display_name"]


def nearby_stores(
    dealer_ids: list[str], lat: float, lng: float, radius_m: int
) -> list[dict]:
    stores = get_json(
        f"{TJEK}/stores",
        dealer_ids=",".join(dealer_ids),
        r_lat=lat,
        r_lng=lng,
        r_radius=radius_m,
        limit=100,
    )
    for s in stores:
        s["distance_km"] = haversine_km(lat, lng, s["latitude"], s["longitude"])
    return sorted(
        [s for s in stores if s["distance_km"] * 1000 <= radius_m],
        key=lambda s: s["distance_km"],
    )


def active_catalogs(dealer_id: str, days_ahead: int = 3) -> list[dict]:
    """Aviser der gælder nu eller starter inden for `days_ahead` dage."""
    now = datetime.now(timezone.utc)
    cats = get_json(f"{TJEK}/catalogs", dealer_ids=dealer_id, limit=24)
    out = []
    for c in cats:
        start = datetime.fromisoformat(c["run_from"])
        end = datetime.fromisoformat(c["run_till"])
        if end >= now and start <= now + timedelta(days=days_ahead):
            if "nonfood" not in (c.get("label") or "").lower():
                out.append(c)
    return out


def catalog_offers(catalog_id: str) -> list[dict]:
    offers, offset = [], 0
    while True:
        page = get_json(
            f"{TJEK}/offers", catalog_ids=catalog_id, limit=100, offset=offset
        )
        offers += page
        if len(page) < 100:
            return offers
        offset += 100
        time.sleep(0.2)


@dataclass
class Offer:
    source: str  # "tjek" / "rema"
    chain: str
    offer_id: str
    name: str
    description: str
    price: float
    pre_price: float | None
    unit: str  # "kg" / "l" / "stk"
    unit_price_min: float | None
    unit_price_max: float | None
    valid_from: str | None
    valid_to: str | None
    matches: list[Match] = field(default_factory=list)
    is_campaign: bool = True

    @property
    def class_keys(self) -> str:
        return ";".join(m.class_key() for m in self.matches)

    def price_applies_to(self, m: Match) -> bool:
        """Gælder tilbuddets kilopris entydigt for varen m?

        Ja hvis alle varianter i tilbuddet er samme vareklasse ("Arla Klovborg eller
        Cheasy skæreost"), eller hvis prisintervallet er så snævert at det er ligegyldigt.
        Nej ved fx "Mørbrad, skank eller stegeben" – kiloprisen kan høre til stegebenet.
        """
        if m.offer_is_homogeneous or self.unit_price_min is None:
            return True
        return (self.unit_price_max or 0) <= self.unit_price_min * 1.25


def parse_tjek_offer(o: dict, chain: str) -> Offer:
    q = o.get("quantity") or {}
    unit = q.get("unit") or {}
    si = unit.get("si") or {}
    size = q.get("size") or {}
    pieces = (q.get("pieces") or {}).get("from") or 1
    price = o["pricing"]["price"]
    sym = {"pcs": "stk"}.get(si.get("symbol"), si.get("symbol") or "?")
    factor = si.get("factor") or 1
    umin = umax = None
    if size.get("from") and size.get("to"):
        lo, hi = size["from"] * factor * pieces, size["to"] * factor * pieces
        if lo > 0 and hi > 0:
            umin, umax = price / hi, price / lo
    pre = o["pricing"].get("pre_price")
    # Netto skriver nogle gange "Normalpris 19,95" i beskrivelsen
    m = re.search(r"normalpris\s*([\d.]+,\d{2}|\d+)", o.get("description") or "", re.I)
    if not pre and m:
        pre = float(m.group(1).replace(".", "").replace(",", "."))
    return Offer(
        "tjek",
        chain,
        o["id"],
        o["heading"],
        (o.get("description") or "").replace("\n", " "),
        price,
        pre,
        sym,
        umin,
        umax,
        o.get("run_from"),
        o.get("run_till"),
        classify(o["heading"], o.get("description") or ""),
    )


def rema_catalog() -> list[Offer]:
    """Hele Rema 1000-sortimentet med normal- og kampagnepris."""
    out, page, now = [], 1, datetime.now(timezone.utc)
    while True:
        d = get_json(f"{REMA}/products", per_page=1000, page=page)
        for p in d["data"]:
            ms = classify(p["name"], p.get("underline") or "")
            for pr in p.get("prices") or []:
                start = datetime.fromisoformat(pr["starting_at"])
                end = datetime.fromisoformat(pr["ending_at"])
                if not (start <= now <= end) or not pr.get("compare_unit_price"):
                    continue
                unit = {"ltr": "l", "liter": "l", "stk.": "stk"}.get(
                    pr["compare_unit"], pr["compare_unit"]
                )
                out.append(
                    Offer(
                        "rema",
                        "REMA 1000",
                        str(p["id"]),
                        p["name"].capitalize(),
                        p.get("underline") or "",
                        pr["price"],
                        None,
                        unit,
                        pr["compare_unit_price"],
                        pr["compare_unit_price"],
                        pr["starting_at"],
                        pr["ending_at"],
                        ms,
                        bool(pr["is_campaign"]),
                    )
                )
        if page >= d["meta"]["pagination"]["last_page"]:
            return out
        page += 1
        time.sleep(0.2)


# ---------------------------------------------------------------------------
# Historik (SQLite)
# ---------------------------------------------------------------------------
def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("""CREATE TABLE IF NOT EXISTS price_obs (
        observed_on TEXT, source TEXT, chain TEXT, offer_id TEXT, name TEXT, description TEXT,
        price REAL, pre_price REAL, unit TEXT, unit_price_min REAL, unit_price_max REAL,
        valid_from TEXT, valid_to TEXT, category TEXT, is_campaign INTEGER,
        PRIMARY KEY (observed_on, source, offer_id, is_campaign))""")
    return con


def save(con: sqlite3.Connection, offers: list[Offer]) -> None:
    today = datetime.now().date().isoformat()
    con.executemany(
        "INSERT OR REPLACE INTO price_obs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (
                today,
                o.source,
                o.chain,
                o.offer_id,
                o.name,
                o.description,
                o.price,
                o.pre_price,
                o.unit,
                o.unit_price_min,
                o.unit_price_max,
                o.valid_from,
                o.valid_to,
                o.class_keys,  # kolonnen 'category' gemmer nu varegenkendelsens klasse-nøgler
                int(o.is_campaign),
            )
            for o in offers
        ],
    )
    con.commit()


def netto_history(
    con: sqlite3.Connection, class_key: str, unit: str, exclude_ids: set[str]
) -> list[tuple[str, float]]:
    """Tidligere Netto-tilbud på præcis samme vareklasse: [(navn, kilopris)]."""
    rows = con.execute(
        """SELECT DISTINCT offer_id, name, unit_price_min, unit_price_max, category FROM price_obs
           WHERE chain='Netto' AND unit=? AND unit_price_min IS NOT NULL""",
        (unit,),
    ).fetchall()
    out = []
    for offer_id, name, umin, umax, keys in rows:
        keys = (keys or "").split(";")
        if offer_id in exclude_ids or class_key not in keys:
            continue
        # kun entydige historiske priser (én vare eller snævert prisinterval)
        if len(keys) == 1 or (umax or 0) <= umin * 1.25:
            out.append((name, umin))
    return out


# ---------------------------------------------------------------------------
# Rapport
# ---------------------------------------------------------------------------
def fmt_up(o: Offer) -> str:
    if o.unit_price_min is None:
        return "?"
    if o.unit_price_max and abs(o.unit_price_max - o.unit_price_min) > 0.5:
        return f"{o.unit_price_min:.0f}-{o.unit_price_max:.0f} kr/{o.unit}"
    return f"{o.unit_price_min:.2f} kr/{o.unit}"


@dataclass
class Ref:
    """En referencepris for samme (eller lignende) vare."""

    kind: str  # "tilbud", "normalpris", "historik"
    chain: str
    name: str
    unit_price: float
    level: str  # "samme" / "lignende"


def find_refs(m: Match, unit: str, pool: list[Offer], kind: str) -> list[Ref]:
    refs = []
    for c in pool:
        if c.unit != unit or c.unit_price_min is None:
            continue
        for cm in c.matches:
            level = comparability(m, cm)
            if level is None:
                continue
            # Konkurrentens bedste tilfælde (laveste kilopris) – men kun hvis prisen
            # entydigt kan tilskrives varen; ellers højst "lignende".
            if level == "samme" and not c.price_applies_to(cm):
                level = "lignende"
            refs.append(Ref(kind, c.chain, c.name, c.unit_price_min, level))
            break
    return refs


def main():
    ap = argparse.ArgumentParser(
        description="FoodCatch PoC – Netto-tilbud på basisvarer nær dig"
    )
    ap.add_argument("address", help='fx "Nørrebrogade 10, 2200 København N"')
    ap.add_argument(
        "--radius", type=int, default=2000, help="radius i meter (default 2000)"
    )
    args = ap.parse_args()

    lat, lng, display = geocode(args.address)
    print(f"\n📍 {display}\n   ({lat:.5f}, {lng:.5f}), radius {args.radius} m\n")

    stores = nearby_stores([NETTO_ID, *COMPETITORS], lat, lng, args.radius)
    netto_stores = [s for s in stores if s["dealer_id"] == NETTO_ID]
    if not netto_stores:
        sys.exit("Ingen Netto-butikker inden for radius.")
    print("Netto-butikker i nærheden:")
    for s in netto_stores[:5]:
        print(
            f"   {s['distance_km']*1000:5.0f} m  {s['street']}, {s['zip_code']} {s['city']}"
        )
    chains_near = {s["dealer_id"] for s in stores} - {NETTO_ID}
    print(
        "Andre kæder i nærheden:",
        ", ".join(sorted(COMPETITORS[d] for d in chains_near)) or "ingen",
    )

    # --- Hent data -----------------------------------------------------------
    print("\nHenter aviser fra Tjek ...", flush=True)
    netto_offers: list[Offer] = []
    for c in active_catalogs(NETTO_ID):
        print(f"   Netto: {c['label']}  ({c['run_from'][:10]} → {c['run_till'][:10]})")
        netto_offers += [parse_tjek_offer(o, "Netto") for o in catalog_offers(c["id"])]

    comp_offers: list[Offer] = []
    for did in sorted(chains_near):
        for c in active_catalogs(did):
            comp_offers += [
                parse_tjek_offer(o, COMPETITORS[did]) for o in catalog_offers(c["id"])
            ]
    print(
        f"   {len(netto_offers)} Netto-tilbud, {len(comp_offers)} tilbud fra andre kæder"
    )

    print("Henter Rema 1000-sortiment (normalpriser) ...", flush=True)
    rema = rema_catalog()
    print(f"   {len({o.offer_id for o in rema})} Rema-varer")

    con = db()
    save(con, netto_offers + comp_offers + rema)

    # --- Sammenlign ----------------------------------------------------------
    relevant = [
        (o, m) for o in netto_offers for m in o.matches if is_healthy_staple(m)
    ]
    relevant.sort(key=lambda om: (om[1].vtype.group, om[1].vtype.label, om[1].label()))
    print(
        f"\n{len({o.offer_id for o, _ in relevant})} af {len(netto_offers)} Netto-tilbud "
        f"indeholder sunde basisvarer ({len(relevant)} varer):\n"
    )
    rema_normal = [r for r in rema if not r.is_campaign]
    counts = {"godt": 0, "ikke": 0, "uafklaret": 0, "ukendt": 0}

    current = None
    for o, m in relevant:
        if m.vtype.label != current:
            current = m.vtype.label
            print(f"━━ {current} " + "━" * (60 - len(current)))
        print(
            f"  NETTO  {o.name[:46]:46} {o.price:>6.2f} kr  {fmt_up(o):>18}"
            f"   {o.valid_from[5:10]}→{o.valid_to[5:10]}"
        )
        note = f" ({'; '.join(m.notes)})" if m.notes else ""
        print(f"         = {m.label()}{note}")
        if o.pre_price:
            print(f"         Nettos egen normalpris: {o.pre_price:.2f} kr")
        if o.unit_price_min is None:
            print("         Kilopris ukendt – ingen prisdom")
            counts["ukendt"] += 1
            continue
        # Konservativt: Nettos HØJESTE mulige kilopris i tilbuddet
        netto_up = o.unit_price_max or o.unit_price_min
        if not o.price_applies_to(m):
            print("         ⚠ Tilbuddet dækker flere varer med forskellig vægt – ingen prisdom")
            counts["ukendt"] += 1
            continue

        refs = (
            find_refs(m, o.unit, comp_offers, "tilbud")
            + find_refs(m, o.unit, rema_normal, "normalpris")
            + [
                Ref("historik", "Netto", n, up, "samme")
                for n, up in netto_history(con, m.class_key(), o.unit, {o.offer_id})
            ]
            if m.is_exact
            else []
        )
        same = sorted((r for r in refs if r.level == "samme"), key=lambda r: r.unit_price)
        if not m.is_exact:
            missing = [k for k in m.all_keys if m.attrs.get(k, "?") == "?"]
            print(f"         ❔ Ukendt: {', '.join(missing)} – kan ikke sammenlignes præcist")
            counts["ukendt"] += 1
            continue
        if not same:
            print("         ❔ Ingen samme vare fundet hos andre kæder, Rema eller i historikken")
            counts["ukendt"] += 1
            continue

        # vis billigste reference pr. type
        for kind, label in [
            ("tilbud", "Tilbud"),
            ("normalpris", "Rema normal"),
            ("historik", "Netto før"),
        ]:
            ks = [r for r in same if r.kind == kind]
            if ks:
                r = ks[0]
                diff = (netto_up / r.unit_price - 1) * 100
                print(
                    f"         {label:11} {r.unit_price:7.2f} kr/{o.unit} ({diff:+4.0f}%)  "
                    f"{r.chain}: {r.name[:40]}  [n={len(ks)}]"
                )
        cheapest = same[0]
        if netto_up <= cheapest.unit_price:
            print(f"         ✅ GODT KØB – billigst af {len(same)} sammenlignelige priser")
            counts["godt"] += 1
        elif o.unit_price_min > cheapest.unit_price:
            print(
                f"         ✖ Billigere: {cheapest.chain} {cheapest.unit_price:.2f} kr/{o.unit} "
                f"({cheapest.kind})"
            )
            counts["ikke"] += 1
        else:
            print(
                f"         ≈ Uafklaret: Nettos kilopris afhænger af pakningen "
                f"({fmt_up(o)}) og overlapper {cheapest.unit_price:.2f} kr/{o.unit}"
            )
            counts["uafklaret"] += 1
        print()

    print(
        f"\nOpsummering: {counts['godt']} gode køb, {counts['ikke']} kan fås billigere, "
        f"{counts['uafklaret']} uafklarede, {counts['ukendt']} uden sikker sammenligning."
    )
    print(f"Historik gemt i {DB_PATH}")
    print(
        "Prisdom gives kun mod SAMME vare (type + fedt%/øko/laktosefri/form ...). "
        "Nettos pris regnes i værste fald, andres i bedste fald."
    )


if __name__ == "__main__":
    main()
