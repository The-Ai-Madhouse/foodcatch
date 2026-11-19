"""``recompute_deals`` against a real Postgres: small hand-built scenarios.

Listings and classification rows are inserted directly (no matcher involved), so these tests
pin down the deal rules of architecture §6 independently of product recognition.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Connection, insert, select, text, update

from foodcatch.db.tables import (
    classification,
    deal,
    listing,
    matcher_release,
    product,
    product_reference_price,
    store,
)
from foodcatch.deals.compute import recompute_deals
from foodcatch.deals.verdict import DealInput, parse_references, verdict
from foodcatch.ingest import RawPayload
from foodcatch.matching import Match

VERSION = "2026.11.1"
NOW = datetime.now(UTC)
DAY = timedelta(days=1)


# --------------------------------------------------------------------------- matches
def _match(type_id: str, label: str, **attrs: str) -> Match:
    """A meat match with key attributes ``fedt`` (when given) and ``øko``."""
    keys = ("fedt", "øko") if "fedt" in attrs else ("øko",)
    return Match(
        type_id=type_id,
        type_label=label,
        group_name="Kød",
        attrs={"øko": "nej", **attrs},
        key_attrs=keys,
    )


PORK_8_12 = _match("hakket_grisekød", "Hakket grisekød", fedt="8-12%")
PORK_4_7 = _match("hakket_grisekød", "Hakket grisekød", fedt="4-7%")
PORK_UNKNOWN_FAT = _match("hakket_grisekød", "Hakket grisekød", fedt="?")
MØRBRAD = _match("svinemørbrad", "Svinemørbrad")
MØRBRAD_ØKO = _match("svinemørbrad", "Svinemørbrad", øko="ja")
SKANK = _match("svineskank", "Svineskank")
STEGEBEN = _match("stegeben", "Stegeben")


# -------------------------------------------------------------------------- scenario
@dataclass
class Scenario:
    """Builder for listings + classification rows inside the test transaction."""

    conn: Connection
    raw_object_id: UUID

    def listing(
        self,
        *,
        chain: str = "netto",
        source: str = "tjek",
        kind: str = "offer",
        title: str = "Tilbud",
        unit: str | None = "kg",
        unit_price: float | None = None,
        unit_price_max: float | None = None,
        valid_from: datetime = NOW - DAY,
        valid_to: datetime | None = NOW + 5 * DAY,
        source_item_id: str | None = None,
        product_id: UUID | None = None,
        store_id: UUID | None = None,
    ) -> UUID:
        """Insert a listing; ``unit_price_max`` defaults to ``unit_price``."""
        listing_id = uuid4()
        self.conn.execute(
            insert(listing).values(
                id=listing_id,
                source=source,
                source_item_id=source_item_id or uuid4().hex,
                chain_id=chain,
                store_id=store_id,
                kind=kind,
                title=title,
                product_id=product_id,
                price=10 if unit_price is None else unit_price,  # 1 kg packs
                unit=unit,
                unit_price_min=unit_price,
                unit_price_max=unit_price if unit_price_max is None else unit_price_max,
                valid_from=valid_from,
                valid_to=valid_to,
                raw_object_id=self.raw_object_id,
            )
        )
        return listing_id

    def classify(
        self,
        listing_id: UUID,
        *matches: Match,
        healthy: bool = True,
        version: str = VERSION,
        offer_variants: int | None = None,
    ) -> None:
        """Insert one classification row per match (variant 0..n-1)."""
        n = offer_variants or len(matches)
        for index, m in enumerate(matches):
            same = sum(1 for other in matches if other.class_key == m.class_key)
            self.conn.execute(
                insert(classification).values(
                    listing_id=listing_id,
                    matcher_version=version,
                    variant_index=index,
                    type_id=m.type_id,
                    type_label=m.type_label,
                    group_name=m.group_name,
                    attrs=m.attrs,
                    class_key=m.class_key,
                    class_label=m.class_label,
                    is_exact=m.is_exact,
                    is_healthy=healthy,
                    offer_variants=n,
                    same_class_variants=same,
                )
            )

    def offer(self, match: Match, *, chain: str = "netto", **kwargs: Any) -> UUID:
        """A classified single-product offer."""
        listing_id = self.listing(chain=chain, title=match.class_label, **kwargs)
        self.classify(listing_id, match)
        return listing_id

    def ean_product(
        self, *, net_quantity: float | None, net_unit: str | None = "kg", name: str = "Vare"
    ) -> UUID:
        """Insert a product with an EAN and net quantity."""
        product_id = uuid4()
        self.conn.execute(
            insert(product).values(
                id=product_id,
                ean=str(uuid4().int)[:13],
                name=name,
                net_quantity=net_quantity,
                net_unit=net_unit,
            )
        )
        return product_id

    def reference_price(
        self, product_id: UUID, price: float, *, chain: str = "netto", seen: datetime = NOW
    ) -> None:
        """Record an EAN shelf price observation."""
        self.conn.execute(
            insert(product_reference_price).values(
                product_id=product_id,
                chain_id=chain,
                price=price,
                first_seen_at=seen - DAY,
                last_seen_at=seen,
            )
        )

    def clearance(self, match: Match, product_id: UUID) -> UUID:
        """A classified Salling food-waste clearance of ``product_id``."""
        store_id = uuid4()
        self.conn.execute(
            insert(store).values(
                id=store_id, chain_id="netto", source="salling", source_store_id=uuid4().hex
            )
        )
        return self.offer(
            match,
            source="salling_food_waste",
            kind="clearance",
            unit_price=1.0,
            product_id=product_id,
            store_id=store_id,
        )

    def deals(self) -> dict[tuple[UUID, int], dict[str, Any]]:
        rows = self.conn.execute(select(deal)).mappings().all()
        return {(r["listing_id"], r["variant_index"]): dict(r) for r in rows}

    def deal(self, listing_id: UUID, variant_index: int = 0) -> dict[str, Any]:
        return self.deals()[(listing_id, variant_index)]

    def refs(self, listing_id: UUID, variant_index: int = 0) -> list[dict[str, Any]]:
        refs: list[dict[str, Any]] = self.deal(listing_id, variant_index)["references"]
        return refs

    def ref_listings(self, listing_id: UUID, variant_index: int = 0) -> set[tuple[str, UUID]]:
        return {(r["kind"], UUID(r["listing_id"])) for r in self.refs(listing_id, variant_index)}


@pytest.fixture
def sc(db_conn: Connection, raw_payload: Callable[..., RawPayload]) -> Scenario:
    """A scenario builder in the rolled-back test transaction."""
    return Scenario(db_conn, raw_payload("tjek", "offers", []).raw_object_id)


# ------------------------------------------------------------------------ PoC cases
def test_poc_minced_pork_8_12_is_a_good_deal(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    brugsen = sc.offer(PORK_8_12, chain="superbrugsen", unit_price=39.0)
    rema = sc.offer(PORK_8_12, chain="rema1000", source="rema", kind="regular", unit_price=49.9)
    earlier = sc.offer(
        PORK_8_12, unit_price=33.33, valid_from=NOW - 30 * DAY, valid_to=NOW - 24 * DAY
    )
    sc.offer(PORK_4_7, chain="lidl", unit_price=29.0)  # other fat %: another product

    assert recompute_deals(sc.conn) >= 1

    row = sc.deal(netto)
    assert row["class_key"] == PORK_8_12.class_key
    assert row["price_applies"] is True
    assert row["netto_unit_price_worst"] == Decimal("33.33")
    assert sc.ref_listings(netto) == {
        ("offer", brugsen),
        ("regular", rema),
        ("history", earlier),
    }
    result = verdict(
        DealInput(
            netto_unit_price_worst=float(row["netto_unit_price_worst"]),
            netto_unit_price_best=float(row["netto_unit_price_best"]),
            price_applies=row["price_applies"],
            is_exact=True,
            references=parse_references(row["references"]),
        ),
        {"superbrugsen", "rema1000", "lidl"},
    )
    assert (result.verdict, result.cheapest_unit_price, result.reference_count) == (
        "good_deal",
        33.33,
        3,
    )


def test_poc_mørbrad_skank_stegeben_offer_is_not_a_same_class_reference(sc: Scenario) -> None:
    netto = sc.offer(MØRBRAD, unit_price=79.0)
    mixed = sc.listing(chain="lidl", unit_price=35.0, unit_price_max=99.0)
    sc.classify(mixed, MØRBRAD, SKANK, STEGEBEN)

    recompute_deals(sc.conn)

    assert sc.refs(netto) == []


def test_multi_product_competitor_offer_counts_when_spread_is_small(sc: Scenario) -> None:
    netto = sc.offer(MØRBRAD, unit_price=79.0)
    narrow = sc.listing(chain="lidl", unit_price=70.0, unit_price_max=87.5)  # exactly +25 %
    sc.classify(narrow, MØRBRAD, SKANK)

    recompute_deals(sc.conn)

    assert sc.ref_listings(netto) == {("offer", narrow)}
    assert sc.refs(netto)[0]["unit_price"] == 70.0


def test_competitor_offer_with_same_class_variants_applies_despite_spread(sc: Scenario) -> None:
    netto = sc.offer(MØRBRAD, unit_price=79.0)
    homogeneous = sc.listing(chain="meny", unit_price=40.0, unit_price_max=90.0)
    sc.classify(homogeneous, MØRBRAD)  # e.g. "Svinemørbrad, 400-900 g"

    recompute_deals(sc.conn)

    assert sc.ref_listings(netto) == {("offer", homogeneous)}


# ------------------------------------------------------------------- Netto variants
def test_netto_multi_product_offer_price_does_not_apply(sc: Scenario) -> None:
    netto = sc.listing(unit_price=48.0, unit_price_max=76.0)
    sc.classify(netto, MØRBRAD, SKANK)
    lidl = sc.offer(MØRBRAD, chain="lidl", unit_price=47.44)

    recompute_deals(sc.conn)

    for variant in (0, 1):
        row = sc.deal(netto, variant)
        assert row["price_applies"] is False
        assert row["netto_unit_price_worst"] == Decimal("76.0")
        assert row["netto_unit_price_best"] == Decimal("48.0")
    # references are still stored (the web may show them); the verdict is ``ambiguous_offer``
    assert sc.ref_listings(netto, 0) == {("offer", lidl)}
    assert sc.refs(netto, 1) == []


def test_netto_price_range_within_spread_applies(sc: Scenario) -> None:
    netto = sc.listing(unit_price=60.0, unit_price_max=72.0)
    sc.classify(netto, MØRBRAD, SKANK)

    recompute_deals(sc.conn)

    assert sc.deal(netto, 0)["price_applies"] is True


def test_non_exact_netto_variant_stores_no_references(sc: Scenario) -> None:
    netto = sc.offer(PORK_UNKNOWN_FAT, unit_price=40.0)
    sc.offer(PORK_UNKNOWN_FAT, chain="lidl", unit_price=30.0)  # identical but inexact key

    recompute_deals(sc.conn)

    assert sc.refs(netto) == []


def test_unknown_unit_price_still_gets_a_deal_row(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit=None, unit_price=None)

    recompute_deals(sc.conn)

    row = sc.deal(netto)
    assert row["netto_unit_price_worst"] is None
    assert row["price_applies"] is True  # the verdict is ``no_price``
    assert row["references"] == []


def test_unhealthy_variants_regular_prices_and_clearances_get_no_deal(sc: Scenario) -> None:
    unhealthy = sc.listing(unit_price=20.0)
    sc.classify(unhealthy, PORK_8_12, healthy=False)
    lidl = sc.offer(PORK_8_12, chain="lidl", unit_price=30.0)
    lidl_regular = sc.offer(PORK_8_12, chain="lidl", kind="regular", unit_price=31.0)
    rema_regular = sc.offer(
        PORK_8_12, chain="rema1000", source="rema", kind="regular", unit_price=40.0
    )
    clearance = sc.clearance(PORK_8_12, sc.ean_product(net_quantity=1))

    recompute_deals(sc.conn)

    keys = {listing_id for listing_id, _ in sc.deals()}
    assert lidl in keys  # every chain's offers are deals
    assert not keys & {unhealthy, lidl_regular, rema_regular, clearance}


# ----------------------------------------------------------------------- references
def test_different_class_and_unit_mismatch_are_not_references(sc: Scenario) -> None:
    netto = sc.offer(MØRBRAD, unit_price=79.0)
    sc.offer(MØRBRAD_ØKO, chain="lidl", unit_price=60.0)  # organic: another class
    sc.offer(MØRBRAD, chain="meny", unit="stk", unit_price=50.0)  # priced per piece
    sc.offer(MØRBRAD, chain="spar", unit_price=None)  # unit price unknown

    recompute_deals(sc.conn)

    assert sc.refs(netto) == []


MÆLK = Match(
    type_id="mælk",
    type_label="Mælk",
    group_name="Mejeri",
    attrs={"mælketype": "letmælk", "øko": "nej", "laktosefri": "ja"},
    key_attrs=("mælketype", "øko", "laktosefri"),
)
ÆG = Match(
    type_id="æg",
    type_label="Æg",
    group_name="Æg",
    attrs={"produktion": "frilands", "laktosefri": "nej"},
    key_attrs=("produktion", "laktosefri"),
)


def test_per_piece_price_of_a_volume_type_is_not_compared(sc: Scenario) -> None:
    """Regression (finding C2): 0.5 l at 12 kr must not beat 1 l at 14 kr 'per stk'."""
    netto = sc.offer(MÆLK, unit="stk", unit_price=12.0)
    sc.offer(MÆLK, chain="superbrugsen", unit="stk", unit_price=14.0)
    sc.offer(MÆLK, chain="lidl", unit="l", unit_price=10.0)  # another unit: never compared

    recompute_deals(sc.conn)

    row = sc.deal(netto)
    assert row["netto_unit_price_worst"] is None  # verdict ``no_price``
    assert row["references"] == []


def test_eggs_are_compared_per_piece(sc: Scenario) -> None:
    netto = sc.offer(ÆG, unit="stk", unit_price=2.5)
    rema = sc.offer(ÆG, chain="rema1000", unit="stk", unit_price=2.75)

    recompute_deals(sc.conn)

    assert sc.deal(netto)["netto_unit_price_worst"] == Decimal("2.5")
    assert sc.ref_listings(netto) == {("offer", rema)}


def test_expired_competitor_offer_is_ignored_but_upcoming_counts(sc: Scenario) -> None:
    netto = sc.offer(MØRBRAD, unit_price=79.0)
    sc.offer(MØRBRAD, chain="lidl", unit_price=60.0, valid_from=NOW - 9 * DAY, valid_to=NOW - DAY)
    upcoming = sc.offer(
        MØRBRAD, chain="kvickly", unit_price=65.0, valid_from=NOW + DAY, valid_to=NOW + 8 * DAY
    )

    recompute_deals(sc.conn)

    assert sc.ref_listings(netto) == {("offer", upcoming)}


def test_republished_competitor_offer_counts_once_with_latest_price(sc: Scenario) -> None:
    netto = sc.offer(MØRBRAD, unit_price=79.0)
    old = sc.offer(MØRBRAD, chain="lidl", unit_price=60.0, source_item_id="lidl-1")
    sc.conn.execute(update(listing).where(listing.c.id == old).values(last_seen_at=NOW - 2 * DAY))
    new = sc.offer(MØRBRAD, chain="lidl", unit_price=62.0, source_item_id="lidl-1")

    recompute_deals(sc.conn)

    assert sc.ref_listings(netto) == {("offer", new)}


def test_republished_netto_offer_only_latest_version_gets_a_deal(sc: Scenario) -> None:
    """Regression (finding C1): a corrected Netto price must replace the mistaken one."""
    mistaken = sc.offer(PORK_8_12, unit_price=12.5, source_item_id="n-1")
    sc.offer(PORK_8_12, chain="lidl", unit_price=80.0)
    recompute_deals(sc.conn)
    assert (mistaken, 0) in sc.deals()

    sc.conn.execute(update(listing).where(listing.c.id == mistaken).values(last_seen_at=NOW - DAY))
    corrected = sc.offer(PORK_8_12, unit_price=87.5, source_item_id="n-1")

    recompute_deals(sc.conn, listing_ids={corrected})

    assert {k for k in sc.deals() if k[0] in (mistaken, corrected)} == {(corrected, 0)}
    later = sc.offer(PORK_8_12, unit_price=90.0, valid_from=NOW + 6 * DAY, valid_to=NOW + 13 * DAY)
    recompute_deals(sc.conn)
    history = {r["listing_id"] for r in sc.refs(later) if r["kind"] == "history"}
    assert str(mistaken) not in history


def test_rema_regular_price_is_the_current_latest_one(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    rema = {"chain": "rema1000", "source": "rema", "source_item_id": "rema-42"}
    sc.offer(PORK_8_12, kind="regular", unit_price=45.0, valid_from=NOW - 60 * DAY, **rema)
    latest = sc.offer(PORK_8_12, kind="regular", unit_price=49.9, valid_from=NOW - 2 * DAY, **rema)
    sc.offer(  # an expired regular price of another Rema product
        PORK_8_12,
        chain="rema1000",
        source="rema",
        kind="regular",
        unit_price=20.0,
        valid_from=NOW - 60 * DAY,
        valid_to=NOW - 30 * DAY,
    )
    sc.offer(  # an expired Rema campaign price
        PORK_8_12,
        chain="rema1000",
        source="rema",
        kind="offer",
        unit_price=19.0,
        valid_from=NOW - 20 * DAY,
        valid_to=NOW - 13 * DAY,
    )

    recompute_deals(sc.conn)

    assert sc.ref_listings(netto) == {("regular", latest)}


def test_rema_catalogue_campaign_prices_are_offer_references(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    rema = {"chain": "rema1000", "source": "rema", "source_item_id": "rema-42"}
    regular = sc.offer(PORK_8_12, kind="regular", unit_price=49.9, valid_to=None, **rema)
    # an in-store campaign (not in the Tjek leaflet) and the next announced campaign period
    now = sc.offer(PORK_8_12, kind="offer", unit_price=30.0, **rema)
    later = sc.offer(
        PORK_8_12,
        kind="offer",
        unit_price=31.0,
        valid_from=NOW + 6 * DAY,
        valid_to=NOW + 13 * DAY,
        **rema,
    )

    recompute_deals(sc.conn)

    assert sc.ref_listings(netto) == {("regular", regular), ("offer", now), ("offer", later)}
    row = sc.deal(netto)
    result = verdict(
        DealInput(
            netto_unit_price_worst=float(row["netto_unit_price_worst"]),
            netto_unit_price_best=float(row["netto_unit_price_best"]),
            price_applies=row["price_applies"],
            is_exact=True,
            references=parse_references(row["references"]),
        ),
        {"rema1000"},
    )
    assert (result.verdict, result.cheapest_unit_price) == ("cheaper_elsewhere", 30.0)


def test_history_contains_earlier_netto_offers_only(sc: Scenario) -> None:
    current = sc.offer(PORK_8_12, unit_price=33.33, source_item_id="n-now")
    expired = sc.offer(
        PORK_8_12, unit_price=31.0, valid_from=NOW - 30 * DAY, valid_to=NOW - 25 * DAY
    )
    upcoming = sc.offer(  # next week: starts right after the current offer ends
        PORK_8_12,
        unit_price=35.0,
        valid_from=NOW + 5 * DAY + timedelta(seconds=1),
        valid_to=NOW + 12 * DAY,
    )
    # the same Tjek offer re-published with a new price is not its own history
    republished = sc.offer(
        PORK_8_12, unit_price=34.0, source_item_id="n-now", valid_from=NOW - 2 * DAY
    )
    # an earlier multi-product Netto offer whose price does not apply
    mixed = sc.listing(unit_price=20.0, unit_price_max=40.0, valid_from=NOW - 60 * DAY)
    sc.classify(mixed, PORK_8_12, MØRBRAD)

    recompute_deals(sc.conn)

    assert sc.ref_listings(current) == {("history", expired)}
    assert sc.ref_listings(upcoming) >= {("history", expired), ("history", current)}
    assert republished not in {listing_id for listing_id, _ in sc.deals()}  # superseded
    history = sc.refs(current)[0]
    assert history["chain_id"] == "netto"
    assert history["unit_price"] == 31.0


def test_concurrent_netto_offers_are_not_each_others_history(sc: Scenario) -> None:
    """Regression (finding C4): one week's duplicate offers must not make each other good."""
    start, end = NOW - DAY, NOW + 5 * DAY
    plain = sc.offer(PORK_8_12, unit_price=33.3333, valid_from=start, valid_to=end)
    with_alternative = sc.offer(PORK_8_12, unit_price=33.3333, valid_from=start, valid_to=end)
    overlapping = sc.offer(  # started earlier, still running when the others started
        PORK_8_12, unit_price=30.0, valid_from=NOW - 3 * DAY, valid_to=NOW + DAY
    )

    recompute_deals(sc.conn)

    for netto in (plain, with_alternative, overlapping):
        assert sc.refs(netto) == []


