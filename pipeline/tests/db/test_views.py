"""Smoke tests of the `api` views against a minimal data set."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import Connection, insert, select, text, update

from foodcatch.db.tables import classification, deal, fetch_run, listing, product, store
from foodcatch.ingest import RawPayload

NOW = datetime.now(UTC)


def _classify(conn: Connection, listing_id: Any, *, healthy: bool = True) -> None:
    conn.execute(
        insert(classification).values(
            listing_id=listing_id,
            matcher_version="2026.11.1",
            variant_index=0,
            type_id="hakket_oksekød",
            type_label="Hakket oksekød",
            group_name="Kød",
            attrs={"fedt": "8-12%"},
            class_key="hakket_oksekød|fedt=8-12%|øko=nej|laktosefri=nej|forarbejdet=nej",
            class_label="Hakket oksekød, 8-12%",
            is_exact=True,
            is_healthy=healthy,
        )
    )


def test_current_netto_deals_and_history(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    payload = raw_payload("tjek", "offers", [])
    listing_id = uuid4()
    db_conn.execute(
        insert(listing).values(
            id=listing_id,
            source="tjek",
            source_item_id="o1",
            chain_id="netto",
            kind="offer",
            title="Hakket oksekød 8-12%",
            price=40,
            unit="kg",
            unit_price_min=80,
            unit_price_max=80,
            valid_from=NOW - timedelta(days=1),
            valid_to=NOW + timedelta(days=3),
            raw_object_id=payload.raw_object_id,
        )
    )
    _classify(db_conn, listing_id)
    rows = db_conn.execute(text("SELECT * FROM api.current_netto_deals")).mappings().all()
    assert len(rows) == 1
    assert rows[0]["references"] == []
    assert rows[0]["price_applies"] is None  # no deal computed yet

    db_conn.execute(
        insert(deal).values(
            listing_id=listing_id,
            variant_index=0,
            matcher_version="2026.11.1",
            class_key="k",
            netto_unit_price_worst=80,
            netto_unit_price_best=80,
            price_applies=True,
            references=[{"kind": "offer", "chain_id": "lidl", "unit_price": 79.0}],
        )
    )
    row = db_conn.execute(text("SELECT * FROM api.current_netto_deals")).mappings().one()
    assert row["price_applies"] is True
    assert row["references"][0]["chain_id"] == "lidl"

    history = db_conn.execute(text("SELECT * FROM api.class_price_history")).mappings().one()
    assert history["chain_name"] == "Netto"

    db_conn.execute(update(listing).values(valid_to=NOW - timedelta(hours=1)))
    assert db_conn.execute(text("SELECT count(*) FROM api.current_netto_deals")).scalar() == 0


def test_current_netto_deals_shows_only_the_latest_version_of_an_offer(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    """Regression (finding C1): a re-published offer id is shown once, at its latest price."""
    payload = raw_payload("tjek", "offers", [])
    ids = {}
    for price, seen in ((5, NOW - timedelta(days=1)), (35, NOW)):
        ids[price] = uuid4()
        db_conn.execute(
            insert(listing).values(
                id=ids[price],
                source="tjek",
                source_item_id="o1",
                chain_id="netto",
                kind="offer",
                title="Hakket oksekød 8-12%",
                price=price,
                unit="kg",
                unit_price_min=price / 0.4,
                unit_price_max=price / 0.4,
                valid_from=NOW - timedelta(days=1),
                valid_to=NOW + timedelta(days=3),
                last_seen_at=seen,
                raw_object_id=payload.raw_object_id,
            )
        )
        _classify(db_conn, ids[price])

    rows = db_conn.execute(text("SELECT listing_id FROM api.current_netto_deals")).all()

    assert [r.listing_id for r in rows] == [ids[35]]


def test_class_price_history_marks_prices_of_other_products(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    """Regression (finding C9): a "hel kylling eller hakket" kilo range is not the mince's."""
    payload = raw_payload("tjek", "offers", [])
    expected = {}
    for title, low, high, variants, applies in (
        ("Hakket oksekød 8-12%", 80, 80, 1, True),
        ("Hakket oksekød 8-12% eller oksemørbrad", 60, 200, 2, False),
        ("Hakket oksekød 8-12% eller culottesteg", 80, 100, 2, True),  # spread <= 25 %
    ):
        listing_id = uuid4()
        db_conn.execute(
            insert(listing).values(
                id=listing_id,
                source="tjek",
                source_item_id=title,
                chain_id="netto",
                kind="offer",
                title=title,
                price=40,
                unit="kg",
                unit_price_min=low,
                unit_price_max=high,
                valid_from=NOW - timedelta(days=1),
                valid_to=NOW + timedelta(days=3),
                raw_object_id=payload.raw_object_id,
            )
        )
        _classify(db_conn, listing_id)
        db_conn.execute(
            update(classification)
            .values(offer_variants=variants)
            .where(classification.c.listing_id == listing_id)
        )
        expected[listing_id] = applies

    rows = db_conn.execute(
        text("SELECT listing_id, price_applies FROM api.class_price_history")
    ).all()

    assert dict(rows) == expected


