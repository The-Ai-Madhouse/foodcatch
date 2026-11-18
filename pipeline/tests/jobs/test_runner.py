from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Any
from uuid import UUID

import httpx
import pytest
import respx
from sqlalchemy import Connection, Engine, insert, select

from foodcatch.config import Settings
from foodcatch.db.tables import fetch_run, raw_object
from foodcatch.ingest import IngestResult, RawPayload
from foodcatch.jobs import JobContext, PipelineState, UnknownJobError, register_job
from foodcatch.jobs.hooks import POST_FETCH_HOOKS, PostFetchHook
from foodcatch.jobs.registry import unregister_job
from foodcatch.jobs.runner import RunResult, run_job
from foodcatch.monitoring import Healthchecks
from foodcatch.sources import Fetched
from foodcatch.storage.raw import LocalRawStore

JOB = "test-job"
PING = "https://hc-ping.com/test-job"


class Behaviour:
    """What the registered test job does on its next run."""

    records: int = 10
    fail: bool = False
    raw_bodies: tuple[bytes, ...] = (b'{"a": 1}',)


@pytest.fixture
def behaviour() -> Iterator[type[Behaviour]]:
    class B(Behaviour):
        pass

    @register_job(JOB, source="tjek", description="Test job")
    def _job(ctx: JobContext) -> None:
        for body in B.raw_bodies:
            ctx.store_raw("offers", {"catalog_ids": "c1"}, body)
        ctx.record_ingest(IngestResult(records=B.records))
        if B.fail:
            raise RuntimeError("source exploded")

    yield B
    unregister_job(JOB)


class Runner:
    """Runs the test job against the test database with injected collaborators."""

    def __init__(self, engine: Engine, settings: Settings, raw_store: LocalRawStore) -> None:
        self.engine = engine
        self.settings = settings
        self.raw_store = raw_store
        self.hook_calls: list[str] = []

    def hook(self, conn: Connection, state: PipelineState) -> None:
        self.hook_calls.append("hook")
        state.stats["hooked"] += 1

    def __call__(
        self,
        *,
        hooks: Sequence[PostFetchHook] | None = None,
        healthchecks: Healthchecks | None = None,
        settings: Settings | None = None,
    ) -> RunResult:
        with httpx.Client() as http:
            return run_job(
                JOB,
                settings=settings or self.settings,
                engine=self.engine,
                raw_store=self.raw_store,
                http=http,
                hooks=[self.hook] if hooks is None else hooks,
                healthchecks=healthchecks,
            )


@pytest.fixture
def run(clean_db: Engine, settings: Settings, raw_store: LocalRawStore) -> Runner:
    return Runner(clean_db, settings, raw_store)


def _runs(engine: Engine) -> list[Any]:
    with engine.connect() as conn:
        return list(conn.execute(select(fetch_run).order_by(fetch_run.c.started_at)).all())


def test_success_records_run_raw_objects_and_stats(
    run: Runner, behaviour: type[Behaviour], clean_db: Engine, raw_store: LocalRawStore
) -> None:
    behaviour.raw_bodies = (b'{"a": 1}', b'{"b": 2}')
    result = run()
    assert result.status == "succeeded"
    assert result.ok
    assert run.hook_calls == ["hook"]

    (row,) = _runs(clean_db)
    assert row.id == result.run_id
    assert row.status == "succeeded"
    assert row.job == JOB
    assert row.source == "tjek"
    assert row.finished_at is not None
    assert row.error is None
    assert row.stats["records"] == 10
    assert row.stats["raw_objects"] == 2
    assert row.stats["hooked"] == 1
    assert row.stats["quality"]["status"] == "succeeded"
    assert "db_size_mb" in row.stats

    with clean_db.connect() as conn:
        objects = conn.execute(select(raw_object).order_by(raw_object.c.storage_key)).all()
    assert [o.endpoint for o in objects] == ["offers", "offers"]
    assert objects[0].params == {"catalog_ids": "c1"}
    started = row.started_at
    assert objects[0].storage_key == (
        f"tjek/offers/{started:%Y}/{started:%m}/{started:%d}/{row.id}/00000.json.gz"
    )
    assert objects[1].storage_key.endswith("/00001.json.gz")
    assert raw_store.get(objects[1].storage_key) == b'{"b": 2}'


