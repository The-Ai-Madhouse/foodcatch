"""Cross-module contracts: the ``api`` view columns the web reads, and that what ingest writes
is what those views read."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Connection, Engine, insert, select, text

from api_contract import API_COLUMNS, api_columns
from foodcatch.config import Settings
from foodcatch.db.tables import fetch_run, listing
from foodcatch.ingest import RawPayload
from foodcatch.ingest.salling import ingest_payload, parse_net_size
from foodcatch.ingest.tjek import ingest_payload as tjek_ingest
from foodcatch.jobs.context import PipelineState
from foodcatch.jobs.hooks import run_post_fetch_hooks


def test_api_view_columns_match_the_web_contract(db_engine: Engine) -> None:
    with db_engine.connect() as conn:
        assert api_columns(conn) == API_COLUMNS


def test_food_waste_near_shows_stock_written_by_salling_ingest(
    db_conn: Connection,
    raw_payload: Callable[..., RawPayload],
    fixture_bytes: Callable[[str], bytes],
    settings: Settings,
) -> None:
    payload = raw_payload(
        "salling", "food-waste", fixture_bytes("salling/food_waste_netto_hvidovre.json")
    )
    result = ingest_payload(db_conn, payload, settings=settings)
    assert result.listing_ids
    run_post_fetch_hooks(db_conn, PipelineState(listing_ids=set(result.listing_ids)))
    db_conn.execute(
        insert(fetch_run).values(job="salling-food-waste", source="salling", status="succeeded")
    )

    rows = db_conn.execute(text("SELECT * FROM api.food_waste_near")).mappings().all()

    assert rows, "the fixture has healthy staples in the region"
    for row in rows:
        assert row["stock"] is not None
        assert row["stock_unit"] in {"each", "kg"}
        assert row["class_label"]
        assert row["store_name"]


def test_food_waste_near_sizes_and_images_from_real_salling_payloads(
    db_conn: Connection,
    raw_payload: Callable[..., RawPayload],
    fixture_bytes: Callable[[str], bytes],
    settings: Settings,
) -> None:
    """Real payloads: a size only when the name states one, an image only when it is a picture."""
    tomorrow = (datetime.now(UTC) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    listing_ids: set[UUID] = set()
    for name in ("food_waste_netto_hvidovre", "food_waste_bilka_tilst"):
        body = json.loads(fixture_bytes(f"salling/{name}.json"))
        for clearance in body["clearances"]:
            clearance["offer"]["endTime"] = tomorrow  # keep the fixture current
        result = ingest_payload(
            db_conn, raw_payload("salling", "food-waste", body), settings=settings
        )
        listing_ids.update(result.listing_ids)
    run_post_fetch_hooks(db_conn, PipelineState(listing_ids=listing_ids))
    db_conn.execute(
        insert(fetch_run).values(job="salling-food-waste", source="salling", status="succeeded")
    )
    images = dict(db_conn.execute(select(listing.c.id, listing.c.extra["image"].astext)).all())

    rows = db_conn.execute(text("SELECT * FROM api.food_waste_near")).mappings().all()

    assert rows, "the fixtures have healthy staples"
    for row in rows:
        size = parse_net_size(row["title"])
        assert row["size"] == (size.quantity if size else None), row["title"]
        image = images[row["listing_id"]]
        is_picture = image is not None and not image.endswith("/image")
        assert row["image_url"] == (image if is_picture else None), row["title"]
        assert row["last_seen_at"] is not None
    assert any(r["size"] is not None for r in rows)
    assert any(r["image_url"] is not None for r in rows)


def test_source_ids_and_sizes_from_real_tjek_payloads(
    db_conn: Connection,
    raw_payload: Callable[..., RawPayload],
    fixture_bytes: Callable[[str], bytes],
    settings: Settings,
) -> None:
    """Real payloads: the ids the web builds eTilbudsavis links from are Tjek's own ids."""
    stores_body = fixture_bytes("tjek/stores_netto.json")
    offers_body = fixture_bytes("tjek/offers_netto.json")
    tjek_ingest(db_conn, raw_payload("tjek", "stores", stores_body), settings=settings)
    result = tjek_ingest(db_conn, raw_payload("tjek", "offers", offers_body), settings=settings)
    run_post_fetch_hooks(db_conn, PipelineState(listing_ids=set(result.listing_ids)))
    offers = {o["id"]: o for o in json.loads(offers_body)}

    stores = db_conn.execute(
        text("SELECT source, source_store_id FROM api.stores WHERE chain_id = 'netto'")
    ).all()
    assert {tuple(s) for s in stores} == {("tjek", s["id"]) for s in json.loads(stores_body)}

    rows = db_conn.execute(text("SELECT * FROM api.class_price_history")).mappings().all()
    assert rows, "the fixture has classified staples"
    sized = 0
    for row in rows:
        offer = offers[row["source_item_id"]]
        assert row["source"] == "tjek"
        assert row["catalog_id"] == offer["catalog_id"]
        assert row["price"] == Decimal(str(offer["pricing"]["price"]))
        assert row["store_id"] is None  # Tjek catalogs apply to the whole chain
        quantity = offer["quantity"]
        if (quantity.get("pieces") or {}).get("to") == 1 and quantity["size"]["from"]:
            factor = Decimal(str(quantity["unit"]["si"]["factor"]))
            size_from, size_to = (Decimal(str(quantity["size"][k])) for k in ("from", "to"))
            assert row["size_min"] == size_from * factor, offer["heading"]
            assert row["size_max"] == size_to * factor, offer["heading"]
            sized += 1
    assert sized
