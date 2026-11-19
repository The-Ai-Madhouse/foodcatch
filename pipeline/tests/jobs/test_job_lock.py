"""Job runs are serialized through a shared advisory lock (deadlock seen 2026-11-19)."""

from __future__ import annotations

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import OperationalError

from foodcatch.jobs.runner import JOB_LOCK_KEY, acquire_job_lock


def test_second_run_waits_for_the_first_runs_lock(db_engine: Engine) -> None:
    with db_engine.connect() as first, first.begin():
        acquire_job_lock(first)
        with db_engine.connect() as second, second.begin():
            # Shorten the wait so the test is fast; a real run waits up to JOB_LOCK_TIMEOUT.
            second.execute(text("SET LOCAL lock_timeout = '200ms'"))
            with pytest.raises(OperationalError, match="lock timeout"):
                second.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": JOB_LOCK_KEY})


def test_lock_is_released_when_the_transaction_ends(db_engine: Engine) -> None:
    with db_engine.connect() as first, first.begin():
        acquire_job_lock(first)
    with db_engine.connect() as second, second.begin():
        got = second.execute(
            text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": JOB_LOCK_KEY}
        ).scalar_one()
        assert got is True


def test_lock_timeout_is_restored_after_acquiring(db_engine: Engine) -> None:
    with db_engine.connect() as conn, conn.begin():
        default = conn.execute(text("SHOW lock_timeout")).scalar_one()
        acquire_job_lock(conn)
        assert conn.execute(text("SHOW lock_timeout")).scalar_one() == default
