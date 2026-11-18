"""Salling ingest: stores, products, reference prices and food-waste listings (real Postgres)."""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Connection, func, select, update

from foodcatch.config import Settings
from foodcatch.db.tables import (
    fetch_run,
    listing,
    product,
    product_reference_price,
    raw_object,
    store,
)
from foodcatch.ingest import IngestResult, RawPayload, get_ingester
from foodcatch.ingest.salling import (
    LISTING_SOURCE,
    NetSize,
    UnknownEndpointError,
    ingest_payload,
    is_gtin,
    parse_net_size,
)
from foodcatch.sources import SourceSchemaError

type RawPayloadFactory = Callable[..., RawPayload]
type Fixture = Callable[[str], Any]

HVIDOVRE = "7fd81b2b-219b-4795-a561-c1a9d3fb28d1"
OESTERBRO = "e1ed4932-4bef-4220-ac59-211b3b561e57"
BILKA_TILST = "efba0457-090e-4132-81ba-c72b4c8e7fee"
A38_EAN = "5760466870306"
KALKUN_EAN = "4005097700259"
T0 = datetime(2026, 11, 1, 6, 0, tzinfo=UTC)


# --------------------------------------------------------------------------- pure helpers


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("A38 ØKO 1KG ARLA CULTURA", NetSize("kg", Decimal(1))),
        ("HYTTEOST 0,4% 450G DAIRY GOOOD", NetSize("kg", Decimal("0.45"))),
        ("GULD SKIVEOST 3X140G MAMMEN", NetSize("kg", Decimal("0.42"))),
        ("SKYR 4X100 G", NetSize("kg", Decimal("0.4"))),
        ("LETMÆLK 1L ARLA", NetSize("l", Decimal(1))),
        ("SØDMÆLK 1,5 LTR", NetSize("l", Decimal("1.5"))),
        ("JUICE 33CL", NetSize("l", Decimal("0.33"))),
        ("ÆG 10 STK", NetSize("stk", Decimal(10))),
        ("HAKKET OKSEKØD 8-12% 500G", NetSize("kg", Decimal("0.5"))),
    ],
)
def test_parse_net_size(name: str, expected: NetSize) -> None:
    size = parse_net_size(name)
    assert size == expected
    assert size is not None
    assert "E" not in str(size.quantity)


@pytest.mark.parametrize(
    "name",
    [
        "ARLA SØDMÆLK ARLA",  # no size
        "PISKEFLØDE 36% ARLA",  # percentage only
        "A38 ØKO",  # product code, not a size
        "GRILLBAKKE 3 SLAGTERMEST.",  # count without unit
        "OST 1KG 2KG",  # two different sizes: ambiguous
        "SALAT 0G",  # zero
        "BLANDING 500GRAM",  # unit glued to a word
    ],
)
def test_parse_net_size_none(name: str) -> None:
    assert parse_net_size(name) is None


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("5760466870306", True),
        ("4005097700259", True),
        ("96385074", True),  # GTIN-8
        ("5760466870307", False),  # bad check digit
        ("250913", False),  # short in-store code
        ("2005256000004", False),  # restricted circulation (variable weight)
        ("0212345678903", False),  # restricted circulation 02x
        ("", False),
        ("57604668703O6", False),
    ],
)
def test_is_gtin(code: str, expected: bool) -> None:
    assert is_gtin(code) is expected


# --------------------------------------------------------------------------- helpers


def _ingest(
    conn: Connection,
    raw_payload: RawPayloadFactory,
    endpoint: str,
    body: Any,
    settings: Settings,
    *,
    at: datetime | None = None,
) -> IngestResult:
    """Ingest ``body`` as a raw object of a run that started at ``at``."""
    params = {"store_id": body["store"]["id"]} if endpoint == "food-waste" else {}
    payload = raw_payload("salling", endpoint, body, params)
    if at is not None:
        run_id = select(raw_object.c.fetch_run_id).where(raw_object.c.id == payload.raw_object_id)
        conn.execute(
            update(fetch_run)
            .where(fetch_run.c.id == run_id.scalar_subquery())
            .values(started_at=at)
        )
    return ingest_payload(conn, payload, settings=settings)


def _count(conn: Connection, table: Any, *where: Any) -> int:
    return conn.execute(select(func.count()).select_from(table).where(*where)).scalar_one()


def _listings(conn: Connection) -> dict[str, dict[str, Any]]:
    rows = conn.execute(select(listing).where(listing.c.source == LISTING_SOURCE)).mappings()
    return {row["title"]: dict(row) for row in rows}