def test_failure_marks_run_failed_keeps_raw_and_reraises(
    run: Runner, behaviour: type[Behaviour], clean_db: Engine
) -> None:
    behaviour.fail = True
    with pytest.raises(RuntimeError, match="source exploded"):
        run()
    (row,) = _runs(clean_db)
    assert row.status == "failed"
    assert row.error == "RuntimeError: source exploded"
    assert row.stats["records"] == 10
    assert run.hook_calls == []  # hooks never ran
    with clean_db.connect() as conn:
        assert conn.execute(select(raw_object.c.id)).all()  # provenance kept


def test_degraded_when_records_drop_more_than_threshold(
    run: Runner, behaviour: type[Behaviour], clean_db: Engine
) -> None:
    behaviour.records = 100
    assert run().status == "succeeded"
    behaviour.records = 60  # -40 %: fine
    assert run().status == "succeeded"
    behaviour.records = 20  # -67 % vs. the previous successful run
    result = run()
    assert result.status == "degraded"
    assert "records dropped 67%" in result.message
    rows = _runs(clean_db)
    assert [r.status for r in rows] == ["succeeded", "succeeded", "degraded"]
    assert rows[-1].error == result.message
    assert rows[-1].stats["quality"]["previous"] == 60


def test_threshold_is_configurable(
    run: Runner, behaviour: type[Behaviour], settings: Settings
) -> None:
    behaviour.records = 100
    run()
    behaviour.records = 85
    strict = settings.model_copy(update={"quality_drop_threshold": 0.1})
    assert run(settings=strict).status == "degraded"


@respx.mock
def test_healthchecks_pings(run: Runner, behaviour: type[Behaviour]) -> None:
    start = respx.post(f"{PING}/start").mock(return_value=httpx.Response(200))
    ok = respx.post(PING).mock(return_value=httpx.Response(200))
    fail = respx.post(f"{PING}/fail").mock(return_value=httpx.Response(200))
    result = run(healthchecks=Healthchecks(PING))
    assert start.call_count == 1
    assert ok.call_count == 1
    assert fail.call_count == 0
    assert result.ok

    behaviour.fail = True
    with pytest.raises(RuntimeError):
        run(healthchecks=Healthchecks(PING))
    assert fail.call_count == 1
    assert b"source exploded" in fail.calls.last.request.content


def test_store_raw_refuses_secret_params(
    run: Runner, behaviour: type[Behaviour], clean_db: Engine
) -> None:
    unregister_job(JOB)

    @register_job(JOB, source="tjek")
    def _leaky(ctx: JobContext) -> None:
        ctx.store_raw("stores", {"api_key": "x"}, b"{}")

    with pytest.raises(ValueError, match="secret"):
        run()


def test_ingest_path_uses_source_ingester(
    run: Runner, behaviour: type[Behaviour], monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[RawPayload] = []
    listing = UUID(int=1)

    def fake_ingester(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
        seen.append(payload)
        return IngestResult(records=4, listing_ids={listing}, counts={"offers": 4})  # pyright: ignore[reportArgumentType]

    monkeypatch.setattr("foodcatch.ingest.tjek.ingest_payload", fake_ingester)
    unregister_job(JOB)

    @register_job(JOB, source="tjek")
    def _job(ctx: JobContext) -> None:
        ctx.ingest(Fetched(endpoint="offers", params={"offset": 0}, body=b"[]", data=[]))
        assert ctx.listing_ids == {listing}

    result = run(hooks=[])
    assert result.stats["records"] == 4
    assert result.stats["offers"] == 4
    assert seen[0].endpoint == "offers"
    assert seen[0].body == b"[]"


def test_default_hooks_are_noops_until_implemented(run: Runner, behaviour: type[Behaviour]) -> None:
    result = run(hooks=POST_FETCH_HOOKS)
    assert result.stats.get("classified", 0) == 0
    assert result.ok


def test_previous_run_lookup_ignores_failed_runs(
    run: Runner, behaviour: type[Behaviour], clean_db: Engine
) -> None:
    with clean_db.begin() as conn:
        conn.execute(
            insert(fetch_run).values(
                job=JOB, source="tjek", status="failed", stats={"records": 1000}
            )
        )
    assert run().status == "succeeded"


def test_unknown_job(settings: Settings) -> None:
    with pytest.raises(UnknownJobError, match="jobs list"):
        run_job("does-not-exist", settings=settings)
