"""``foodcatch`` CLI against the test database: real commands, network mocked with respx."""

from __future__ import annotations

import copy
import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
import respx
from sqlalchemy import Engine, func, insert, select, text
from typer.testing import CliRunner

from foodcatch.cli import EXIT_DEGRADED, app
from foodcatch.config import get_settings
from foodcatch.db.tables import classification, fetch_run, listing, raw_object, review_item
from foodcatch.jobs import JobContext, register_job
from foodcatch.jobs.registry import unregister_job
from foodcatch.jobs.runner import RunResult
from foodcatch.rawindex import REINDEX_JOB
from foodcatch.sources.rema import BASE_URL as REMA_BASE_URL
from foodcatch.storage.raw import LocalRawStore, raw_key

runner = CliRunner()
NOW = datetime.now(UTC)


@pytest.fixture(autouse=True)
def cli_env(database_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("RAW_STORE_URL", (tmp_path / "raw").as_uri())
    monkeypatch.setenv("LOG_FORMAT", "json")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def cli_raw_store(tmp_path: Path) -> LocalRawStore:
    """The raw store the CLI uses (``RAW_STORE_URL`` of :func:`cli_env`)."""
    return LocalRawStore(tmp_path / "raw")


@pytest.fixture
def rema_page(load_fixture: Callable[[str], Any]) -> dict[str, Any]:
    """The recorded Rema catalogue page, announced as the whole (single-page) catalogue."""
    page = copy.deepcopy(load_fixture("rema/products_page1.json"))
    page["meta"]["pagination"].update(
        current_page=1, last_page=1, total=len(page["data"]), next_page_url=None
    )
    return page


def _count(engine: Engine, table: Any) -> int:
    with engine.connect() as conn:
        return conn.execute(select(func.count()).select_from(table)).scalar_one()


# ------------------------------------------------------------------------------- basics
def test_help_and_version() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    for command in ("collect", "reprocess", "reclassify", "db", "jobs", "review", "deals", "raw"):
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
        "tjek-stores",
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


# ------------------------------------------------------------------------------ collect
def test_collect_unknown_job() -> None:
    result = runner.invoke(app, ["collect", "nope"])
    assert result.exit_code == 2


def test_collect_runs_a_job_end_to_end(clean_db: Engine, rema_page: dict[str, Any]) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get(f"{REMA_BASE_URL}/products").respond(200, json=rema_page)
        result = runner.invoke(app, ["collect", "rema-products"])

    assert result.exit_code == 0, result.output
    assert "succeeded" in result.output
    with clean_db.connect() as conn:
        run = conn.execute(select(fetch_run.c.status, fetch_run.c.stats)).one()
    assert run.status == "succeeded"
    assert run.stats["records"] > 0
    assert _count(clean_db, raw_object) == 1
    assert _count(clean_db, listing) > 0
    assert _count(clean_db, classification) > 0  # post-fetch hooks ran


def test_collect_failing_job_exits_1_and_records_the_run(clean_db: Engine) -> None:
    @register_job("cli-test-failing", source="rema", post_fetch=False)
    def _job(ctx: JobContext) -> None:
        raise RuntimeError("boom")

    try:
        result = runner.invoke(app, ["collect", "cli-test-failing"])
    finally:
        unregister_job("cli-test-failing")
    assert result.exit_code == 1
    assert "RuntimeError: boom" in result.output
    with clean_db.connect() as conn:
        row = conn.execute(select(fetch_run.c.status, fetch_run.c.error)).one()
    assert row.status == "failed"
    assert row.error == "RuntimeError: boom"


def test_collect_degraded_run_exits_3(monkeypatch: pytest.MonkeyPatch) -> None:
    def degraded(name: str) -> RunResult:
        return RunResult(run_id=uuid4(), job=name, status="degraded", message="records dropped")

    monkeypatch.setattr("foodcatch.cli.run_job", degraded)
    result = runner.invoke(app, ["collect", "rema-products"])
    assert result.exit_code == EXIT_DEGRADED
    assert "records dropped" in result.output


def test_degraded_exit_code_constant() -> None:
    assert EXIT_DEGRADED not in (0, 1, 2)


# ------------------------------------------------------------------- reclassify / deals
def test_reclassify_and_deals_recompute_on_empty_database(clean_db: Engine) -> None:
    result = runner.invoke(app, ["reclassify"])
    assert result.exit_code == 0, result.output
    assert "Reclassified 0 listings; 0 deals recomputed." in result.output
    result = runner.invoke(app, ["deals", "recompute"])
    assert result.exit_code == 0
    assert "Recomputed 0 deals" in result.output


def test_reclassify_after_collect(clean_db: Engine, rema_page: dict[str, Any]) -> None:
    with respx.mock() as router:
        router.get(f"{REMA_BASE_URL}/products").respond(200, json=rema_page)
        assert runner.invoke(app, ["collect", "rema-products"]).exit_code == 0
    listings = _count(clean_db, listing)

    result = runner.invoke(app, ["reclassify"])
    assert result.exit_code == 0, result.output
    assert f"Reclassified {listings} listings" in result.output


# ---------------------------------------------------------------------------- reprocess
def test_reprocess_validates_arguments() -> None:
    assert runner.invoke(app, ["reprocess", "--source", "nope"]).exit_code == 2
    result = runner.invoke(
        app, ["reprocess", "--source", "tjek", "--since", "2026-11-02", "--until", "2026-11-01"]
    )
    assert result.exit_code == 2
    assert "--until" in result.output


def test_reprocess_runs(clean_db: Engine) -> None:
    result = runner.invoke(
        app, ["reprocess", "--source", "tjek", "--since", "2026-11-01", "--until", "2026-11-08"]
    )
    assert result.exit_code == 0, result.output
    assert "Reprocessed 0 raw objects" in result.output


# ------------------------------------------------------------------------- raw reindex
def test_raw_reindex_then_reprocess_restores_a_lost_database(
    clean_db: Engine, cli_raw_store: LocalRawStore, rema_page: dict[str, Any]
) -> None:
    # An object in the raw store whose database rows are gone (e.g. after a restore).
    run_id = uuid4()
    key = raw_key("rema", "products", NOW, run_id, 0)
    cli_raw_store.put(key, json.dumps(rema_page).encode())

    dry = runner.invoke(app, ["raw", "reindex", "--source", "rema", "--dry-run"])
    assert dry.exit_code == 0, dry.output
    assert "1 would be indexed" in dry.output
    assert _count(clean_db, raw_object) == 0

    result = runner.invoke(app, ["raw", "reindex"])
    assert result.exit_code == 0, result.output
    assert "1 indexed" in result.output
    assert "1 placeholder fetch runs created" in result.output
    with clean_db.connect() as conn:
        run = conn.execute(select(fetch_run).where(fetch_run.c.id == run_id)).one()
        obj = conn.execute(select(raw_object)).one()
    assert (run.job, run.source, run.status) == (REINDEX_JOB, "rema", "succeeded")
    assert (obj.storage_key, obj.endpoint, obj.params) == (key, "products", {"reindexed": True})

    again = runner.invoke(app, ["raw", "reindex", "--source", "rema"])
    assert "0 indexed, 1 already indexed" in again.output

    replay = runner.invoke(app, ["reprocess", "--source", "rema"])
    assert replay.exit_code == 0, replay.output
    assert "Reprocessed 1 raw objects" in replay.output
    assert _count(clean_db, listing) > 0


def test_raw_reindex_rejects_unknown_source() -> None:
    assert runner.invoke(app, ["raw", "reindex", "--source", "nope"]).exit_code == 2


# ------------------------------------------------------------------------------- review
@pytest.fixture
def review_item_id(clean_db: Engine) -> int:
    with clean_db.begin() as conn:
        run_id = conn.execute(
            insert(fetch_run)
            .values(job="cli-test", source="tjek", status="succeeded")
            .returning(fetch_run.c.id)
        ).scalar_one()
        object_id = conn.execute(
            insert(raw_object)
            .values(
                fetch_run_id=run_id,
                source="tjek",
                endpoint="offers",
                storage_key=f"cli-test/{uuid4()}",
                sha256="x",
                bytes=1,
            )
            .returning(raw_object.c.id)
        ).scalar_one()
        listing_id = conn.execute(
            insert(listing)
            .values(
                source="tjek",
                source_item_id="o1",
                chain_id="netto",
                kind="offer",
                title="Mælk",
                price=10,
                valid_from=NOW,
                raw_object_id=object_id,
            )
            .returning(listing.c.id)
        ).scalar_one()
        return conn.execute(
            insert(review_item)
            .values(listing_id=listing_id, reason="unknown_key_attribute")
            .returning(review_item.c.id)
        ).scalar_one()


def test_review_list_and_resolve(review_item_id: int) -> None:
    listed = runner.invoke(app, ["review", "list"])
    assert listed.exit_code == 0, listed.output
    assert "Mælk" in listed.output
    assert "1 item(s)." in listed.output

    resolved = runner.invoke(
        app, ["review", "resolve", str(review_item_id), "--status", "accepted", "--note", "ok"]
    )
    assert resolved.exit_code == 0, resolved.output
    assert f"Review item {review_item_id} resolved as accepted." in resolved.output

    assert "0 item(s)." in runner.invoke(app, ["review", "list"]).output
    accepted = runner.invoke(app, ["review", "list", "--status", "accepted"])
    assert "[ok]" in accepted.output


def test_review_resolve_errors(review_item_id: int) -> None:
    unknown = runner.invoke(app, ["review", "resolve", "999999", "--status", "fixed"])
    assert unknown.exit_code == 1
    assert "No review item 999999" in unknown.output
    reopen = runner.invoke(app, ["review", "resolve", str(review_item_id), "--status", "open"])
    assert reopen.exit_code == 2


def test_review_list_rejects_unknown_reason_and_status() -> None:
    assert runner.invoke(app, ["review", "list", "--reason", "nope"]).exit_code == 2
    assert runner.invoke(app, ["review", "list", "--status", "nope"]).exit_code == 2


def test_tests_never_reach_the_network(clean_db: Engine) -> None:
    """The conftest guard turns any real outbound connection into an error."""
    with clean_db.connect() as conn:  # the database (loopback / libpq) still works
        assert conn.execute(text("SELECT 1")).scalar_one() == 1
    result = runner.invoke(app, ["collect", "rema-products"])  # no respx mock
    assert result.exit_code == 1
    assert "network" in result.output
