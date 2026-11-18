"""Cross-module contracts: what ingest writes is what the ``api`` views read."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import Connection, insert, text

from foodcatch.config import Settings
from foodcatch.db.tables import fetch_run
from foodcatch.ingest import RawPayload
from foodcatch.ingest.salling import ingest_payload
from foodcatch.jobs.context import PipelineState
from foodcatch.jobs.hooks import run_post_fetch_hooks


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
