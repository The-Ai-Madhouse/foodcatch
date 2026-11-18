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
from structlog.testing import capture_logs

from foodcatch.config import ConfigError, Settings
from foodcatch.db.tables import (
    fetch_run,
    listing,
    product,
    product_reference_price,
    raw_object,
    store,
)
from foodcatch.geo import haversine_km
from foodcatch.jobs.runner import RunResult, run_job
from foodcatch.jobs.salling import MAX_FAILED_CALLS
from foodcatch.sources import SourceHTTPError
from foodcatch.sources.salling import BASE_URL
from foodcatch.storage.raw import LocalRawStore

API_KEY = "test-key"
HVIDOVRE = "7fd81b2b-219b-4795-a561-c1a9d3fb28d1"
VANLOESE = "0b52d54b-66e1-4d8c-a4a4-e243b5120946"
OESTERBRO = "e1ed4932-4bef-4220-ac59-211b3b561e57"
BILKA_TILST = "efba0457-090e-4132-81ba-c72b4c8e7fee"
STORES_URL = f"{BASE_URL}/v2/stores"
GEO_URL = f"{BASE_URL}/v1/food-waste/"
GEO_REACH_KM = 20
CPH_STORES = {HVIDOVRE, VANLOESE, OESTERBRO}  # the default region (Copenhagen)

type FixtureBytes = Callable[[str], bytes]
type Responder = Callable[[httpx.Request], httpx.Response]


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
def geo_answer(fixture_bytes: FixtureBytes) -> Responder:
    """The mocked geo query (see :func:`api`)."""
    return _geo_answer(fixture_bytes)


@pytest.fixture
def api(fixture_bytes: FixtureBytes, geo_answer: Responder) -> Iterator[respx.MockRouter]:
    """Mocked Salling API: two store pages and the food-waste geo query.

    The geo query answers like Salling: the stores near the point, nearest first - here every
    fixture store within :data:`GEO_REACH_KM`. Vanløse has no clearances and is never listed.
    """
    with respx.mock(assert_all_called=False) as router:
        stores = router.get(STORES_URL, name="stores")
        stores.side_effect = _stores_by_brand(fixture_bytes)
        router.get(GEO_URL, name="geo").side_effect = geo_answer
        yield router


def _in_turn(*responders: Responder) -> Responder:
    """A responder answering the n-th request with the n-th responder."""
    queue = iter(responders)
    return lambda request: next(queue)(request)


def _geo_answer(fixture_bytes: FixtureBytes) -> Responder:
    bodies: list[dict[str, Any]] = [
        json.loads(fixture_bytes(f"salling/{name}.json"))
        for name in (
            "food_waste_netto_hvidovre",
            "food_waste_netto_oesterbro",
            "food_waste_bilka_tilst",
        )
    ]

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {API_KEY}"
        assert request.url.params["radius"] == "100"
        lat, lon = (float(v) for v in request.url.params["geo"].split(","))

        def distance(body: dict[str, Any]) -> float:
            store_lon, store_lat = body["store"]["coordinates"]
            return haversine_km(lat, lon, store_lat, store_lon)

        near = sorted((b for b in bodies if distance(b) <= GEO_REACH_KM), key=distance)
        return httpx.Response(200, json=near)

    return respond


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


def _with_budget(settings: Settings, calls: int) -> Settings:
    return settings.model_copy(update={"salling_food_waste_max_calls": calls})


def _checked_at(engine: Engine) -> dict[str, Any]:
    with engine.connect() as conn:
        return dict(
            conn.execute(select(store.c.source_store_id, store.c.food_waste_checked_at)).all()
        )


def _started_at(engine: Engine, result: RunResult) -> Any:
    with engine.connect() as conn:
        return conn.execute(
            select(fetch_run.c.started_at).where(fetch_run.c.id == result.run_id)
        ).scalar_one()


def _geo_points(api: respx.MockRouter) -> list[str]:
    return [call.request.url.params["geo"] for call in api["geo"].calls]


