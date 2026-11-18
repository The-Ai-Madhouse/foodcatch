"""Rema ingest against the test database: listings, idempotency and price history."""

from __future__ import annotations

import copy
import dataclasses
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Connection, select, update

from foodcatch.config import Settings
from foodcatch.db.tables import listing
from foodcatch.ingest import IngestResult, RawPayload, get_ingester
from foodcatch.ingest.rema import (
    COPENHAGEN,
    UnsupportedEndpointError,
    close_vanished_products,
    ingest_payload,
)
from foodcatch.sources import SourceSchemaError

type RawPayloadFactory = Callable[..., RawPayload]

FIXTURE = "rema/products_page1.json"
FETCHED_AT = datetime(2026, 11, 18, 3, 0, tzinfo=UTC)


@pytest.fixture
def body(load_fixture: Callable[[str], Any]) -> dict[str, Any]:
    return load_fixture(FIXTURE)


def _ingest(
    conn: Connection,
    raw_payload: RawPayloadFactory,
    body: dict[str, Any],
    settings: Settings,
    *,
    fetched_at: datetime = FETCHED_AT,
) -> IngestResult:
    payload = raw_payload("rema", "products", body, {"per_page": 1000, "page": 1})
    payload = dataclasses.replace(payload, fetched_at=fetched_at)
    return ingest_payload(conn, payload, settings=settings)


def _rows(conn: Connection, item_id: str | None = None) -> list[dict[str, Any]]:
    stmt = select(listing).where(listing.c.source == "rema")
    if item_id is not None:
        stmt = stmt.where(listing.c.source_item_id == item_id)
    rows = conn.execute(stmt.order_by(listing.c.source_item_id, listing.c.valid_from)).mappings()
    return [dict(r) for r in rows]


def _product(body: dict[str, Any], product_id: int) -> dict[str, Any]:
    return next(p for p in body["data"] if p["id"] == product_id)