def test_food_waste_near_shows_only_items_seen_in_latest_run(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    payload = raw_payload("salling", "food-waste", {})
    store_id = db_conn.execute(
        insert(store)
        .values(
            chain_id="netto",
            source="salling",
            source_store_id="s1",
            name="Netto Nørrebrogade",
            lat=55.69,
            lon=12.55,
        )
        .returning(store.c.id)
    ).scalar_one()
    product_id = db_conn.execute(
        insert(product).values(ean="5700000000001", name="HK. OKSEKØD").returning(product.c.id)
    ).scalar_one()
    listing_id = db_conn.execute(
        insert(listing)
        .values(
            source="salling_food_waste",
            source_item_id="5700000000001",
            chain_id="netto",
            store_id=store_id,
            product_id=product_id,
            kind="clearance",
            title="HK. OKSEKØD 8-12%",
            price=25,
            reference_price=50,
            unit_price_min=50,
            valid_from=NOW - timedelta(hours=2),
            valid_to=NOW + timedelta(hours=10),
            raw_object_id=payload.raw_object_id,
            extra={"stock": 3, "stock_unit": "each"},
        )
        .returning(listing.c.id)
    ).scalar_one()
    _classify(db_conn, listing_id)

    row = db_conn.execute(text("SELECT * FROM api.food_waste_near")).mappings().one()
    assert row["discount_pct"] == 50
    assert row["stock"] == 3
    assert row["ean"] == "5700000000001"
    assert row["store_name"] == "Netto Nørrebrogade"

    # A later successful run that did not see the item hides it.
    db_conn.execute(
        insert(fetch_run).values(
            job="salling-food-waste",
            source="salling",
            status="succeeded",
            started_at=NOW + timedelta(minutes=5),
        )
    )
    db_conn.execute(update(listing).values(last_seen_at=NOW - timedelta(hours=1)))
    assert db_conn.execute(text("SELECT count(*) FROM api.food_waste_near")).scalar() == 0
    assert db_conn.execute(select(listing.c.id)).scalar_one() == listing_id


def test_pipeline_status_and_review_summary(db_conn: Connection) -> None:
    for status, offset in (("failed", 2), ("succeeded", 1)):
        db_conn.execute(
            insert(fetch_run).values(
                job="rema-products",
                source="rema",
                status=status,
                started_at=NOW - timedelta(hours=offset),
            )
        )
    row = db_conn.execute(text("SELECT * FROM api.pipeline_status")).mappings().one()
    assert row["status"] == "succeeded"
    assert db_conn.execute(text("SELECT count(*) FROM api.review_queue_summary")).scalar() == 0
