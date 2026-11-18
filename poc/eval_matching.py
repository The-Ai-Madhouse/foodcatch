"""
Evaluering af varegenkendelsen.

A) Facit fra Salling: madspild-varer har EAN + Sallings egen kategori. Vi
   klassificerer KUN ud fra varenavnet og sammenligner med kategorien.
B) Gennemsynsliste for Tjek-aviser og Rema-katalog (ingen facit): skrives til
   data/review.md, så et menneske kan kontrollere klassifikationerne.

Kør:  python3 eval_matching.py
"""

from __future__ import annotations

import collections
import json
import re
import sqlite3
import sys
from pathlib import Path

from matching import (
    SALLING_CATEGORY_ATTRS,
    SALLING_CATEGORY_MAP,
    SALLING_NON_STAPLE,
    _cat_leaf,
    classify,
    is_healthy_staple,
)

DATA = Path(__file__).parent / "data"


def eval_salling(path: Path) -> None:
    stores = json.load(open(path))
    items: dict[str, tuple[str, str]] = {}
    for s in stores:
        for c in s["clearances"]:
            p = c["product"]
            items[p["ean"]] = (p["description"], (p.get("categories") or {}).get("da", ""))

    staple_total = staple_ok = staple_wrong = staple_missed = 0
    fp, wrong, missed = [], [], []
    attr_checks = attr_ok = 0
    attr_err, attr_unknown = [], []
    unmapped = collections.defaultdict(list)

    for ean, (name, cat) in items.items():
        leaf = _cat_leaf(cat)
        expected = SALLING_CATEGORY_MAP.get(leaf)
        pred = classify(name)
        pred_types = {m.type_id for m in pred}

        if expected:
            staple_total += 1
            if expected in pred_types:
                staple_ok += 1
            elif pred_types:
                staple_wrong += 1
                wrong.append((name, leaf, sorted(pred_types)))
            else:
                staple_missed += 1
                missed.append((name, leaf))
            # Egenskaber som kategorien fastlægger (mælketype, ostens form) skal
            # enten stemme eller være ukendt. Ukendt = ufarligt, forkert = farligt.
            for k, want in SALLING_CATEGORY_ATTRS.get(leaf, {}).items():
                got = next((m.attrs.get(k) for m in pred if m.type_id == expected), None)
                attr_checks += 1
                if got == want:
                    attr_ok += 1
                elif got is None:
                    attr_unknown.append((name, k, want))
                else:
                    attr_err.append((name, f"{k}={want}", got))
        elif leaf in SALLING_NON_STAPLE:
            healthy = [m for m in pred if is_healthy_staple(m)]
            if healthy:
                fp.append((name, leaf, [m.label() for m in healthy]))
        elif pred:
            unmapped[leaf].append((name, [m.label() for m in pred]))

    print(f"Salling madspild: {len(items)} unikke EAN\n")
    print(f"A1. Basisvarer med kendt kategori: {staple_total}")
    print(f"    korrekt type ud fra navn alene: {staple_ok} ({staple_ok/staple_total:.0%})")
    print(f"    forkert type:                   {staple_wrong}")
    print(f"    ikke genkendt:                  {staple_missed}")
    for n, leaf, got in wrong:
        print(f"      FORKERT  {n:42} kategori={leaf:22} gæt={got}")
    for n, leaf in missed:
        print(f"      MANGLER  {n:42} kategori={leaf}")
    print(f"\nA2. Egenskaber (mælketype, ostens form) mod kategori: {attr_checks} tjek")
    print(f"    korrekt: {attr_ok}   ukendt (ufarligt): {len(attr_unknown)}   FORKERT: {len(attr_err)}")
    for n, want, got in attr_err:
        print(f"      FORKERT  {n:42} kategori: {want:18} gæt={got}")
    n_nonstaple = sum(1 for _, c in items.values() if _cat_leaf(c) in SALLING_NON_STAPLE)
    print(f"\nA3. Falsk-positive: ikke-basisvarer (pålæg, pølser, desserter ...) vist som sund basisvare: "
          f"{len(fp)} af {n_nonstaple}")
    for n, leaf, got in fp:
        print(f"      {n:42} kategori={leaf:22} gæt={got}")
    print("\nA4. Kategorier uden facit-mapping (til manuelt gennemsyn):")
    for leaf, rows in sorted(unmapped.items(), key=lambda kv: -len(kv[1])):
        print(f"    {leaf} ({len(rows)})")
        for n, labels in rows[:6]:
            print(f"      {n:42} -> {labels}")


def review_offers(db_path: Path, out: Path) -> None:
    con = sqlite3.connect(db_path)
    rows = con.execute(
        """SELECT DISTINCT source, chain, name, description, unit, unit_price_min, unit_price_max
           FROM price_obs WHERE (source='tjek') OR (source='rema' AND is_campaign=0)"""
    ).fetchall()
    staple_words = re.compile(
        r"hakket|kylling|\bæg\b|mælk|smør|fløde|\bost\b|ost\b|skyr|yoghurt|tomat|bønne|kikært|\btun\b|"
        r"havregryn|linser|fraiche|mozzarella|cheddar|hytteost", re.I)
    by_type = collections.defaultdict(list)
    unmatched = []
    for source, chain, name, desc, unit, umin, umax in rows:
        ms = classify(name, desc or "")
        if ms:
            for m in ms:
                by_type[m.vtype.label].append((chain, name, desc, m, umin, unit))
        elif staple_words.search(f"{name} {desc}"):
            unmatched.append((chain, name, desc))

    lines = ["# Gennemsyn af varegenkendelse\n",
             "Markér fejl ved at rette i `matching.py`. ✅ = sund basisvare, 🚫 = filtreret fra, "
             "❓ = egenskab ukendt (bruges kun som 'lignende').\n"]
    for label in sorted(by_type):
        lines.append(f"\n## {label} ({len(by_type[label])})\n")
        lines.append("| Kæde | Tekst | Genkendt som | kr/enhed |\n|---|---|---|---|")
        for chain, name, desc, m, umin, unit in sorted(by_type[label], key=lambda r: r[4] or 9e9):
            flag = "🚫" if not is_healthy_staple(m) else ("✅" if m.is_exact else "❓")
            txt = f"{name} — {(desc or '')[:50]}".replace("|", "/").replace("\n", " ")
            up = f"{umin:.2f}/{unit}" if umin else "?"
            lines.append(f"| {chain} | {txt} | {flag} {m.label()} | {up} |")
    lines.append(f"\n## Ikke genkendt, men indeholder basisvare-ord ({len(unmatched)})\n")
    for chain, name, desc in sorted(unmatched):
        lines.append(f"- {chain}: {name} — {(desc or '')[:60]}".replace("\n", " "))
    out.write_text("\n".join(lines), encoding="utf-8")

    n = sum(len(v) for v in by_type.values())
    exact = sum(1 for v in by_type.values() for r in v if r[3].is_exact and is_healthy_staple(r[3]))
    print(f"\nB. Tjek + Rema: {n} genkendte varianter, heraf {exact} sunde med alle nøgle-egenskaber kendt.")
    print(f"   {len(unmatched)} tekster med basisvare-ord blev ikke genkendt (se listen).")
    print(f"   Gennemsynsliste: {out}")


if __name__ == "__main__":
    fw = sorted(DATA.glob("salling_food_waste_*.json"))
    if not fw:
        sys.exit("Ingen Salling-data i data/")
    eval_salling(fw[-1])
    review_offers(DATA / "foodcatch.db", DATA / "review.md")
