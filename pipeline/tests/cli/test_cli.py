from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import Engine, select
from typer.testing import CliRunner

from foodcatch.cli import EXIT_DEGRADED, app
from foodcatch.config import get_settings
from foodcatch.db.tables import fetch_run

runner = CliRunner()


@pytest.fixture(autouse=True)
def cli_env(database_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("RAW_STORE_URL", (tmp_path / "raw").as_uri())
    monkeypatch.setenv("LOG_FORMAT", "json")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_help_and_version() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    for command in ("collect", "reprocess", "reclassify", "db", "jobs", "review", "deals"):
        assert command in result.output
    version = runner.invoke(app, ["--version"])
    assert version.exit_code == 0
    assert version.output.startswith("foodcatch ")


def test_jobs_list() -> None:
    result = runner.invoke(app, ["jobs", "list"])
    assert result.exit_code == 0
    for job in (
        "salling-stores",
        "salling-food-waste",
        "tjek-offers",
        "rema-products",
        "off-enrich",
    ):
        assert job in result.output


def test_db_upgrade_is_idempotent_and_stats(clean_db: Engine) -> None:
    assert runner.invoke(app, ["db", "upgrade"]).exit_code == 0
    result = runner.invoke(app, ["db", "stats"])
    assert result.exit_code == 0
    assert "listing" in result.output
    assert "budget" in result.output


def test_collect_unknown_job() -> None:
    result = runner.invoke(app, ["collect", "nope"])
    assert result.exit_code == 2


def test_collect_stub_job_fails_cleanly_and_records_run(clean_db: Engine) -> None:
    result = runner.invoke(app, ["collect", "rema-products"])
    assert result.exit_code == 1
    assert "not implemented" in result.output
    with clean_db.connect() as conn:
        row = conn.execute(select(fetch_run.c.status, fetch_run.c.error)).one()
    assert row.status == "failed"
    assert row.error.startswith("NotImplementedError")


def test_degraded_exit_code_constant() -> None:
    assert EXIT_DEGRADED not in (0, 1, 2)


@pytest.mark.parametrize(
    "args",
    [["reclassify"], ["review", "list"]],
)
def test_stubbed_commands_report_not_implemented(args: list[str]) -> None:
    result = runner.invoke(app, args)
    assert result.exit_code == 1
    assert "Not implemented yet" in result.output


def test_deals_recompute_runs() -> None:
    result = runner.invoke(app, ["deals", "recompute"])
    assert result.exit_code == 0
    assert "Recomputed 0 deals" in result.output


def test_reprocess_validates_source_and_runs(clean_db: Engine) -> None:
    assert runner.invoke(app, ["reprocess", "--source", "nope"]).exit_code == 2
    result = runner.invoke(app, ["reprocess", "--source", "tjek", "--since", "2026-11-01"])
    assert result.exit_code == 0, result.output
    assert "Reprocessed 0 raw objects" in result.output


def test_review_list_rejects_unknown_reason() -> None:
    assert runner.invoke(app, ["review", "list", "--reason", "nope"]).exit_code == 2
