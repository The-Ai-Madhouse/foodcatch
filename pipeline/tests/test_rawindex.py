"""``foodcatch.rawindex``: rebuilding ``raw_object`` rows from the raw store."""

from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import Engine, select

from foodcatch.config import Settings
from foodcatch.db.tables import fetch_run, raw_object
from foodcatch.jobs import JobContext, register_job
from foodcatch.jobs.registry import unregister_job
from foodcatch.jobs.runner import run_job
from foodcatch.rawindex import REINDEX_JOB, parse_key, reindex
from foodcatch.storage.raw import LocalRawStore, describe, raw_key

RUN = UUID("12345678-1234-5678-1234-567812345678")


def test_parse_key() -> None:
    parsed = parse_key(f"salling/food-waste/2026/11/18/{RUN}/00007.json.gz")
    assert parsed is not None
    assert (parsed.source, parsed.endpoint, parsed.day, parsed.run_id, parsed.seq) == (
        "salling",
        "food-waste",
        date(2026, 11, 18),
        RUN,
        7,
    )


@pytest.mark.parametrize(
    "key",
    [
        f"salling/food-waste/2026/13/18/{RUN}/00007.json.gz",  # no month 13
        f"salling/2026/11/18/{RUN}/00007.json.gz",  # endpoint missing
        "salling/food-waste/2026/11/18/not-a-uuid/00007.json.gz",
        f"salling/food-waste/2026/11/18/{RUN}/7.json.gz",
        f"salling/food-waste/2026/11/18/{RUN}/00007.json",
    ],
)
def test_parse_key_rejects_other_layouts(key: str) -> None:
    assert parse_key(key) is None


def _put(store: LocalRawStore, source: str, day: datetime, run: UUID, seq: int = 0) -> str:
    key = raw_key(source, "products", day, run, seq)
    store.put(key, f'{{"seq": {seq}}}'.encode())
    return key


def test_reindex_filters_by_source_and_day_and_skips_foreign_keys(
    clean_db: Engine, raw_store: LocalRawStore
) -> None:
    run = uuid4()
    inside = _put(raw_store, "rema", datetime(2026, 11, 10, tzinfo=UTC), run)
    _put(raw_store, "rema", datetime(2026, 11, 20, tzinfo=UTC), run, 1)  # on `until`: excluded
    _put(raw_store, "rema", datetime(2026, 11, 1, tzinfo=UTC), run, 2)  # before `since`
    _put(raw_store, "tjek", datetime(2026, 11, 10, tzinfo=UTC), uuid4())  # other source
    raw_store.put("rema/README.txt.gz", b"not a payload")

    result = reindex(
        clean_db,
        raw_store,
        sources=["rema"],
        since=date(2026, 11, 5),
        until=date(2026, 11, 20),
    )

    assert (result.scanned, result.indexed, result.skipped, result.runs_created) == (4, 1, 1, 1)
    with clean_db.connect() as conn:
        row = conn.execute(select(raw_object)).one()
        placeholder = conn.execute(select(fetch_run)).one()
    assert row.storage_key == inside
    assert row.sha256 == describe(b'{"seq": 0}').sha256
    assert row.bytes == len(b'{"seq": 0}')
    assert row.fetch_run_id == placeholder.id == run
    assert placeholder.job == REINDEX_JOB
    assert placeholder.stats == {"reindexed_objects": 1}


def test_reindex_reuses_a_surviving_fetch_run(
    clean_db: Engine, settings: Settings, raw_store: LocalRawStore
) -> None:
    @register_job("reindex-test", source="rema", post_fetch=False)
    def _job(ctx: JobContext) -> None:
        ctx.store_raw("products", {"page": 1}, b"{}")

    try:
        with httpx.Client() as http:
            result = run_job(
                "reindex-test", settings=settings, engine=clean_db, raw_store=raw_store, http=http
            )
    finally:
        unregister_job("reindex-test")
    # a second object of the same run whose row was lost
    started = datetime.now(UTC)
    _put(raw_store, "rema", started, result.run_id, 1)

    outcome = reindex(clean_db, raw_store, sources=["rema"])

    assert (outcome.indexed, outcome.already_indexed, outcome.runs_created) == (1, 1, 0)
    with clean_db.connect() as conn:
        runs = conn.execute(select(fetch_run.c.job)).scalars().all()
    assert runs == ["reindex-test"]


def test_reindex_dry_run_writes_nothing(clean_db: Engine, raw_store: LocalRawStore) -> None:
    _put(raw_store, "rema", datetime(2026, 11, 10, tzinfo=UTC), uuid4())
    result = reindex(clean_db, raw_store, sources=["rema"], dry_run=True)
    assert (result.indexed, result.runs_created) == (1, 0)
    with clean_db.connect() as conn:
        assert conn.execute(select(raw_object)).first() is None
