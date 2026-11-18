"""Salling jobs end to end: respx-mocked API, real raw store and test database."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from pydantic import SecretStr
from sqlalchemy import Engine, func, select

from foodcatch.config import ConfigError, Settings
from foodcatch.db.tables import (
    fetch_run,
    listing,
    product,
    product_reference_price,
    raw_object,
    store,
)
from foodcatch.jobs.runner import RunResult, run_job
from foodcatch.jobs.salling import SallingFetchError, max_failed_stores
from foodcatch.sources import SourceHTTPError
from foodcatch.sources.salling import BASE_URL
from foodcatch.storage.raw import LocalRawStore

API_KEY = "test-key"
HVIDOVRE = "7fd81b2b-219b-4795-a561-c1a9d3fb28d1"
VANLOESE = "0b52d54b-66e1-4d8c-a4a4-e243b5120946"
OESTERBRO = "e1ed4932-4bef-4220-ac59-211b3b561e57"
BILKA_TILST = "efba0457-090e-4132-81ba-c72b4c8e7fee"
STORES_URL = f"{BASE_URL}/v2/stores"

type FixtureBytes = Callable[[str], bytes]


def _food_waste_url(store_id: str) -> str:
    return f"{BASE_URL}/v1/food-waste/{store_id}"


@pytest.fixture
def job_settings(settings: Settings) -> Settings:
    return settings.model_copy(update={"salling_api_key": SecretStr(API_KEY)})


@pytest.fixture
def run(
    clean_db: Engine, job_settings: Settings, raw_store: LocalRawStore, http_client: httpx.Client
) -> Callable[..., RunResult]:
    def runner(name: str, settings: Settings | None = None) -> RunResult:
        return run_job(
            name,
            settings=settings or job_settings,
            engine=clean_db,
            raw_store=raw_store,
            http=http_client,
            hooks=(),
        )

    return runner


@pytest.fixture
def api(fixture_bytes: FixtureBytes) -> Iterator[respx.MockRouter]:
    """Mocked Salling API: two store pages, food waste for 3 stores, 404 for Vanløse."""
    with respx.mock(assert_all_called=False) as router:
        stores = router.get(STORES_URL, name="stores")
        stores.side_effect = _stores_by_brand(fixture_bytes)
        for store_id, name in (
            (HVIDOVRE, "food_waste_netto_hvidovre"),
            (OESTERBRO, "food_waste_netto_oesterbro"),
            (BILKA_TILST, "food_waste_bilka_tilst"),
        ):
            router.get(_food_waste_url(store_id), name=store_id).respond(
                200, content=fixture_bytes(f"salling/{name}.json")
            )
        router.get(_food_waste_url(VANLOESE), name=VANLOESE).respond(404)
        yield router


def _stores_by_brand(fixture_bytes: FixtureBytes) -> Callable[[httpx.Request], httpx.Response]:
    pages = {
        "netto": fixture_bytes("salling/stores_netto_page1.json"),
        "bilka": fixture_bytes("salling/stores_bilka_page1.json"),
        "foetex": b"[]",
    }

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {API_KEY}"
        assert request.url.params["page"] == "1"  # every fixture page is short
        return httpx.Response(200, content=pages[request.url.params["brand"]])

    return respond


def _count(engine: Engine, table: Any, *where: Any) -> int:
    with engine.connect() as conn:
        return conn.execute(select(func.count()).select_from(table).where(*where)).scalar_one()


def _raw_objects(engine: Engine) -> list[dict[str, Any]]:
    with engine.connect() as conn:
        rows = conn.execute(select(raw_object).order_by(raw_object.c.storage_key)).mappings()
        return [dict(r) for r in rows]


# --------------------------------------------------------------------------- salling-stores


def test_salling_stores_job(
    run: Callable[..., RunResult],
    api: respx.MockRouter,
    clean_db: Engine,
    raw_store: LocalRawStore,
    fixture_bytes: FixtureBytes,
) -> None:
    result = run("salling-stores")

    assert result.status == "succeeded"
    assert result.stats["records"] == 4
    assert result.stats["raw_objects"] == 3
    assert api["stores"].call_count == 3
    with clean_db.connect() as conn:
        chains = dict(conn.execute(select(store.c.source_store_id, store.c.chain_id)).all())
    assert chains == {
        HVIDOVRE: "netto",
        VANLOESE: "netto",
        OESTERBRO: "netto",
        BILKA_TILST: "bilka",
    }

    raws = _raw_objects(clean_db)
    assert {r["endpoint"] for r in raws} == {"stores"}
    assert {r["params"]["brand"] for r in raws} == {"netto", "foetex", "bilka"}
    assert all(API_KEY not in json.dumps(r["params"]) for r in raws)
    # the raw store keeps the body unchanged (including the opening hours)
    netto = next(r for r in raws if r["params"]["brand"] == "netto")
    assert raw_store.get(netto["storage_key"]) == fixture_bytes("salling/stores_netto_page1.json")


def test_salling_stores_job_refreshes_last_seen(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    run("salling-stores")
    with clean_db.connect() as conn:
        first = conn.execute(select(func.max(store.c.last_seen_at))).scalar_one()
    second = run("salling-stores")

    assert second.status == "succeeded"
    assert _count(clean_db, store) == 4
    with clean_db.connect() as conn:
        assert conn.execute(select(func.min(store.c.last_seen_at))).scalar_one() > first


def test_salling_job_requires_api_key(
    run: Callable[..., RunResult], settings: Settings, clean_db: Engine
) -> None:
    with pytest.raises(ConfigError, match="SALLING_API_KEY"):
        run("salling-stores", settings)
    with clean_db.connect() as conn:
        assert conn.execute(select(fetch_run.c.status)).scalar_one() == "failed"


# --------------------------------------------------------------------------- salling-food-waste


def test_food_waste_job_bootstraps_stores_and_ingests(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    result = run("salling-food-waste")

    assert result.status == "succeeded"
    # records are clearances only (the bootstrap store pages do not count)
    assert result.stats["records"] == 6 + 4 + 5
    assert result.stats["stores_bootstrapped"] == 4
    assert result.stats["stores_fetched"] == 3
    assert result.stats["stores_not_found"] == 1
    assert result.stats["clearances_in_region"] == 10  # Hvidovre + Østerbro (Copenhagen)
    assert result.stats["clearances_outside_region"] == 5  # Bilka Tilst (Aarhus)
    assert result.stats["raw_objects"] == 3 + 3
    assert _count(clean_db, store) == 4
    assert _count(clean_db, listing, listing.c.source == "salling_food_waste") == 10
    assert _count(clean_db, product) == 6 + 2 + 3  # GTINs; two are in both Netto stores
    assert _count(clean_db, product_reference_price) == 11  # one per (product, chain)
    food_waste = [r for r in _raw_objects(clean_db) if r["endpoint"] == "food-waste"]
    assert {r["params"]["store_id"] for r in food_waste} == {HVIDOVRE, OESTERBRO, BILKA_TILST}


def test_food_waste_job_rerun_is_idempotent(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    run("salling-food-waste")
    with clean_db.connect() as conn:
        before = conn.execute(select(listing.c.id, listing.c.price).order_by(listing.c.id)).all()
    second = run("salling-food-waste")

    assert second.status == "succeeded"
    assert "stores_bootstrapped" not in second.stats  # stores are known now
    assert second.stats["records"] == 15
    assert second.stats.get("listings_new", 0) == 0
    assert second.stats["listings_unchanged"] == 10
    assert second.stats["reference_prices_extended"] == 11
    assert second.stats.get("reference_prices_new", 0) == 0
    with clean_db.connect() as conn:
        after = conn.execute(select(listing.c.id, listing.c.price).order_by(listing.c.id)).all()
        observations = set(conn.execute(select(product_reference_price.c.observations)).scalars())
        # every listing was seen by the latest run (api.food_waste_near relies on it)
        latest = conn.execute(select(func.max(fetch_run.c.started_at))).scalar_one()
        stale = conn.execute(
            select(func.count()).select_from(listing).where(listing.c.last_seen_at < latest)
        ).scalar_one()
    assert after == before
    assert observations == {2}
    assert stale == 0


def test_food_waste_job_tolerates_a_failing_store(
    run: Callable[..., RunResult], api: respx.MockRouter
) -> None:
    api[OESTERBRO].respond(503)
    result = run("salling-food-waste")

    assert result.status == "succeeded"
    assert result.stats["stores_failed"] == 1
    assert result.stats["records"] == 6 + 5


def test_food_waste_job_fails_on_auth_error(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    run("salling-stores")
    api[HVIDOVRE].respond(401, json={"error": "unauthorized"})
    with pytest.raises(SourceHTTPError):
        run("salling-food-waste")
    with clean_db.connect() as conn:
        statuses = conn.execute(select(fetch_run.c.job, fetch_run.c.status)).all()
    assert ("salling-food-waste", "failed") in statuses
    assert _count(clean_db, listing) == 0  # the run's transaction was rolled back


def test_food_waste_job_fails_when_too_many_stores_fail(
    run: Callable[..., RunResult], api: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("foodcatch.jobs.salling.FAILED_STORES_MIN", 1)
    for store_id in (HVIDOVRE, OESTERBRO):
        api[store_id].respond(500)
    with pytest.raises(SallingFetchError, match="2 of 4 stores failed"):
        run("salling-food-waste")


@pytest.mark.parametrize(("total", "allowed"), [(0, 5), (10, 5), (100, 5), (600, 30)])
def test_max_failed_stores(total: int, allowed: int) -> None:
    assert max_failed_stores(total) == allowed


def test_raw_store_layout(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine, tmp_path: Path
) -> None:
    result = run("salling-food-waste")
    keys = [r["storage_key"] for r in _raw_objects(clean_db)]
    assert all(k.startswith(("salling/stores/", "salling/food-waste/")) for k in keys)
    assert all(f"/{result.run_id}/" in k for k in keys)
    assert all((tmp_path / "raw" / k).is_file() for k in keys)
