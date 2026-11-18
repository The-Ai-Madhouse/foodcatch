"""Smoke tests of the `api` views against a minimal data set."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import uuid4

import pytest
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


def _food_waste_listing(
    conn: Connection,
    payload: RawPayload,
    *,
    title: str = "HK. OKSEKØD 8-12% 500G",
    ean: str = "5700000000001",
    size: Decimal | None = None,
    product_values: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
    last_seen_at: datetime | None = None,
) -> Any:
    """A current clearance in a Salling Netto store (created on first use), classified."""
    store_id = conn.execute(
        select(store.c.id).where(store.c.source_store_id == "7fd81b2b-219b-4795-a561-c1a9d3fb28d1")
    ).scalar()
    if store_id is None:
        store_id = conn.execute(
            insert(store)
            .values(
                chain_id="netto",
                source="salling",
                source_store_id="7fd81b2b-219b-4795-a561-c1a9d3fb28d1",
                name="Netto Hvidovre",
                lat=55.64,
                lon=12.47,
            )
            .returning(store.c.id)
        ).scalar_one()
    product_id = conn.execute(
        insert(product)
        .values(ean=ean, name=title, **(product_values or {}))
        .returning(product.c.id)
    ).scalar_one()
    listing_id = conn.execute(
        insert(listing)
        .values(
            source="salling_food_waste",
            source_item_id=f"7fd81b2b-219b-4795-a561-c1a9d3fb28d1:{ean}",
            chain_id="netto",
            store_id=store_id,
            product_id=product_id,
            kind="clearance",
            title=title,
            price=25,
            reference_price=50,
            unit="kg" if size is not None else None,
            size_min=size,
            size_max=size,
            unit_price_min=25 / size if size else None,
            unit_price_max=25 / size if size else None,
            valid_from=NOW - timedelta(hours=2),
            valid_to=NOW + timedelta(hours=10),
            raw_object_id=payload.raw_object_id,
            extra=extra or {"stock": 3, "stock_unit": "each"},
            **({"last_seen_at": last_seen_at} if last_seen_at else {}),
        )
        .returning(listing.c.id)
    ).scalar_one()
    _classify(conn, listing_id)
    return listing_id


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


def test_member_only_is_exposed_for_deals_and_history(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    payload = raw_payload("tjek", "offers", [])
    listing_id = uuid4()
    db_conn.execute(
        insert(listing).values(
            id=listing_id,
            source="tjek",
            source_item_id="netto-plus",
            chain_id="netto",
            kind="offer",
            title="Hakket oksekød 8-12%",
            price=40,
            unit="kg",
            unit_price_min=80,
            unit_price_max=80,
            member_only=True,
            valid_from=NOW - timedelta(days=1),
            valid_to=NOW + timedelta(days=3),
            raw_object_id=payload.raw_object_id,
        )
    )
    _classify(db_conn, listing_id)

    for view in ("current_netto_deals", "class_price_history"):
        row = db_conn.execute(text(f"SELECT listing_id, member_only FROM api.{view}")).one()
        assert tuple(row) == (listing_id, True)


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


# Real Salling image URLs (food-waste payloads of 2026-11-18).
_SALLING_IMAGE = "https://digitalassets.sallinggroup.com/image/upload/e_trim/c_limit,e_sharpen:80,f_auto,q_auto,w_400,h_400"


@pytest.mark.parametrize(
    ("image", "expected"),
    [
        (f"{_SALLING_IMAGE}/64b99ee6-cc51-4b09-aa1b-29b6ac50231e", "same"),
        (f"{_SALLING_IMAGE}/950733da79a4a77a10477bf2fbed3ae9", "same"),
        (f"{_SALLING_IMAGE}/image", None),  # Salling's placeholder for products without a picture
        (None, None),
        (
            "https://images.openfoodfacts.org/images/products/576/046/687/0306/front_da.3.400.jpg",
            None,
        ),
        ("http://digitalassets.sallinggroup.com/image/upload/x/64b99ee6", None),
        ("javascript:alert(1)", None),
    ],
)
def test_food_waste_near_shows_only_salling_product_images(
    db_conn: Connection,
    raw_payload: Callable[..., RawPayload],
    image: str | None,
    expected: str | None,
) -> None:
    payload = raw_payload("salling", "food-waste", {})
    _food_waste_listing(db_conn, payload, extra={"stock": 3, "stock_unit": "each", "image": image})

    row = db_conn.execute(text("SELECT image_url FROM api.food_waste_near")).one()

    assert row.image_url == (image if expected == "same" else expected)


def test_food_waste_near_shows_size_product_quantity_and_snapshot_time(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    payload = raw_payload("salling", "food-waste", {})
    seen = NOW - timedelta(minutes=20)
    listing_id = _food_waste_listing(
        db_conn,
        payload,
        title="HYTTEOST 0,4% 450G DAIRY GOOOD",
        size=Decimal("0.45"),
        product_values={
            "quantity_text": "450 g",
            "net_quantity": Decimal("0.45"),
            "net_unit": "kg",
        },
        last_seen_at=seen,
    )
    unsized = _food_waste_listing(db_conn, payload, title="ARLA SØDMÆLK ARLA", ean="5711953068881")

    rows = {
        r.listing_id: r
        for r in db_conn.execute(
            text(
                "SELECT listing_id, size, unit, product_quantity_text, product_net_quantity,"
                " product_net_unit, last_seen_at FROM api.food_waste_near"
            )
        )
    }

    assert tuple(rows[listing_id])[1:] == (
        Decimal("0.45"),
        "kg",
        "450 g",
        Decimal("0.45"),
        "kg",
        seen,
    )
    assert tuple(rows[unsized])[1:6] == (None, None, None, None, None)


def test_stores_expose_source_and_source_store_id(db_conn: Connection) -> None:
    for source, source_store_id in (
        ("salling", "7fd81b2b-219b-4795-a561-c1a9d3fb28d1"),
        ("tjek", "86d7kOL"),
    ):
        db_conn.execute(
            insert(store).values(
                chain_id="netto",
                source=source,
                source_store_id=source_store_id,
                name="Netto Smedelundsgade",
                lat=55.72,
                lon=11.71,
            )
        )

    rows = db_conn.execute(text("SELECT source, source_store_id FROM api.stores")).all()

    assert sorted(tuple(r) for r in rows) == [
        ("salling", "7fd81b2b-219b-4795-a561-c1a9d3fb28d1"),
        ("tjek", "86d7kOL"),
    ]


def test_current_netto_deals_and_history_expose_source_ids_and_sizes(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    payload = raw_payload("tjek", "offers", [])
    listing_id = uuid4()
    db_conn.execute(
        insert(listing).values(
            id=listing_id,
            source="tjek",
            source_item_id="pyuF3FVONEex9gEDcKpv0",  # real Tjek offer id and catalog id
            catalog_id="40K-WXWp",
            chain_id="netto",
            kind="offer",
            title="Dansk kyllingefilet, -inderfilet eller -lårfilet",
            description="900-1000 g. Max. 3 stk. pr. kunde",
            price=60,
            unit="kg",
            size_min=Decimal("0.9"),
            size_max=Decimal("1.0"),
            unit_price_min=60,
            unit_price_max=Decimal("66.67"),
            max_per_customer=3,
            valid_from=NOW - timedelta(days=1),
            valid_to=NOW + timedelta(days=3),
            raw_object_id=payload.raw_object_id,
        )
    )
    _classify(db_conn, listing_id)
    expected = ("tjek", "pyuF3FVONEex9gEDcKpv0", "40K-WXWp", Decimal("0.9"), Decimal("1.0"))

    deal_row = db_conn.execute(
        text(
            "SELECT source, source_item_id, catalog_id, size_min, size_max, max_per_customer"
            " FROM api.current_netto_deals"
        )
    ).one()
    history_row = db_conn.execute(
        text(
            "SELECT source, source_item_id, catalog_id, size_min, size_max, store_id, price,"
            " description FROM api.class_price_history"
        )
    ).one()

    assert tuple(deal_row) == (*expected, 3)
    assert tuple(history_row) == (
        *expected,
        None,
        Decimal(60),
        "900-1000 g. Max. 3 stk. pr. kunde",
    )


def test_class_price_history_exposes_the_store_of_a_clearance(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    payload = raw_payload("salling", "food-waste", {})
    listing_id = _food_waste_listing(db_conn, payload)
    store_id = db_conn.execute(select(listing.c.store_id)).scalar_one()

    row = db_conn.execute(
        text("SELECT listing_id, source, source_item_id, store_id FROM api.class_price_history")
    ).one()

    assert tuple(row) == (
        listing_id,
        "salling_food_waste",
        "7fd81b2b-219b-4795-a561-c1a9d3fb28d1:5700000000001",
        store_id,
    )