def test_food_waste_job_bootstraps_stores_and_tiles(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    result = run("salling-food-waste")

    assert result.status == "succeeded"
    assert result.stats["stores_bootstrapped"] == 4
    assert result.stats["salling_calls"] == 3 + 2  # store pages + geo queries
    assert result.stats["call_budget"] == 25
    # 1st query at Østerbro returns Østerbro + Hvidovre; Vanløse (between them, no clearances)
    # is inferred. The 2nd query covers Bilka Tilst (Aarhus, outside the region).
    assert result.stats["geo_calls"] == 2
    assert _geo_points(api)[0] == "55.714340,12.577876"
    assert result.stats["stores_inferred_absent"] == 1
    assert result.stats["region_stores"] == result.stats["region_stores_covered"] == 3
    assert result.stats["national_stores"] == result.stats["national_stores_covered"] == 1
    assert result.stats["stores_covered"] == 4
    assert result.stats["region_clearances"] == 6 + 4
    assert result.stats["quality"]["metric"] == "region_clearances"
    # per-store ingest as before: records are clearances only (store pages do not count)
    assert result.stats["records"] == 6 + 4 + 5
    assert result.stats["clearances_in_region"] == 10
    assert result.stats["clearances_outside_region"] == 5
    assert result.stats["raw_objects"] == 3 + 2
    assert "quota_exhausted" not in result.stats
    assert "budget_exhausted" not in result.stats
    assert _count(clean_db, listing, listing.c.source == "salling_food_waste") == 10
    assert _count(clean_db, product) == 6 + 2 + 3  # GTINs; two are in both Netto stores
    assert _count(clean_db, product_reference_price) == 11  # one per (product, chain)

    geo = [r for r in _raw_objects(clean_db) if r["endpoint"] == "food-waste-geo"]
    assert [r["params"] for r in geo] == [
        {"geo": "55.714340,12.577876", "radius": 100},
        {"geo": "56.182413,10.104849", "radius": 100},
    ]
    assert all(API_KEY not in json.dumps(r["params"]) for r in geo)
    started = _started_at(clean_db, result)
    assert set(_checked_at(clean_db).values()) == {started}  # rotation state persisted


def test_food_waste_job_rerun_is_idempotent(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    run("salling-food-waste")
    with clean_db.connect() as conn:
        before = conn.execute(select(listing.c.id, listing.c.price).order_by(listing.c.id)).all()
    second = run("salling-food-waste")

    assert second.status == "succeeded"
    assert "stores_bootstrapped" not in second.stats  # stores are known now
    assert second.stats["salling_calls"] == 2
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
    assert set(_checked_at(clean_db).values()) == {_started_at(clean_db, second)}


def test_food_waste_job_respects_the_call_budget(
    run: Callable[..., RunResult],
    api: respx.MockRouter,
    clean_db: Engine,
    job_settings: Settings,
) -> None:
    run("salling-stores")
    first = run("salling-food-waste", _with_budget(job_settings, 1))

    # the region comes first and is complete, so the run succeeds
    assert first.status == "succeeded"
    assert api["geo"].call_count == 1
    assert first.stats["salling_calls"] == 1
    assert first.stats["budget_exhausted"] is True
    assert first.stats["region_stores_covered"] == 3
    assert first.stats["national_stores_covered"] == 0
    checked = _checked_at(clean_db)
    assert checked[BILKA_TILST] is None  # not covered: first in line next time
    assert {checked[s] for s in CPH_STORES} == {_started_at(clean_db, first)}

    second = run("salling-food-waste", _with_budget(job_settings, 2))

    assert second.status == "succeeded"
    assert second.stats["national_stores_covered"] == 1
    assert _checked_at(clean_db)[BILKA_TILST] == _started_at(clean_db, second)


def test_food_waste_job_budget_includes_the_store_bootstrap(
    run: Callable[..., RunResult], api: respx.MockRouter, job_settings: Settings
) -> None:
    result = run("salling-food-waste", _with_budget(job_settings, 2))

    assert result.status == "degraded"
    assert result.stats["salling_calls"] == 2
    assert api["geo"].call_count == 0
    assert "call budget of 2 used up" in result.message


def test_food_waste_job_stops_at_429_and_degrades_without_region(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    run("salling-stores")
    api["geo"].side_effect = None
    api["geo"].respond(429, headers={"Retry-After": "3600"}, text="rate limited")

    with capture_logs() as logs:
        result = run("salling-food-waste")

    assert api["geo"].call_count == 1  # no retry, no sleeping it out
    assert result.status == "degraded"
    assert result.stats["quota_exhausted"] is True
    assert result.stats["region_stores_covered"] == 0
    assert "Salling quota exhausted (HTTP 429)" in result.message
    assert "region not fully covered: 0 of 3 stores" in result.message
    quota = [e for e in logs if e["event"] == "salling.quota_exhausted"]
    assert len(quota) == 1
    assert quota[0]["retry_after"] == "3600"
    assert API_KEY not in json.dumps(logs, default=str)
    assert set(_checked_at(clean_db).values()) == {None}
    with clean_db.connect() as conn:
        status, error = conn.execute(
            select(fetch_run.c.status, fetch_run.c.error).where(fetch_run.c.id == result.run_id)
        ).one()
    assert status == "degraded"
    assert "quota exhausted" in error


def test_food_waste_job_429_after_the_region_still_succeeds(
    run: Callable[..., RunResult],
    api: respx.MockRouter,
    geo_answer: Responder,
    clean_db: Engine,
) -> None:
    run("salling-stores")
    api["geo"].side_effect = _in_turn(
        geo_answer, lambda _request: httpx.Response(429, headers={"Retry-After": "60"})
    )

    result = run("salling-food-waste")

    assert result.status == "succeeded"
    assert api["geo"].call_count == 2
    assert result.stats["quota_exhausted"] is True
    assert result.stats["region_stores_covered"] == 3
    assert result.stats["national_stores_covered"] == 0
    assert _count(clean_db, listing, listing.c.source == "salling_food_waste") == 10
    assert _checked_at(clean_db)[BILKA_TILST] is None


def test_food_waste_quality_metric_ignores_national_rotation(
    run: Callable[..., RunResult], api: respx.MockRouter, job_settings: Settings
) -> None:
    full = run("salling-food-waste")
    region_only = run("salling-food-waste", _with_budget(job_settings, 1))

    assert full.stats["records"] == 15
    assert region_only.stats["records"] == 10  # fewer stores, fewer clearances overall ...
    assert region_only.status == "succeeded"  # ... but the region is what is compared
    assert region_only.stats["quality"] == {
        "metric": "region_clearances",
        "current": 10.0,
        "previous": 10.0,
        "status": "succeeded",
        "message": "",
    }


def test_food_waste_quality_metric_detects_a_drop_in_the_region(
    run: Callable[..., RunResult], api: respx.MockRouter
) -> None:
    run("salling-food-waste")
    api["geo"].side_effect = None
    oesterbro_without_clearances = {
        "store": {
            "id": OESTERBRO,
            "name": "Netto Østerbrogade Kb",
            "brand": "netto",
            "coordinates": [12.5778762, 55.7143399],
        },
        "clearances": [],
    }
    api["geo"].respond(200, json=[oesterbro_without_clearances])

    result = run("salling-food-waste")

    assert result.status == "degraded"
    assert result.stats["region_clearances"] == 0
    assert "region_clearances dropped 100%" in result.message


def test_food_waste_job_retries_a_failed_target_once(
    run: Callable[..., RunResult], api: respx.MockRouter, geo_answer: Responder
) -> None:
    run("salling-stores")
    api["geo"].side_effect = _in_turn(lambda _request: httpx.Response(503), geo_answer, geo_answer)

    result = run("salling-food-waste")

    assert result.status == "succeeded"
    assert result.stats["geo_calls_failed"] == 1
    assert result.stats["geo_calls"] == 2
    assert result.stats["salling_calls"] == 3
    assert _geo_points(api)[0] == _geo_points(api)[1]  # same target again


def test_food_waste_job_stops_after_repeated_failures(
    run: Callable[..., RunResult], api: respx.MockRouter
) -> None:
    run("salling-stores")
    api["geo"].side_effect = httpx.ConnectError("down")

    result = run("salling-food-waste")

    assert api["geo"].call_count == MAX_FAILED_CALLS
    assert result.status == "degraded"
    assert result.stats["geo_calls_failed"] == MAX_FAILED_CALLS
    assert f"{MAX_FAILED_CALLS} requests failed" in result.message


def test_food_waste_job_fails_on_auth_error(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine
) -> None:
    run("salling-stores")
    api["geo"].side_effect = None
    api["geo"].respond(401, json={"error": "unauthorized"})
    with pytest.raises(SourceHTTPError):
        run("salling-food-waste")
    with clean_db.connect() as conn:
        statuses = conn.execute(select(fetch_run.c.job, fetch_run.c.status)).all()
    assert ("salling-food-waste", "failed") in statuses
    assert _count(clean_db, listing) == 0  # the run's transaction was rolled back
    assert set(_checked_at(clean_db).values()) == {None}


def test_raw_store_layout(
    run: Callable[..., RunResult], api: respx.MockRouter, clean_db: Engine, tmp_path: Path
) -> None:
    result = run("salling-food-waste")
    keys = [r["storage_key"] for r in _raw_objects(clean_db)]
    assert all(k.startswith(("salling/stores/", "salling/food-waste-geo/")) for k in keys)
    assert all(f"/{result.run_id}/" in k for k in keys)
    assert all((tmp_path / "raw" / k).is_file() for k in keys)
