"""``off-enrich`` end to end: respx-mocked Open Food Facts, real raw store and test database."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import respx
from sqlalchemy import Engine, insert, select

from foodcatch.config import Settings
from foodcatch.db.tables import fetch_run, product, raw_object
from foodcatch.jobs.openfoodfacts import MAX_CONSECUTIVE_ERRORS
from foodcatch.jobs.runner import RunResult, run_job
from foodcatch.sources import SourceHTTPError
from foodcatch.sources.openfoodfacts import BASE_URL
from foodcatch.storage.raw import LocalRawStore

FOUND_EAN = "3017620422003"
MISSING_EAN = "5712345678908"
FRESH_EAN = "5700000000003"


@pytest.fixture
def run(
    clean_db: Engine, settings: Settings, raw_store: LocalRawStore, http_client: httpx.Client
) -> Callable[[], RunResult]:
    def runner() -> RunResult:
        return run_job(
            "off-enrich",
            settings=settings,
            engine=clean_db,
            raw_store=raw_store,
            http=http_client,
            hooks=(),
        )

    return runner


@pytest.fixture
def products(clean_db: Engine) -> None:
    with clean_db.begin() as conn:
        conn.execute(insert(product).values(ean=FOUND_EAN, name="NUTELLA"))
        conn.execute(insert(product).values(ean=MISSING_EAN, name="UKENDT"))
        conn.execute(
            insert(product).values(
                ean=FRESH_EAN, off_checked_at=datetime.now(UTC) - timedelta(days=1)
            )
        )


@pytest.fixture
def api(fixture_bytes: Callable[[str], bytes]) -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as router:
        router.get(f"{BASE_URL}/product/{FOUND_EAN}.json", name="found").respond(
            200, content=fixture_bytes("openfoodfacts/product_found.json")
        )
        router.get(f"{BASE_URL}/product/{MISSING_EAN}.json", name="missing").respond(
            404, content=fixture_bytes("openfoodfacts/product_not_found.json")
        )
        router.get(f"{BASE_URL}/product/{FRESH_EAN}.json", name="fresh").respond(500)
        yield router


def _products(engine: Engine) -> dict[str, dict[str, Any]]:
    with engine.connect() as conn:
        return {r["ean"]: dict(r) for r in conn.execute(select(product)).mappings()}


@pytest.mark.usefixtures("products")
def test_off_enrich_job(
    run: Callable[[], RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    result = run()

    assert result.status == "succeeded"
    assert result.stats["off_due"] == 2
    assert result.stats["off_found"] == 1
    assert result.stats["off_not_found"] == 1
    assert result.stats["raw_objects"] == 2
    assert not api["fresh"].called  # checked yesterday
    rows = _products(clean_db)
    assert rows[FOUND_EAN]["nutriscore_grade"] == "e"
    assert rows[FOUND_EAN]["off_checked_at"] is not None
    assert rows[MISSING_EAN]["off_checked_at"] is not None
    assert rows[MISSING_EAN]["nova_group"] is None
    with clean_db.connect() as conn:
        params = list(conn.execute(select(raw_object.c.params)).scalars())
    assert sorted(p["ean"] for p in params) == [FOUND_EAN, MISSING_EAN]

    # nothing is due any more: the next run makes no requests
    calls = api.calls.call_count
    second = run()
    assert second.stats["off_due"] == 0
    assert api.calls.call_count == calls


@pytest.mark.usefixtures("products")
def test_batch_size_is_configurable(
    run: Callable[[], RunResult], api: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OFF_BATCH_SIZE", "1")
    result = run()
    assert result.stats["off_due"] == 1
    assert api.calls.call_count == 1


def test_a_failing_lookup_is_skipped(
    run: Callable[[], RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    with clean_db.begin() as conn:
        conn.execute(insert(product).values(ean=FRESH_EAN))  # answers 500
        conn.execute(insert(product).values(ean=FOUND_EAN))
    result = run()

    assert result.status == "succeeded"
    assert result.stats["off_errors"] == 1
    assert result.stats["off_found"] == 1
    rows = _products(clean_db)
    assert rows[FRESH_EAN]["off_checked_at"] is None  # retried next run
    assert rows[FOUND_EAN]["off_checked_at"] is not None


def test_consecutive_failures_fail_the_run(run: Callable[[], RunResult], clean_db: Engine) -> None:
    eans = [f"57000000{i:05d}" for i in range(MAX_CONSECUTIVE_ERRORS + 2)]
    with clean_db.begin() as conn:
        conn.execute(insert(product).values([{"ean": e} for e in eans]))
    with respx.mock() as router:
        route = router.get(url__startswith=f"{BASE_URL}/product/").respond(503)
        with pytest.raises(SourceHTTPError):
            run()
    assert route.call_count == MAX_CONSECUTIVE_ERRORS * 5  # each lookup retried 5 times
    with clean_db.connect() as conn:
        assert conn.execute(select(fetch_run.c.status)).scalar_one() == "failed"
