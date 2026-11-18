"""Open Food Facts ingest: product enrichment and the selection of EANs to look up."""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Connection, insert, select

from foodcatch.config import Settings
from foodcatch.db.tables import product
from foodcatch.ingest import IngestResult, RawPayload, get_ingester
from foodcatch.ingest.openfoodfacts import (
    MissingEanError,
    UnsupportedEndpointError,
    eans_due_for_enrichment,
    extract,
    ingest_payload,
    net_quantity,
    normalize_quantity,
)
from foodcatch.sources import SourceSchemaError
from foodcatch.sources.openfoodfacts import OffProduct

type RawPayloadFactory = Callable[..., RawPayload]

FOUND_EAN = "3017620422003"
MISSING_EAN = "5712345678908"
CHECKED_AT = datetime(2026, 11, 18, 6, 7, tzinfo=UTC)


# --------------------------------------------------------------------------- pure helpers


@pytest.mark.parametrize(
    ("amount", "unit", "expected"),
    [
        (Decimal(400), "g", (Decimal("0.4"), "kg")),
        (Decimal(1), "KG", (Decimal(1), "kg")),
        (Decimal(500), "ml", (Decimal("0.5"), "l")),
        (Decimal(33), "cl", (Decimal("0.33"), "l")),
        (Decimal("1.5"), "l", (Decimal("1.5"), "l")),
        (Decimal(10), "pcs", (Decimal(10), "stk")),
        (Decimal(0), "g", None),
        (Decimal(1), "oz", None),
    ],
)
def test_normalize_quantity(
    amount: Decimal, unit: str, expected: tuple[Decimal, str] | None
) -> None:
    assert normalize_quantity(amount, unit) == expected


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        ({"product_quantity": 400, "product_quantity_unit": "g"}, (Decimal("0.4"), "kg")),
        ({"quantity": "1,5 l"}, (Decimal("1.5"), "l")),
        ({"quantity": "500g"}, (Decimal("0.5"), "kg")),
        ({"quantity": "6 x 33 cl"}, None),  # multipack: not guessed
        ({"quantity": "a jar"}, None),
        ({}, None),
    ],
)
def test_net_quantity(fields: dict[str, Any], expected: tuple[Decimal, str] | None) -> None:
    assert net_quantity(OffProduct.model_validate(fields)) == expected


def test_extract_normalizes_grades_and_brand() -> None:
    found = extract(
        OffProduct.model_validate(
            {"brands": "Arla, Arla Foods", "nova_group": 7, "nutriscore_grade": "B"}
        )
    )
    assert found.brand == "Arla"
    assert found.nova_group is None  # out of range
    assert found.nutriscore_grade == "b"
    assert extract(OffProduct.model_validate({"nutriscore_grade": "not-applicable"})) == (
        dataclasses.replace(found, brand=None, nutriscore_grade=None)
    )


# --------------------------------------------------------------------------- database


def _add_product(conn: Connection, ean: str, **values: Any) -> None:
    conn.execute(insert(product).values(ean=ean, **values))


def _product(conn: Connection, ean: str) -> dict[str, Any]:
    return dict(conn.execute(select(product).where(product.c.ean == ean)).mappings().one())


def _ingest(
    conn: Connection,
    raw_payload: RawPayloadFactory,
    body: bytes,
    ean: str,
    settings: Settings,
    *,
    at: datetime = CHECKED_AT,
) -> IngestResult:
    payload = raw_payload("openfoodfacts", "product", body, {"ean": ean, "fields": "x"})
    return ingest_payload(conn, dataclasses.replace(payload, fetched_at=at), settings=settings)


def test_found_enriches_the_product(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    fixture_bytes: Callable[[str], bytes],
    settings: Settings,
) -> None:
    _add_product(db_conn, FOUND_EAN, name="NUTELLA 400G")
    result = _ingest(
        db_conn, raw_payload, fixture_bytes("openfoodfacts/product_found.json"), FOUND_EAN, settings
    )

    assert result.records == 1
    assert result.counts["off_found"] == 1
    assert result.listing_ids == set()
    row = _product(db_conn, FOUND_EAN)
    assert row["name"] == "NUTELLA 400G"  # Salling's name wins
    assert row["brand"] == "Ferrero"  # empty, so filled from Open Food Facts
    assert row["quantity_text"] == "400 g e"
    assert (row["net_quantity"], row["net_unit"]) == (Decimal("0.4"), "kg")
    assert row["nova_group"] == 3
    assert row["nutriscore_grade"] == "e"
    assert row["off_checked_at"] == CHECKED_AT


