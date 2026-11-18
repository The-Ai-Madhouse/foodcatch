"""Tjek ingest against a real Postgres: stores and offer listings, idempotency."""

from __future__ import annotations

import json
from collections.abc import Callable
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Connection, func, select, text

from conftest import RawPayloadFactory
from foodcatch.config import Settings
from foodcatch.db.tables import listing, store
from foodcatch.ingest import get_ingester
from foodcatch.ingest.tjek import ingest_payload
from foodcatch.sources import SourceSchemaError

pytestmark = pytest.mark.db

D = Decimal


def _snapshot(conn: Connection, table: Any) -> list[tuple[Any, ...]]:
    """All rows of ``table`` without the volatile ``last_seen_at``/``raw_object_id`` columns."""
    skip = {"last_seen_at", "raw_object_id"}
    cols = [c for c in table.c if c.name not in skip]
    return [tuple(r) for r in conn.execute(select(*cols).order_by(*cols[:2])).all()]


def test_registered_as_the_tjek_ingester() -> None:
    assert get_ingester("tjek") is ingest_payload


# --------------------------------------------------------------------------- stores


def test_ingest_recorded_stores(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    settings: Settings,
    fixture_bytes: Callable[[str], bytes],
) -> None:
    payload = raw_payload("tjek", "stores", fixture_bytes("tjek/stores_netto.json"))
    result = ingest_payload(db_conn, payload, settings=settings)
    assert result.records == 4
    assert result.counts["stores_upserted"] == 4
    assert not result.listing_ids

    row = db_conn.execute(
        select(store).where(store.c.source == "tjek", store.c.source_store_id == "86d7kOL")
    ).one()
    assert row.chain_id == "netto"
    assert (row.name, row.street, row.zip, row.city) == (
        "Netto Smedelundsgade",
        "Smedelundsgade 19-21",
        "4300",
        "Holbæk",
    )
    assert row.lat == pytest.approx(55.7151231)
    assert row.lon == pytest.approx(11.7161688)


