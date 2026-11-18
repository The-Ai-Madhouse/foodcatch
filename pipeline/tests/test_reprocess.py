from __future__ import annotations

from datetime import date
from uuid import UUID

import httpx
import pytest
from sqlalchemy import Connection, Engine

from foodcatch.config import Settings
from foodcatch.ingest import IngestResult, RawPayload, UnknownSourceError
from foodcatch.jobs import JobContext, PipelineState, register_job
from foodcatch.jobs.registry import unregister_job
from foodcatch.jobs.runner import run_job
from foodcatch.reprocess import RawIntegrityError, reprocess
from foodcatch.storage.raw import LocalRawStore

LISTING = UUID(int=42)


@pytest.fixture
def stored_run(clean_db: Engine, settings: Settings, raw_store: LocalRawStore) -> Engine:
    """Run a job that stores two rema payloads raw (ingest is a no-op job body here)."""

    @register_job("reprocess-test", source="rema", post_fetch=False)
    def _job(ctx: JobContext) -> None:
        ctx.store_raw("products", {"page": 1}, b'{"page": 1}')
        ctx.store_raw("products", {"page": 2}, b'{"page": 2}')

    try:
        with httpx.Client() as http:
            run_job(
                "reprocess-test", settings=settings, engine=clean_db, raw_store=raw_store, http=http
            )
    finally:
        unregister_job("reprocess-test")
    return clean_db


def test_replays_raw_objects_in_order_and_runs_hooks(
    stored_run: Engine,
    settings: Settings,
    raw_store: LocalRawStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[RawPayload] = []
    hooked: list[set[UUID]] = []

    def fake_ingest(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
        seen.append(payload)
        return IngestResult(records=3, listing_ids={LISTING})

    def hook(conn: Connection, state: PipelineState) -> None:
        hooked.append(set(state.listing_ids))

    monkeypatch.setattr("foodcatch.ingest.rema.ingest_payload", fake_ingest)
    result = reprocess(stored_run, raw_store, settings, source="rema", hooks=[hook])
    assert result.objects == 2
    assert result.records == 6
    assert result.listings == 1
    assert [p.body for p in seen] == [b'{"page": 1}', b'{"page": 2}']
    assert seen[0].params == {"page": 1}
    assert hooked == [{LISTING}]

    future = reprocess(
        stored_run, raw_store, settings, source="rema", since=date(2999, 1, 1), hooks=[]
    )
    assert future.objects == 0


def test_detects_tampered_raw_objects(
    stored_run: Engine,
    settings: Settings,
    raw_store: LocalRawStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "foodcatch.ingest.rema.ingest_payload",
        lambda conn, payload, *, settings: IngestResult(),  # pyright: ignore[reportUnknownLambdaType]
    )
    path = next(raw_store.root.rglob("00000.json.gz"))
    path.unlink()
    raw_store.put(str(path.relative_to(raw_store.root)), b'{"page": "tampered"}')
    with pytest.raises(RawIntegrityError):
        reprocess(stored_run, raw_store, settings, source="rema", hooks=[])


def test_unknown_source(clean_db: Engine, settings: Settings, raw_store: LocalRawStore) -> None:
    with pytest.raises(UnknownSourceError):
        reprocess(clean_db, raw_store, settings, source="nope")
