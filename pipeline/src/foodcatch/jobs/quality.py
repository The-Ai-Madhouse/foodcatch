"""Quality checks run after a job (architecture §4 step 7)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import Connection, func, select, text

from foodcatch.db.tables import fetch_run

DB_SIZE_WARN_FRACTION = 0.7


@dataclass(frozen=True, slots=True)
class QualityResult:
    """Outcome of the record-count check."""

    status: Literal["succeeded", "degraded"]
    metric: str | None
    current: float | None
    previous: float | None
    message: str = ""

    def as_stats(self) -> dict[str, Any]:
        """JSON-serializable summary stored under ``fetch_run.stats.quality``."""
        return {
            "metric": self.metric,
            "current": self.current,
            "previous": self.previous,
            "status": self.status,
            "message": self.message,
        }


def previous_successful_stats(conn: Connection, job: str, exclude_run: UUID) -> Mapping[str, Any]:
    """``stats`` of the latest ``succeeded`` run of ``job`` other than ``exclude_run``."""
    row = conn.execute(
        select(fetch_run.c.stats)
        .where(
            fetch_run.c.job == job,
            fetch_run.c.status == "succeeded",
            fetch_run.c.id != exclude_run,
        )
        .order_by(fetch_run.c.started_at.desc())
        .limit(1)
    ).first()
    return dict(row.stats) if row is not None else {}


def check_record_drop(
    previous: Mapping[str, Any],
    current: Mapping[str, Any],
    metric: str | None,
    threshold: float,
) -> QualityResult:
    """Mark a run ``degraded`` if ``metric`` dropped by more than ``threshold`` (0-1).

    No previous value (first run) or a disabled metric always passes.
    """
    if metric is None:
        return QualityResult("succeeded", None, None, None)
    cur = float(current.get(metric, 0) or 0)
    prev_raw = previous.get(metric)
    prev = float(prev_raw) if isinstance(prev_raw, int | float) else None
    if prev is None or prev <= 0:
        return QualityResult("succeeded", metric, cur, prev)
    if cur < prev * (1 - threshold):
        drop = 1 - cur / prev
        return QualityResult(
            "degraded",
            metric,
            cur,
            prev,
            f"{metric} dropped {drop:.0%} ({prev:g} -> {cur:g}); threshold {threshold:.0%}",
        )
    return QualityResult("succeeded", metric, cur, prev)


def with_job_reasons(result: QualityResult, reasons: Sequence[str]) -> QualityResult:
    """``result`` marked ``degraded`` when the job reported ``reasons`` (messages joined)."""
    if not reasons:
        return result
    message = "; ".join([*reasons, *([result.message] if result.message else [])])
    return replace(result, status="degraded", message=message)


def database_size_bytes(conn: Connection) -> int:
    """Size of the current database in bytes."""
    return int(conn.execute(select(func.pg_database_size(text("current_database()")))).scalar_one())