def _prices(conn: Connection, ean: str) -> list[tuple[str, Decimal, datetime, datetime, int]]:
    rows = conn.execute(
        select(
            product_reference_price.c.chain_id,
            product_reference_price.c.price,
            product_reference_price.c.first_seen_at,
            product_reference_price.c.last_seen_at,
            product_reference_price.c.observations,
        )
        .join(product, product.c.id == product_reference_price.c.product_id)
        .where(product.c.ean == ean)
        .order_by(product_reference_price.c.first_seen_at, product_reference_price.c.price)
    ).all()
    return [tuple(r) for r in rows]  # pyright: ignore[reportReturnType]


def _with_price(body: dict[str, Any], ean: str, **offer: Any) -> dict[str, Any]:
    changed = copy.deepcopy(body)
    for clearance in changed["clearances"]:
        if clearance["product"]["ean"] == ean:
            clearance["offer"].update(offer)
    return changed


# --------------------------------------------------------------------------- stores


def test_ingest_store_page(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/stores_netto_page1.json")
    result = _ingest(db_conn, raw_payload, "stores", body, settings)

    assert result.records == 3
    assert result.listing_ids == set()
    row = db_conn.execute(select(store).where(store.c.source_store_id == HVIDOVRE)).mappings().one()
    assert row["source"] == "salling"
    assert row["chain_id"] == "netto"
    assert row["name"] == "Netto Laurits Olsens Vej"
    assert (row["street"], row["zip"], row["city"]) == ("Laurits Olsens Vej 1", "2650", "Hvidovre")
    assert row["lat"] == pytest.approx(55.663435)  # coordinates are [lon, lat]
    assert row["lon"] == pytest.approx(12.4762406)


def test_ingest_store_page_is_idempotent(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/stores_bilka_page1.json")
    _ingest(db_conn, raw_payload, "stores", body, settings)
    first = db_conn.execute(select(store)).mappings().all()
    _ingest(db_conn, raw_payload, "stores", body, settings)
    second = db_conn.execute(select(store)).mappings().all()

    assert len(second) == 1
    assert second[0]["chain_id"] == "bilka"
    assert {k: v for k, v in first[0].items() if k != "last_seen_at"} == {
        k: v for k, v in second[0].items() if k != "last_seen_at"
    }


def test_ingest_store_page_skips_foreign_and_unknown_brands(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    body = [
        {"id": "de-1", "name": "Netto Berlin", "brand": "netto", "address": {"country": "DE"}},
        {"id": "x-1", "name": "Salling", "brand": "salling", "address": {"country": "DK"}},
        {"id": "dk-1", "name": "føtex Aarhus", "brand": "foetex", "coordinates": [10.2, 56.15]},
    ]
    result = _ingest(db_conn, raw_payload, "stores", body, settings)

    assert result.records == 1
    assert result.counts["stores_skipped_country"] == 1
    assert result.counts["stores_skipped_brand"] == 1
    assert db_conn.execute(select(store.c.source_store_id, store.c.chain_id)).all() == [
        ("dk-1", "foetex")
    ]


# --------------------------------------------------------------------------- food waste


def test_ingest_food_waste_in_region(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_netto_hvidovre.json")
    result = _ingest(db_conn, raw_payload, "food-waste", body, settings)

    assert result.records == 6
    assert result.counts["clearances_in_region"] == 6
    assert len(result.listing_ids) == 6
    assert _count(db_conn, store, store.c.source_store_id == HVIDOVRE) == 1
    assert _count(db_conn, product) == 6

    a38_product = db_conn.execute(select(product).where(product.c.ean == A38_EAN)).mappings().one()
    assert a38_product["name"] == "A38 ØKO 1KG ARLA CULTURA"
    assert a38_product["source_category"] == (
        "Mejeri & køl>Mejeri>Yoghurt & syrnede mælkeprodukter>A38, tykmælk & ymer"
    )

    listings = _listings(db_conn)
    assert set(result.listing_ids) == {row["id"] for row in listings.values()}
    a38 = listings["A38 ØKO 1KG ARLA CULTURA"]
    assert a38["kind"] == "clearance"
    assert a38["chain_id"] == "netto"
    assert a38["product_id"] == a38_product["id"]
    assert a38["source_item_id"] == f"{HVIDOVRE}:5712580607528"
    assert a38["price"] == Decimal("13.00")
    assert a38["reference_price"] == Decimal("20.25")
    assert (a38["unit"], a38["size_min"], a38["size_max"]) == ("kg", Decimal(1), Decimal(1))
    assert a38["unit_price_min"] == a38["unit_price_max"] == Decimal("13.0000")
    assert a38["valid_from"] < a38["valid_to"]
    assert a38["raw_object_id"] is not None
    assert a38["extra"] == {
        "stock": 2,
        "stock_unit": "each",
        "percent_discount": 35.8,
        "offer_ean": "5712580607528",
        "product_code": A38_EAN,
        "image": a38["extra"]["image"],
        "category": a38_product["source_category"],
    }
    assert a38["extra"]["image"].startswith("https://")

    skiveost = listings["GULD SKIVEOST 3X140G MAMMEN"]
    assert (skiveost["unit"], skiveost["size_min"]) == ("kg", Decimal("0.42"))
    assert skiveost["unit_price_min"] == Decimal("76.1905")

    milk = listings["ARLA SØDMÆLK ARLA"]
    assert milk["unit"] is None
    assert milk["size_min"] is None
    assert milk["unit_price_min"] is None

    mozzarella = db_conn.execute(
        select(product.c.source_category).where(product.c.ean == "5703855102770")
    ).scalar_one()
    assert mozzarella is None  # "categories": {}


def test_ingest_food_waste_is_idempotent(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_netto_hvidovre.json")
    _ingest(db_conn, raw_payload, "food-waste", body, settings, at=T0)
    before = {
        t: {k: v for k, v in r.items() if k != "raw_object_id"}
        for t, r in _listings(db_conn).items()
    }
    again = _ingest(db_conn, raw_payload, "food-waste", body, settings, at=T0)

    assert again.listing_ids == set()
    assert again.counts["listings_unchanged"] == 6
    assert again.counts["reference_prices_new"] == 0
    after = {
        t: {k: v for k, v in r.items() if k != "raw_object_id"}
        for t, r in _listings(db_conn).items()
    }
    assert after == before
    assert _count(db_conn, product) == 6
    assert _count(db_conn, product_reference_price) == 6
    assert _prices(db_conn, A38_EAN) == [("netto", Decimal("20.25"), T0, T0, 1)]


def test_ingest_food_waste_stock_change_is_not_a_listing_change(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_netto_hvidovre.json")
    _ingest(db_conn, raw_payload, "food-waste", body, settings)
    result = _ingest(
        db_conn, raw_payload, "food-waste", _with_price(body, A38_EAN, stock=1), settings
    )

    assert result.listing_ids == set()
    assert _listings(db_conn)["A38 ØKO 1KG ARLA CULTURA"]["extra"]["stock"] == 1


def test_ingest_food_waste_new_price_starts_new_listing(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_netto_hvidovre.json")
    _ingest(db_conn, raw_payload, "food-waste", body, settings)
    result = _ingest(
        db_conn, raw_payload, "food-waste", _with_price(body, A38_EAN, newPrice=10), settings
    )

    assert len(result.listing_ids) == 1
    assert result.counts["listings_new"] == 1
    prices = db_conn.execute(
        select(listing.c.price)
        .where(listing.c.source_item_id == f"{HVIDOVRE}:5712580607528")
        .order_by(listing.c.price)
    ).scalars()
    assert list(prices) == [Decimal("10.00"), Decimal("13.00")]


def test_ingest_food_waste_outside_region(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_bilka_tilst.json")  # Aarhus, default region is CPH
    result = _ingest(db_conn, raw_payload, "food-waste", body, settings)

    assert result.records == 5
    assert result.counts["clearances_outside_region"] == 5
    assert result.listing_ids == set()
    assert _count(db_conn, listing) == 0
    assert _count(db_conn, store, store.c.source_store_id == BILKA_TILST) == 1
    # products and reference prices are kept for all of Denmark - but only for real GTINs and
    # fixed-size packages (variable-weight in-store codes are neither products nor shelf prices)
    assert set(db_conn.execute(select(product.c.ean)).scalars()) == {
        "5701205009847",
        "5710405599164",
        "5705900033336",
    }
    assert _count(db_conn, product_reference_price) == 3
    assert _prices(db_conn, "5705900033336")[0][:2] == ("bilka", Decimal("49.95"))


def test_ingest_food_waste_wider_region_and_variable_weight(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    load_fixture: Fixture,
    settings: Settings,
) -> None:
    aarhus = settings.model_copy(update={"region_centers": [(56.1572, 10.2107)]})
    body = load_fixture("salling/food_waste_bilka_tilst.json")
    result = _ingest(db_conn, raw_payload, "food-waste", body, aarhus)

    assert len(result.listing_ids) == 5
    listings = _listings(db_conn)
    grill = listings["GRILLBAKKE 3 SLAGTERMEST."]
    assert grill["chain_id"] == "bilka"
    assert grill["product_id"] is None
    assert grill["price"] == Decimal("48.95")
    assert grill["extra"]["stock_unit"] == "kg"
    assert grill["extra"]["product_code"] == "250913"
    assert grill["extra"]["stock"] == pytest.approx(0.049764)
    assert listings["TILST SPEGEPØLSE"]["extra"]["category"] is None
    assert listings["PULLED CHICKEN 450G JENSENS"]["unit_price_min"] == Decimal("27.7556")


def test_region_radius(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_netto_oesterbro.json")
    # Østerbro is ~4.5 km from the default centre (Copenhagen City Hall)
    narrow = settings.model_copy(update={"region_radius_km": 3.0})
    assert _ingest(db_conn, raw_payload, "food-waste", body, narrow).listing_ids == set()
    wide = settings.model_copy(update={"region_radius_km": 6.0})
    assert len(_ingest(db_conn, raw_payload, "food-waste", body, wide).listing_ids) == 4


def test_food_waste_store_without_coordinates_is_outside_region(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_netto_hvidovre.json")
    del body["store"]["coordinates"]
    result = _ingest(db_conn, raw_payload, "food-waste", body, settings)
    assert result.records == 6
    assert result.listing_ids == set()
    assert _count(db_conn, product_reference_price) == 6


# --------------------------------------------------------------------------- reference prices


def test_reference_price_change_detection(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_bilka_tilst.json")
    ean = "5705900033336"
    t1, t2, t3, t4 = (T0 + timedelta(hours=8 * i) for i in range(4))

    _ingest(db_conn, raw_payload, "food-waste", body, settings, at=t1)
    assert _prices(db_conn, ean) == [("bilka", Decimal("49.95"), t1, t1, 1)]

    # same price in a later run: extend the row
    result = _ingest(db_conn, raw_payload, "food-waste", body, settings, at=t2)
    assert result.counts["reference_prices_extended"] == 3
    assert _prices(db_conn, ean) == [("bilka", Decimal("49.95"), t1, t2, 2)]

    # changed price: a new row
    raised = _with_price(body, ean, originalPrice=54.95)
    result = _ingest(db_conn, raw_payload, "food-waste", raised, settings, at=t3)
    assert result.counts["reference_prices_new"] == 1
    assert _prices(db_conn, ean) == [
        ("bilka", Decimal("49.95"), t1, t2, 2),
        ("bilka", Decimal("54.95"), t3, t3, 1),
    ]

    # replaying an already ingested payload changes nothing
    _ingest(db_conn, raw_payload, "food-waste", raised, settings, at=t3)
    _ingest(db_conn, raw_payload, "food-waste", body, settings, at=t1)
    assert len(_prices(db_conn, ean)) == 2

    # back to the old price: that is a change again, so a new row
    _ingest(db_conn, raw_payload, "food-waste", body, settings, at=t4)
    assert _prices(db_conn, ean)[-1] == ("bilka", Decimal("49.95"), t4, t4, 1)
    assert len(_prices(db_conn, ean)) == 3


def test_reference_price_is_per_chain_and_counted_once_per_run(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    hvidovre = load_fixture("salling/food_waste_netto_hvidovre.json")
    oesterbro = load_fixture("salling/food_waste_netto_oesterbro.json")
    t1, t2 = T0, T0 + timedelta(hours=12)

    # both Netto stores report KALKUNBRYST at 16.00 in the same run: one observation
    for body in (hvidovre, oesterbro):
        _ingest(db_conn, raw_payload, "food-waste", body, settings, at=t1)
    assert _prices(db_conn, KALKUN_EAN) == [("netto", Decimal("16.00"), t1, t1, 1)]

    # next run: one store reports a different price - a second current row, then both extend
    for body in (hvidovre, _with_price(oesterbro, KALKUN_EAN, originalPrice=17)):
        _ingest(db_conn, raw_payload, "food-waste", body, settings, at=t2)
    assert _prices(db_conn, KALKUN_EAN) == [
        ("netto", Decimal("16.00"), t1, t2, 2),
        ("netto", Decimal("17.00"), t2, t2, 1),
    ]


# --------------------------------------------------------------------------- dispatch


def test_ingest_payload_is_the_registered_ingester() -> None:
    assert get_ingester("salling") is ingest_payload


def test_ingest_unknown_endpoint(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    payload = raw_payload("salling", "leaflet-offers", [])
    with pytest.raises(UnknownEndpointError):
        ingest_payload(db_conn, payload, settings=settings)


def test_ingest_schema_mismatch(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    payload = raw_payload("salling", "food-waste", json.dumps({"clearances": []}).encode())
    with pytest.raises(SourceSchemaError):
        ingest_payload(db_conn, payload, settings=settings)


def test_listing_ids_are_uuids(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_netto_oesterbro.json")
    result = _ingest(db_conn, raw_payload, "food-waste", body, settings)
    assert all(isinstance(i, UUID) for i in result.listing_ids)


# --------------------------------------------------------------------------- geo responses


def _geo_body(load_fixture: Fixture) -> list[Any]:
    """A geo response built from the per-store fixtures (same objects, as a list)."""
    return [
        load_fixture(f"salling/{name}.json")
        for name in (
            "food_waste_netto_oesterbro",
            "food_waste_netto_hvidovre",
            "food_waste_bilka_tilst",
        )
    ]


def test_ingest_food_waste_geo_ingests_each_store_like_a_store_response(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    geo = _ingest(db_conn, raw_payload, "food-waste-geo", _geo_body(load_fixture), settings, at=T0)

    assert geo.records == 4 + 6 + 5
    assert geo.counts["clearances_in_region"] == 10
    assert geo.counts["clearances_outside_region"] == 5
    assert len(geo.listing_ids) == 10
    assert _count(db_conn, store) == 3
    assert _count(db_conn, product) == 6 + 2 + 3
    assert _count(db_conn, product_reference_price) == 11
    geo_listings = _listings(db_conn)

    # The same stores ingested one by one at the same time change nothing: same rows, same keys.
    for body in _geo_body(load_fixture):
        single = _ingest(db_conn, raw_payload, "food-waste", body, settings, at=T0)
        assert single.listing_ids == set()
        assert single.counts.get("listings_new", 0) == 0
        assert single.counts.get("reference_prices_new", 0) == 0
    per_store = _listings(db_conn)
    assert per_store.keys() == geo_listings.keys()
    for title, row in per_store.items():
        assert {k: v for k, v in row.items() if k not in {"raw_object_id", "last_seen_at"}} == {
            k: v
            for k, v in geo_listings[title].items()
            if k not in {"raw_object_id", "last_seen_at"}
        }


def test_ingest_food_waste_geo_is_idempotent(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = _geo_body(load_fixture)
    _ingest(db_conn, raw_payload, "food-waste-geo", body, settings, at=T0)
    again = _ingest(db_conn, raw_payload, "food-waste-geo", body, settings, at=T0)

    assert again.listing_ids == set()
    assert again.counts["listings_unchanged"] == 10
    assert again.counts.get("reference_prices_new", 0) == 0
    assert _count(db_conn, listing, listing.c.source == LISTING_SOURCE) == 10
    assert _prices(db_conn, A38_EAN) == [("netto", Decimal("20.25"), T0, T0, 1)]


def test_ingest_recorded_geo_response(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    body = load_fixture("salling/food_waste_geo_copenhagen.json")
    result = _ingest(db_conn, raw_payload, "food-waste-geo", body, settings)

    assert result.counts["stores"] == 3  # incl. the store without clearances
    assert result.records == 4
    assert result.counts["clearances_in_region"] == 4
    assert len(result.listing_ids) == 4
    chains = dict(db_conn.execute(select(store.c.name, store.c.chain_id)).all())
    assert chains == {
        "Netto Rådhuspladsen": "netto",
        "føtex City Industriens Hus": "foetex",
        "Netto Nørrevold Kbh": "netto",
    }
    assert {row["chain_id"] for row in _listings(db_conn).values()} == {"netto", "foetex"}


def test_ingest_food_waste_geo_ingests_a_repeated_store_once(
    db_conn: Connection, raw_payload: RawPayloadFactory, load_fixture: Fixture, settings: Settings
) -> None:
    hvidovre = load_fixture("salling/food_waste_netto_hvidovre.json")
    result = _ingest(db_conn, raw_payload, "food-waste-geo", [hvidovre, hvidovre], settings)

    assert result.records == 6
    assert result.counts["stores_duplicated"] == 1
    assert result.counts["listings_new"] == 6


def test_ingest_food_waste_geo_empty_and_schema_mismatch(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    empty = _ingest(db_conn, raw_payload, "food-waste-geo", [], settings)
    assert empty.records == 0
    assert empty.listing_ids == set()

    payload = raw_payload("salling", "food-waste-geo", {"store": {}, "clearances": []})
    with pytest.raises(SourceSchemaError):
        ingest_payload(db_conn, payload, settings=settings)