def test_found_is_idempotent(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    fixture_bytes: Callable[[str], bytes],
    settings: Settings,
) -> None:
    _add_product(db_conn, FOUND_EAN)
    body = fixture_bytes("openfoodfacts/product_found.json")
    _ingest(db_conn, raw_payload, body, FOUND_EAN, settings)
    first = _product(db_conn, FOUND_EAN)
    _ingest(db_conn, raw_payload, body, FOUND_EAN, settings)
    assert _product(db_conn, FOUND_EAN) == first
    assert first["name"] == "Nutella"


def test_not_found_only_marks_the_product_checked(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    fixture_bytes: Callable[[str], bytes],
    settings: Settings,
) -> None:
    _add_product(db_conn, MISSING_EAN, nova_group=1, quantity_text="1 l")
    result = _ingest(
        db_conn,
        raw_payload,
        fixture_bytes("openfoodfacts/product_not_found.json"),
        MISSING_EAN,
        settings,
    )

    assert result.counts["off_not_found"] == 1
    row = _product(db_conn, MISSING_EAN)
    assert row["off_checked_at"] == CHECKED_AT
    assert (row["nova_group"], row["quantity_text"]) == (1, "1 l")  # earlier data kept


def test_unknown_ean_is_counted(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    fixture_bytes: Callable[[str], bytes],
    settings: Settings,
) -> None:
    result = _ingest(
        db_conn, raw_payload, fixture_bytes("openfoodfacts/product_found.json"), FOUND_EAN, settings
    )
    assert result.counts["off_unknown_ean"] == 1
    assert db_conn.execute(select(product.c.id)).first() is None  # never created here


def test_ean_falls_back_to_the_body(
    db_conn: Connection,
    raw_payload: RawPayloadFactory,
    fixture_bytes: Callable[[str], bytes],
    settings: Settings,
) -> None:
    _add_product(db_conn, FOUND_EAN)
    payload = raw_payload(
        "openfoodfacts", "product", fixture_bytes("openfoodfacts/product_found.json")
    )
    assert ingest_payload(db_conn, payload, settings=settings).counts["off_found"] == 1


def test_invalid_payloads(
    db_conn: Connection, raw_payload: RawPayloadFactory, settings: Settings
) -> None:
    with pytest.raises(UnsupportedEndpointError):
        ingest_payload(db_conn, raw_payload("openfoodfacts", "search", {}), settings=settings)
    with pytest.raises(SourceSchemaError):
        ingest_payload(
            db_conn, raw_payload("openfoodfacts", "product", {"status": 1}), settings=settings
        )
    with pytest.raises(MissingEanError):
        ingest_payload(
            db_conn,
            raw_payload("openfoodfacts", "product", {"code": "abc", "status": 0}),
            settings=settings,
        )


def test_registered_ingester() -> None:
    assert get_ingester("openfoodfacts") is ingest_payload


def test_eans_due_for_enrichment(db_conn: Connection) -> None:
    now = datetime(2026, 11, 18, tzinfo=UTC)
    _add_product(db_conn, "5700000000001", off_checked_at=now - timedelta(days=200))
    _add_product(db_conn, "5700000000002", off_checked_at=now - timedelta(days=95))
    _add_product(db_conn, "5700000000003", off_checked_at=now - timedelta(days=10))  # fresh
    _add_product(db_conn, "5700000000004")  # never checked
    _add_product(db_conn, "250913")  # not an EAN (in-store code)

    assert eans_due_for_enrichment(db_conn, now=now, limit=10) == [
        "5700000000004",
        "5700000000001",
        "5700000000002",
    ]
    assert eans_due_for_enrichment(db_conn, now=now, limit=2) == [
        "5700000000004",
        "5700000000001",
    ]