def _stable(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    volatile = {"last_seen_at", "raw_object_id"}
    return [{k: v for k, v in r.items() if k not in volatile} for r in rows]


def test_ingest_page(
    db_conn: Connection, raw_payload: RawPayloadFactory, body: dict[str, Any], settings: Settings
) -> None:
    result = _ingest(db_conn, raw_payload, body, settings)

    assert result.records == 15
    assert result.counts["rema_listings_inserted"] == 15
    assert len(result.listing_ids) == 15
    rows = _rows(db_conn)
    assert {r["id"] for r in rows} == result.listing_ids
    assert {r["chain_id"] for r in rows} == {"rema1000"}
    assert all(r["store_id"] is None and r["product_id"] is None for r in rows)

    (jam,) = _rows(db_conn, "100004")
    assert jam["kind"] == "regular"
    assert jam["title"] == "JORDBÆRMARMELADE"
    assert jam["description"] == "285 GR. / EASIS"
    assert jam["price"] == Decimal("23.95")
    assert jam["unit"] == "kg"
    assert jam["unit_price_min"] == jam["unit_price_max"] == Decimal("84.0400")
    assert jam["size_min"] == jam["size_max"] == Decimal("0.285")
    assert jam["valid_from"] == datetime(2025, 11, 20, tzinfo=COPENHAGEN)
    assert jam["valid_to"] is None
    assert jam["member_only"] is False
    assert jam["raw_object_id"] is not None

    campaign, regular = _rows(db_conn, "100529")
    assert (campaign["kind"], campaign["price"]) == ("offer", Decimal("20.00"))
    assert (regular["kind"], regular["price"]) == ("regular", Decimal("27.95"))
    assert campaign["valid_to"] == regular["valid_from"]

    beer_campaign = _rows(db_conn, "200101")[0]
    assert beer_campaign["max_per_customer"] == 12
    assert beer_campaign["extra"]["deposit"] == 6.0

    floss = _rows(db_conn, "136810")[0]
    assert (floss["unit"], floss["unit_price_min"], floss["size_min"]) == (None, None, None)

    (tomatoes,) = _rows(db_conn, "306137")
    assert tomatoes["extra"]["is_weight_item"] is True
    assert (tomatoes["unit"], tomatoes["unit_price_min"]) == ("kg", Decimal("30.0000"))


def test_ingest_is_idempotent(
    db_conn: Connection, raw_payload: RawPayloadFactory, body: dict[str, Any], settings: Settings
) -> None:
    _ingest(db_conn, raw_payload, body, settings)
    before = _stable(_rows(db_conn))
    again = _ingest(db_conn, raw_payload, body, settings)

    assert again.records == 15
    assert again.listing_ids == set()
    assert again.counts["rema_listings_inserted"] == 0
    assert again.counts["rema_listings_updated"] == 0
    assert again.counts["rema_listings_closed"] == 0
    assert _stable(_rows(db_conn)) == before


def test_reingest_marks_rows_seen_and_records_provenance(
    db_conn: Connection, raw_payload: RawPayloadFactory, body: dict[str, Any], settings: Settings
) -> None:
    _ingest(db_conn, raw_payload, body, settings)
    db_conn.execute(
        update(listing).values(last_seen_at=datetime(2026, 1, 1, tzinfo=UTC))
    )  # pretend the rows are old
    payload = raw_payload("rema", "products", body)
    ingest_payload(db_conn, payload, settings=settings)

    rows = _rows(db_conn)
    assert all(r["last_seen_at"] > datetime(2026, 1, 1, tzinfo=UTC) for r in rows)
    assert {r["raw_object_id"] for r in rows} == {payload.raw_object_id}


def test_new_price_period_becomes_history(
    db_conn: Connection, raw_payload: RawPayloadFactory, body: dict[str, Any], settings: Settings
) -> None:
    _ingest(db_conn, raw_payload, body, settings)
    (old,) = _rows(db_conn, "100004")

    # Rema replaces the open-ended regular price with a new one
    changed = copy.deepcopy(body)
    (price,) = _product(changed, 100004)["prices"]
    price.update(price=25.95, compare_unit_price=91.05, starting_at="2026-11-22T00:00:00+00:00")
    later = datetime(2026, 11, 22, 3, 0, tzinfo=UTC)
    result = _ingest(db_conn, raw_payload, changed, settings, fetched_at=later)

    assert result.counts["rema_listings_inserted"] == 1
    assert result.counts["rema_listings_closed"] == 1
    previous, current = _rows(db_conn, "100004")
    assert previous["id"] == old["id"]
    assert previous["price"] == Decimal("23.95")
    assert previous["valid_to"] == later  # closed when it disappeared
    assert current["price"] == Decimal("25.95")
    assert current["valid_from"] == datetime(2026, 11, 22, tzinfo=COPENHAGEN)
    assert current["valid_to"] is None
    assert result.listing_ids == {previous["id"], current["id"]}

    # replaying the newer payload changes nothing
    again = _ingest(db_conn, raw_payload, changed, settings, fetched_at=later)
    assert again.listing_ids == set()


def test_withdrawn_future_period_is_closed_at_its_start(
    db_conn: Connection, raw_payload: RawPayloadFactory, body: dict[str, Any], settings: Settings
) -> None:
    _ingest(db_conn, raw_payload, body, settings)
    changed = copy.deepcopy(body)
    beer = _product(changed, 200101)
    beer["prices"] = beer["prices"][:1]  # next week's campaign withdrawn
    _ingest(db_conn, raw_payload, changed, settings)

    _, withdrawn = _rows(db_conn, "200101")
    assert withdrawn["valid_to"] == withdrawn["valid_from"]  # empty period, still history
    # closing is stable: the next run does not report the period again
    assert _ingest(db_conn, raw_payload, changed, settings).listing_ids == set()


def test_changed_content_updates_the_listing(
    db_conn: Connection, raw_payload: RawPayloadFactory, body: dict[str, Any], settings: Settings
) -> None:
    _ingest(db_conn, raw_payload, body, settings)
    changed = copy.deepcopy(body)
    _product(changed, 11240)["underline"] = "20 CL. / REMA 1000 KAKAO"
    result = _ingest(db_conn, raw_payload, changed, settings)

    (cocoa,) = _rows(db_conn, "11240")
    assert result.listing_ids == {cocoa["id"]}
    assert result.counts["rema_listings_updated"] == 1
    assert cocoa["description"] == "20 CL. / REMA 1000 KAKAO"


def test_extra_keys_of_other_modules_survive(
    db_conn: Connection, raw_payload: RawPayloadFactory, body: dict[str, Any], settings: Settings
) -> None:
    _ingest(db_conn, raw_payload, body, settings)
    db_conn.execute(
        update(listing)
        .where(listing.c.source_item_id == "100004")
        .values(extra=listing.c.extra.op("||")({"note": "kept"}))
    )
    assert _ingest(db_conn, raw_payload, body, settings).listing_ids == set()
    (jam,) = _rows(db_conn, "100004")
    assert jam["extra"]["note"] == "kept"
    assert jam["extra"]["compare_unit"] == "kg"


def test_organic_label_hint_is_stored(
    db_conn: Connection, raw_payload: RawPayloadFactory, body: dict[str, Any], settings: Settings
) -> None:
    _ingest(db_conn, raw_payload, body, settings)
    (oat_drink,) = _rows(db_conn, "100325")
    assert oat_drink["description"].endswith("ØKOLOGISK")
    assert "Økologi" in oat_drink["extra"]["labels"]


def test_close_vanished_products(
    db_conn: Connection, raw_payload: RawPayloadFactory, body: dict[str, Any], settings: Settings
) -> None:
    _ingest(db_conn, raw_payload, body, settings)
    at = datetime(2026, 11, 19, 3, 0, tzinfo=UTC)
    seen = {str(p["id"]) for p in body["data"]} - {"100004", "100529"}
    closed = close_vanished_products(db_conn, seen_item_ids=seen, at=at)

    jam = _rows(db_conn, "100004")
    sauce = _rows(db_conn, "100529")
    assert closed == {r["id"] for r in jam + sauce}
    assert jam[0]["valid_to"] == at
    # the future regular period never started: it is closed at its start
    assert sauce[1]["valid_to"] == sauce[1]["valid_from"]
    # the running campaign (until 22 Nov) is cut at `at`
    assert sauce[0]["valid_to"] == at
    assert close_vanished_products(db_conn, seen_item_ids=seen, at=at) == set()


def test_registered_ingester() -> None:
    assert get_ingester("rema") is ingest_payload


def test_unsupported_endpoint(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    payload = raw_payload("rema", "stores", [])
    with pytest.raises(UnsupportedEndpointError):
        ingest_payload(db_conn, payload, settings=settings)


def test_invalid_payload(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    payload = raw_payload("rema", "products", {"data": [{"id": "x"}]})
    with pytest.raises(SourceSchemaError):
        ingest_payload(db_conn, payload, settings=settings)