def test_store_upsert_is_idempotent_and_updates_fields(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    base = {
        "id": "abc",
        "dealer_id": "11deC",
        "name": "REMA 1000 Vej",
        "street": "Vej 1",
        "zip_code": "8000",
        "city": "Aarhus C",
        "latitude": 56.15,
        "longitude": 10.2,
        "country": {"id": "DK"},
    }
    ingest_payload(db_conn, raw_payload("tjek", "stores", [base]), settings=settings)
    first = _snapshot(db_conn, store)
    ingest_payload(db_conn, raw_payload("tjek", "stores", [base]), settings=settings)
    assert _snapshot(db_conn, store) == first

    moved = {**base, "street": "Vej 2", "latitude": 56.16}
    ingest_payload(db_conn, raw_payload("tjek", "stores", [moved]), settings=settings)
    row = db_conn.execute(select(store).where(store.c.source_store_id == "abc")).one()
    assert (row.chain_id, row.street, row.lat) == ("rema1000", "Vej 2", 56.16)
    assert db_conn.execute(select(func.count()).select_from(store)).scalar_one() == 1


def test_foreign_and_untracked_stores_are_skipped(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    stores = [
        {"id": "se1", "dealer_id": "9ba51", "country": {"id": "SE"}},
        {"id": "x1", "dealer_id": "unknown", "country": {"id": "DK"}},
        {"id": "dk1", "dealer_id": "9ba51"},  # country missing: kept
    ]
    result = ingest_payload(db_conn, raw_payload("tjek", "stores", stores), settings=settings)
    assert result.records == 1
    assert result.counts["stores_skipped_foreign"] == 1
    assert result.counts["stores_skipped_unknown_dealer"] == 1
    ids = db_conn.execute(select(store.c.source_store_id)).scalars().all()
    assert ids == ["dk1"]


def test_empty_store_page(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    result = ingest_payload(db_conn, raw_payload("tjek", "stores", []), settings=settings)
    assert result.records == 0


# --------------------------------------------------------------------------- offers


def test_ingest_recorded_offers(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    settings: Settings,
    fixture_bytes: Callable[[str], bytes],
) -> None:
    body = fixture_bytes("tjek/offers_netto.json")
    payload = raw_payload("tjek", "offers", body, {"catalog_ids": "40K-WXWp"})
    result = ingest_payload(db_conn, payload, settings=settings)
    n = len(json.loads(body))
    assert result.records == n
    assert result.counts["offers_inserted"] == n
    assert len(result.listing_ids) == n

    rows = {r.source_item_id: r for r in db_conn.execute(select(listing)).all()}
    assert set(rows) == {o["id"] for o in json.loads(body)}
    assert {r.id for r in rows.values()} == result.listing_ids
    salat = rows["s5ehhEDWvGkXUuC86EOXj"]
    assert salat.source == "tjek"
    assert salat.kind == "offer"
    assert salat.chain_id == "netto"
    assert salat.catalog_id == "40K-WXWp"
    assert salat.store_id is None
    assert salat.product_id is None
    assert salat.title == "K-Salat bearnaisesauce"
    assert salat.price == D("9.97")
    assert salat.reference_price == D("21.95")
    assert salat.unit == "kg"
    assert (salat.size_min, salat.size_max) == (D("0.325"), D("0.325"))
    assert (salat.unit_price_min, salat.unit_price_max) == (D("30.6769"), D("30.6769"))
    assert salat.max_per_customer == 6
    assert salat.member_only is False
    assert salat.raw_object_id == payload.raw_object_id
    assert salat.valid_from.isoformat() == "2026-11-13T23:00:00+00:00"
    assert salat.valid_to.isoformat() == "2026-11-20T22:59:59+00:00"


def test_member_offer_is_flagged(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    settings: Settings,
    load_fixture: Callable[[str], Any],
) -> None:
    offers = load_fixture("tjek/offers_superbrugsen.json")
    ingest_payload(db_conn, raw_payload("tjek", "offers", offers), settings=settings)
    oil = db_conn.execute(
        select(listing).where(listing.c.source_item_id == "eTqWIdeNJh0dzGhhY65wb")
    ).one()
    assert oil.chain_id == "superbrugsen"
    assert oil.member_only is False  # the offer price is the non-member price

    member = {**offers[0], "id": "member1", "description": "Pris ikke-medlem 49,95"}
    ingest_payload(db_conn, raw_payload("tjek", "offers", [member]), settings=settings)
    row = db_conn.execute(select(listing).where(listing.c.source_item_id == "member1")).one()
    assert row.member_only is True


def test_offer_ingest_is_idempotent(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    settings: Settings,
    fixture_bytes: Callable[[str], bytes],
) -> None:
    body = fixture_bytes("tjek/offers_netto.json")
    ingest_payload(db_conn, raw_payload("tjek", "offers", body), settings=settings)
    before = _snapshot(db_conn, listing)
    seen_before = db_conn.execute(select(func.max(listing.c.last_seen_at))).scalar_one()

    # a later run sees the same offers again
    db_conn.execute(text("SELECT pg_sleep(0.01)"))
    second = raw_payload("tjek", "offers", body)
    result = ingest_payload(db_conn, second, settings=settings)
    assert result.records == len(before)
    assert not result.listing_ids  # nothing changed -> nothing to reclassify
    assert result.counts["offers_unchanged"] == len(before)
    assert result.counts["offers_inserted"] == result.counts["offers_updated"] == 0
    assert _snapshot(db_conn, listing) == before
    # provenance and freshness point at the latest raw object
    raw_ids = set(db_conn.execute(select(listing.c.raw_object_id)).scalars())
    assert raw_ids == {second.raw_object_id}
    seen_after = db_conn.execute(select(func.min(listing.c.last_seen_at))).scalar_one()
    assert seen_after >= seen_before


def test_changed_offer_is_updated_and_reported(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    settings: Settings,
    load_fixture: Callable[[str], Any],
) -> None:
    offers = load_fixture("tjek/offers_netto.json")
    ingest_payload(db_conn, raw_payload("tjek", "offers", offers), settings=settings)

    changed = {**offers[0], "description": offers[0]["description"] + " Max. 2 stk. pr. kunde"}
    result = ingest_payload(
        db_conn, raw_payload("tjek", "offers", [changed, *offers[1:]]), settings=settings
    )
    assert result.counts["offers_updated"] == 1
    assert result.counts["offers_unchanged"] == len(offers) - 1
    (changed_id,) = result.listing_ids
    row = db_conn.execute(select(listing).where(listing.c.id == changed_id)).one()
    assert row.source_item_id == offers[0]["id"]
    assert row.max_per_customer == 2


def test_new_price_is_a_new_listing(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings, load_fixture: Any
) -> None:
    offer = load_fixture("tjek/offers_netto.json")[0]
    ingest_payload(db_conn, raw_payload("tjek", "offers", [offer]), settings=settings)
    cheaper = {**offer, "pricing": {**offer["pricing"], "price": 18}}
    result = ingest_payload(db_conn, raw_payload("tjek", "offers", [cheaper]), settings=settings)
    assert result.counts["offers_inserted"] == 1
    prices = db_conn.execute(
        select(listing.c.price).where(listing.c.source_item_id == offer["id"]).order_by("price")
    ).scalars()
    assert list(prices) == [D("18.00"), D("20.00")]


def test_duplicate_offers_in_one_page_are_merged(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings, load_fixture: Any
) -> None:
    offer = load_fixture("tjek/offers_netto.json")[0]
    result = ingest_payload(
        db_conn, raw_payload("tjek", "offers", [offer, offer]), settings=settings
    )
    assert result.records == 2
    assert result.counts["offers_inserted"] == 1


def test_offers_of_untracked_dealers_are_skipped(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings, load_fixture: Any
) -> None:
    offer = {**load_fixture("tjek/offers_netto.json")[0], "dealer_id": "nope"}
    result = ingest_payload(db_conn, raw_payload("tjek", "offers", [offer]), settings=settings)
    assert result.records == 1
    assert result.counts["offers_skipped_unknown_dealer"] == 1
    assert db_conn.execute(select(func.count()).select_from(listing)).scalar_one() == 0


# --------------------------------------------------------------------------- other endpoints


def test_catalogs_and_dealers_store_nothing(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    settings: Settings,
    fixture_bytes: Callable[[str], bytes],
) -> None:
    catalogs = raw_payload("tjek", "catalogs", fixture_bytes("tjek/catalogs_netto.json"))
    result = ingest_payload(db_conn, catalogs, settings=settings)
    assert result.records == 0
    assert result.counts["catalogs"] == 3
    dealers = raw_payload("tjek", "dealers", fixture_bytes("tjek/dealers.json"))
    assert ingest_payload(db_conn, dealers, settings=settings).records == 0
    assert db_conn.execute(select(func.count()).select_from(listing)).scalar_one() == 0


def test_invalid_payload_is_a_schema_error(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    payload = raw_payload("tjek", "offers", [{"id": "o1"}])
    with pytest.raises(SourceSchemaError, match="tjek/offers"):
        ingest_payload(db_conn, payload, settings=settings)


def test_unknown_endpoint(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    with pytest.raises(ValueError, match="unknown endpoint"):
        ingest_payload(db_conn, raw_payload("tjek", "bogus", []), settings=settings)
