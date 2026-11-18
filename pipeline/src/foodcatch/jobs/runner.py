"""Run one job with full bookkeeping (architecture §4 steps 1, 3, 7, 8).

:func:`run_job`:

1. inserts a ``fetch_run`` row (``running``) and pings healthchecks ``/start``;
2. calls the job body with a :class:`~foodcatch.jobs.context.JobContext` inside one transaction,
   followed by the post-fetch hooks (classify, deals) if the job enables them;
3. commits, then compares the quality metric with the previous successful run
   (drop > ``QUALITY_DROP_THRESHOLD`` -> ``degraded``) and checks the database size budget;
4. finishes the run (``succeeded`` / ``degraded`` / ``failed`` with stats and error) and pings
   healthchecks (success, or ``/fail`` for degraded and failed runs).

A failure rolls back the main transaction (raw objects already stored stay recorded), marks the
run ``failed`` and re-raises. A degraded run keeps its data and is reported to the caller, which
exits non-zero.
"""

from __future__ import annotations

import subprocess
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal
from uuid import UUID, uuid4

import httpx
from sqlalchemy import Engine, insert, update
from structlog.typing import FilteringBoundLogger

from foodcatch.config import Settings, get_settings
from foodcatch.db.engine import make_engine
from foodcatch.db.tables import fetch_run
from foodcatch.http import create_client
from foodcatch.jobs.context import JobContext, PipelineState
from foodcatch.jobs.hooks import POST_FETCH_HOOKS, PostFetchHook, run_post_fetch_hooks
from foodcatch.jobs.quality import (
    DB_SIZE_WARN_FRACTION,
    QualityResult,
    check_record_drop,
    database_size_bytes,
    previous_successful_stats,
)
from foodcatch.jobs.registry import get_job
from foodcatch.logging import get_logger
from foodcatch.monitoring import Healthchecks
from foodcatch.storage.raw import RawStore
from foodcatch.storage.raw import from_url as raw_store_from_url

MAX_ERROR_CHARS = 4000

type RunStatus = Literal["succeeded", "degraded", "failed"]


@dataclass(frozen=True, slots=True)
class RunResult:
    """Outcome of a finished (not failed) run."""

    run_id: UUID
    job: str
    status: RunStatus
    stats: dict[str, Any] = field(default_factory=dict[str, Any])
    message: str = ""

    @property
    def ok(self) -> bool:
        """True for ``succeeded``."""
        return self.status == "succeeded"


def detect_git_sha() -> str | None:
    """Current commit SHA from git, or ``None`` outside a checkout."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],  # noqa: S607 - git from PATH is intended
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


def _format_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:MAX_ERROR_CHARS]


def _finish(
    engine: Engine,
    run_id: UUID,
    status: RunStatus,
    stats: dict[str, Any],
    error: str | None = None,
) -> None:
    with engine.begin() as conn:
        conn.execute(
            update(fetch_run)
            .where(fetch_run.c.id == run_id)
            .values(
                status=status, finished_at=datetime.now().astimezone(), stats=stats, error=error
            )
        )


def run_job(
    name: str,
    *,
    settings: Settings | None = None,
    engine: Engine | None = None,
    raw_store: RawStore | None = None,
    http: httpx.Client | None = None,
    healthchecks: Healthchecks | None = None,
    hooks: Sequence[PostFetchHook] = POST_FETCH_HOOKS,
) -> RunResult:
    """Run the job registered as ``name`` (see module docstring).

    All collaborators default to production instances built from ``settings``; tests inject
    their own. Collaborators passed in are not closed.

    Returns:
        The :class:`RunResult` (``succeeded`` or ``degraded``).

    Raises:
        UnknownJobError: if no such job is registered.
        Exception: whatever the job raised, after the run was marked ``failed``.
    """
    spec = get_job(name)
    settings = settings or get_settings()
    own_engine = engine is None
    engine = engine or make_engine(settings=settings)
    own_http = http is None
    http = http or create_client()
    run_id = uuid4()
    log = get_logger("foodcatch.jobs", job=name, run_id=str(run_id))
    hc = healthchecks or Healthchecks.for_job(settings, name, run_id=str(run_id))
    state = PipelineState()
    try:
        with engine.begin() as conn:
            started_at: datetime = conn.execute(
                insert(fetch_run)
                .values(
                    id=run_id,
                    job=spec.name,
                    source=spec.source,
                    status="running",
                    git_sha=settings.git_sha or detect_git_sha(),
                )
                .returning(fetch_run.c.started_at)
            ).scalar_one()
        hc.start()
        log.info("job.started", source=spec.source)
        try:
            store = raw_store or raw_store_from_url(settings.raw_store_url, settings)
            with engine.connect() as conn, conn.begin():
                ctx = JobContext(
                    run_id=run_id,
                    spec=spec,
                    started_at=started_at,
                    settings=settings,
                    engine=engine,
                    conn=conn,
                    http=http,
                    raw_store=store,
                    log=log,
                    state=state,
                )
                spec.func(ctx)
                if spec.post_fetch:
                    run_post_fetch_hooks(conn, state, hooks)
            stats: dict[str, Any] = dict(state.stats)
            with engine.connect() as conn:
                quality = check_record_drop(
                    previous_successful_stats(conn, spec.name, run_id),
                    stats,
                    spec.quality_metric,
                    settings.quality_drop_threshold,
                )
                db_bytes = database_size_bytes(conn)
        except BaseException as exc:
            stats = dict(state.stats)
            error = _format_error(exc)
            _finish(engine, run_id, "failed", stats, error)
            log.error("job.failed", error=error, stats=stats, exc_info=True)
            hc.fail(error)
            raise
        return _complete(engine, run_id, name, settings, stats, quality, db_bytes, hc, log)
    finally:
        if own_http:
            http.close()
        if own_engine:
            engine.dispose()


def _complete(
    engine: Engine,
    run_id: UUID,
    name: str,
    settings: Settings,
    stats: dict[str, Any],
    quality: QualityResult,
    db_bytes: int,
    hc: Healthchecks,
    log: FilteringBoundLogger,
) -> RunResult:
    budget = settings.db_size_budget_mb * 1024 * 1024
    stats["db_size_mb"] = round(db_bytes / 1024 / 1024, 1)
    stats["quality"] = quality.as_stats()
    if db_bytes > DB_SIZE_WARN_FRACTION * budget:
        stats["db_size_warning"] = True
        log.warning(
            "db.size_budget",
            db_size_mb=stats["db_size_mb"],
            budget_mb=settings.db_size_budget_mb,
        )
    status: RunStatus = quality.status
    _finish(engine, run_id, status, stats, quality.message or None)
    summary = ", ".join(f"{k}={v}" for k, v in sorted(stats.items()) if isinstance(v, int | float))
    if status == "degraded":
        log.warning("job.degraded", reason=quality.message, stats=stats)
        hc.fail(f"degraded: {quality.message}\n{summary}")
    else:
        log.info("job.succeeded", stats=stats)
        hc.success(summary)
    return RunResult(run_id=run_id, job=name, status=status, stats=stats, message=quality.message)