def test_ean_reference_uses_latest_shelf_price_per_chain(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    product_id = sc.ean_product(net_quantity=0.5, name="Hakket grisekød 8-12% 500 g")
    sc.reference_price(product_id, 22.0, seen=NOW - 10 * DAY)
    sc.reference_price(product_id, 24.95)
    sc.reference_price(product_id, 27.0, chain="foetex")
    clearance = sc.clearance(PORK_8_12, product_id)

    recompute_deals(sc.conn)

    refs = sc.refs(netto)
    assert [(r["kind"], r["chain_id"], r["unit_price"]) for r in refs] == [
        ("ean_reference", "netto", 49.9),
        ("ean_reference", "foetex", 54.0),
    ]
    assert refs[0]["listing_id"] == str(clearance)
    assert refs[0]["title"] == "Hakket grisekød 8-12% 500 g"
    assert refs[0]["unit"] == "kg"


def test_ean_reference_takes_the_lowest_price_of_one_observation(sc: Scenario) -> None:
    """Regression (finding C10): equal ``last_seen_at`` must not pick an arbitrary price."""
    netto = sc.offer(PORK_8_12, unit_price=80.0)
    product_id = sc.ean_product(net_quantity=0.4)
    sc.reference_price(product_id, 45.0)  # two stores, same run, different shelf prices
    sc.reference_price(product_id, 30.0)
    sc.clearance(PORK_8_12, product_id)

    recompute_deals(sc.conn)

    assert [(r["kind"], r["unit_price"]) for r in sc.refs(netto)] == [("ean_reference", 75.0)]


@pytest.mark.parametrize(
    ("net_quantity", "net_unit", "seen_days_ago"),
    [
        pytest.param(None, "kg", 0, id="unknown size"),
        pytest.param(6, "stk", 0, id="unit mismatch"),
        pytest.param(0.5, "kg", 120, id="stale observation"),
    ],
)
def test_ean_reference_skipped_without_comparable_unit_price(
    sc: Scenario, net_quantity: float | None, net_unit: str, seen_days_ago: int
) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    product_id = sc.ean_product(net_quantity=net_quantity, net_unit=net_unit)
    sc.reference_price(product_id, 24.95, seen=NOW - seen_days_ago * DAY)
    sc.clearance(PORK_8_12, product_id)

    recompute_deals(sc.conn)

    assert sc.refs(netto) == []


def test_references_have_the_contract_shape_and_are_sorted(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    sc.offer(PORK_8_12, chain="meny", unit_price=45.0)
    sc.offer(PORK_8_12, chain="lidl", unit_price=39.0)

    recompute_deals(sc.conn)

    refs = sc.refs(netto)
    assert [r["unit_price"] for r in refs] == [39.0, 45.0]
    assert set(refs[0]) == {
        "kind",
        "chain_id",
        "listing_id",
        "title",
        "unit_price",
        "unit",
        "valid_from",
        "valid_to",
        "member_only",
    }
    assert refs[0]["member_only"] is False
    assert datetime.fromisoformat(refs[0]["valid_from"]) <= NOW
    assert refs[0]["valid_to"].endswith("Z")
    parsed = parse_references(refs)
    assert parsed[0].chain_id == "lidl"


def test_competitor_member_price_is_a_reference_marked_as_such(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=40.0)
    coop = sc.offer(PORK_8_12, chain="superbrugsen", unit_price=35.0)
    sc.conn.execute(update(listing).where(listing.c.id == coop).values(member_only=True))
    sc.offer(PORK_8_12, chain="lidl", unit_price=45.0)

    recompute_deals(sc.conn)

    refs = sc.refs(netto)
    assert [(r["chain_id"], r["member_only"]) for r in refs] == [
        ("superbrugsen", True),
        ("lidl", False),
    ]
    parsed = parse_references(refs)
    assert parsed[0].member_only is True
    result = verdict(
        DealInput(40.0, 40.0, price_applies=True, is_exact=True, references=parsed),
        {"superbrugsen", "lidl"},
    )
    assert (result.verdict, result.cheapest_unit_price) == ("cheaper_elsewhere", 35.0)


# ------------------------------------------------------------------- all chains
def test_offers_of_every_chain_get_references_from_other_chains(sc: Scenario) -> None:
    lidl = sc.offer(PORK_8_12, chain="lidl", unit_price=35.0, source_item_id="lidl-now")
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    same_week_lidl = sc.offer(PORK_8_12, chain="lidl", unit_price=30.0)  # concurrent, own chain
    earlier_lidl = sc.offer(
        PORK_8_12, chain="lidl", unit_price=32.0, valid_from=NOW - 30 * DAY, valid_to=NOW - 24 * DAY
    )
    sc.offer(  # an earlier Netto offer is history for Netto only
        PORK_8_12, unit_price=31.0, valid_from=NOW - 30 * DAY, valid_to=NOW - 24 * DAY
    )
    rema_regular = sc.offer(
        PORK_8_12, chain="rema1000", source="rema", kind="regular", unit_price=49.9
    )

    recompute_deals(sc.conn)

    assert sc.ref_listings(lidl) == {
        ("offer", netto),
        ("history", earlier_lidl),
        ("regular", rema_regular),
    }
    assert {("offer", lidl), ("offer", same_week_lidl)} <= sc.ref_listings(netto)
    assert sc.deal(lidl)["netto_unit_price_worst"] == Decimal("35.0")


def test_lidl_fast_lav_pris_is_a_regular_reference(sc: Scenario) -> None:
    """Lidl's "Fast lav pris" leaflet items (kind ``regular``) are shelf prices."""
    netto = sc.offer(PORK_8_12, unit_price=40.0)
    lidl_offer = sc.offer(PORK_8_12, chain="lidl", unit_price=45.0)
    shelf = sc.offer(
        PORK_8_12, chain="lidl", kind="regular", unit_price=47.44, source_item_id="flp-1"
    )
    sc.conn.execute(update(listing).where(listing.c.id == shelf).values(last_seen_at=NOW - DAY))
    republished = sc.offer(
        PORK_8_12, chain="lidl", kind="regular", unit_price=46.0, source_item_id="flp-1"
    )

    recompute_deals(sc.conn)

    assert sc.ref_listings(netto) == {("offer", lidl_offer), ("regular", republished)}
    # Lidl's own shelf price is a reference for Lidl's offer too, and gets no deal itself
    assert ("regular", republished) in sc.ref_listings(lidl_offer)
    assert republished not in {listing_id for listing_id, _ in sc.deals()}


def test_rema_campaigns_are_deals_once(sc: Scenario) -> None:
    """A catalogue campaign also in Rema's Tjek leaflet is a deal only through the leaflet."""
    rema = {"chain": "rema1000", "source": "rema"}
    leaflet = sc.offer(PORK_8_12, chain="rema1000", unit_price=30.0)  # Tjek, price 30
    in_leaflet = sc.offer(PORK_8_12, kind="offer", unit_price=30.0, source_item_id="r-1", **rema)
    in_store_only = sc.offer(MØRBRAD, kind="offer", unit_price=59.0, source_item_id="r-2", **rema)
    earlier = sc.offer(  # the same product's previous campaign
        MØRBRAD,
        kind="offer",
        unit_price=55.0,
        source_item_id="r-2",
        valid_from=NOW - 30 * DAY,
        valid_to=NOW - 24 * DAY,
        **rema,
    )
    regular = sc.offer(MØRBRAD, kind="regular", unit_price=89.0, source_item_id="r-2", **rema)
    netto = sc.offer(MØRBRAD, unit_price=60.0)

    recompute_deals(sc.conn)

    targets = {listing_id for listing_id, _ in sc.deals()}
    assert {leaflet, in_store_only, netto} <= targets
    assert in_leaflet not in targets
    assert sc.ref_listings(in_store_only) == {
        ("offer", netto),
        ("history", earlier),
        ("regular", regular),
    }
    # the leaflet offer is not its own chain's offer reference
    assert sc.ref_listings(leaflet) == set()


def test_rema_campaign_deal_is_removed_when_the_leaflet_lists_it(sc: Scenario) -> None:
    rema = {"chain": "rema1000", "source": "rema"}
    campaign = sc.offer(PORK_8_12, kind="offer", unit_price=30.0, **rema)
    recompute_deals(sc.conn)
    assert (campaign, 0) in sc.deals()

    leaflet = sc.offer(PORK_8_12, chain="rema1000", unit_price=30.0)
    recompute_deals(sc.conn, listing_ids={leaflet})

    assert set(sc.deals()) == {(leaflet, 0)}


# ------------------------------------------------------------- lifecycle and scope
def test_recompute_is_idempotent_and_updates_changed_rows(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    lidl = sc.offer(PORK_8_12, chain="lidl", unit_price=39.0)

    assert recompute_deals(sc.conn) == 2  # the Netto and the Lidl offer
    assert recompute_deals(sc.conn) == 0

    sc.conn.execute(update(listing).where(listing.c.id == lidl).values(unit_price_min=30))
    assert recompute_deals(sc.conn, listing_ids={lidl}) == 2  # Lidl's own price, Netto's ref
    assert sc.refs(netto)[0]["unit_price"] == 30.0


def test_scoped_recompute_touches_only_affected_classes(sc: Scenario) -> None:
    pork = sc.offer(PORK_8_12, unit_price=33.33)
    mørbrad = sc.offer(MØRBRAD, unit_price=79.0)
    lidl = sc.offer(PORK_8_12, chain="lidl", unit_price=39.0)

    assert recompute_deals(sc.conn, listing_ids={lidl}) == 2
    assert set(sc.deals()) == {(pork, 0), (lidl, 0)}

    assert recompute_deals(sc.conn, listing_ids={mørbrad}) == 1
    assert set(sc.deals()) == {(pork, 0), (lidl, 0), (mørbrad, 0)}
    assert recompute_deals(sc.conn, listing_ids=set()) == 0


def test_reference_moved_to_another_class_is_removed_by_scoped_recompute(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    lidl = sc.offer(PORK_8_12, chain="lidl", unit_price=39.0)
    recompute_deals(sc.conn)
    assert sc.ref_listings(netto) == {("offer", lidl)}

    # the matcher now reads the competitor offer as another fat percentage
    sc.conn.execute(classification.delete().where(classification.c.listing_id == lidl))
    sc.classify(lidl, PORK_4_7)

    assert recompute_deals(sc.conn, listing_ids={lidl}) == 2  # Netto's refs, Lidl's class
    assert sc.refs(netto) == []


def test_expired_references_trigger_a_recompute(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    lidl = sc.offer(PORK_8_12, chain="lidl", unit_price=39.0)
    recompute_deals(sc.conn)
    assert sc.ref_listings(netto) == {("offer", lidl)}

    # time passes: the competitor offer has ended
    sc.conn.execute(
        update(listing)
        .where(listing.c.id == lidl)
        .values(valid_from=NOW - 9 * DAY, valid_to=NOW - DAY)
    )
    sc.conn.execute(
        text(
            """UPDATE deal SET "references" = (
                   SELECT jsonb_agg(jsonb_set(r, '{valid_to}', to_jsonb(now() - interval '1 day')))
                   FROM jsonb_array_elements("references") r)"""
        )
    )

    assert recompute_deals(sc.conn, listing_ids={uuid4()}) == 1
    assert sc.refs(netto) == []


def test_stale_deals_are_deleted(sc: Scenario) -> None:
    ending = sc.offer(PORK_8_12, unit_price=33.33)
    turning_unhealthy = sc.offer(MØRBRAD, unit_price=79.0)
    staying = sc.offer(PORK_4_7, unit_price=45.0)
    recompute_deals(sc.conn)
    assert len(sc.deals()) == 3

    sc.conn.execute(
        update(listing)
        .where(listing.c.id == ending)
        .values(valid_from=NOW - 9 * DAY, valid_to=NOW - DAY)
    )
    sc.conn.execute(
        update(classification)
        .where(classification.c.listing_id == turning_unhealthy)
        .values(is_healthy=False)
    )

    recompute_deals(sc.conn, listing_ids=set())

    assert set(sc.deals()) == {(staying, 0)}


def test_only_the_current_matcher_release_is_used(sc: Scenario) -> None:
    netto = sc.offer(PORK_8_12, unit_price=33.33)
    recompute_deals(sc.conn)

    new_version = "2026.12.1"
    sc.conn.execute(update(matcher_release).values(is_current=False))
    sc.conn.execute(insert(matcher_release).values(version=new_version, is_current=True))
    sc.classify(netto, PORK_4_7, version=new_version)

    assert recompute_deals(sc.conn) == 1
    rows = sc.conn.execute(select(deal.c.matcher_version, deal.c.class_key)).all()
    assert rows == [(new_version, PORK_4_7.class_key)]


def test_without_a_current_release_nothing_is_written(sc: Scenario) -> None:
    sc.offer(PORK_8_12, unit_price=33.33)
    sc.conn.execute(update(matcher_release).values(is_current=False))

    assert recompute_deals(sc.conn) == 0
    assert sc.deals() == {}
