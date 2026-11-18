"""Tjek jobs end to end: respx-mocked API, real Postgres, local raw store."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import respx
from sqlalchemy import Engine, func, select

import foodcatch.jobs  # noqa: F401  (registers the jobs)
from foodcatch.config import Settings
from foodcatch.db.tables import chain, fetch_run, listing, raw_object, store
from foodcatch.http import create_client
from foodcatch.jobs.runner import RunResult, run_job
from foodcatch.jobs.tjek import TjekJobError, tracked_dealers
from foodcatch.sources.tjek import BASE_URL
from foodcatch.storage.raw import LocalRawStore

pytestmark = pytest.mark.db

NETTO = "9ba51"
SUPERBRUGSEN = "0b1e8"
LIDL = "71c90"


@pytest.fixture
def http() -> Iterator[httpx.Client]:
    client = create_client(sleep=lambda _seconds: None)
    yield client
    client.close()


@pytest.fixture
def run(
    clean_db: Engine, settings: Settings, raw_store: LocalRawStore, http: httpx.Client
) -> Callable[[str], RunResult]:
    def runner(job: str) -> RunResult:
        return run_job(
            job, settings=settings, engine=clean_db, raw_store=raw_store, http=http, hooks=()
        )

    return runner


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S+0000")


def _catalog(cid: str, label: str, start: timedelta, end: timedelta) -> dict[str, Any]:
    now = datetime.now(UTC)
    return {
        "id": cid,
        "label": label,
        "dealer_id": NETTO,
        "run_from": _iso(now + start),
        "run_till": _iso(now + end),
        "offer_count": 10,
        "page_count": 10,
    }


def test_tracked_dealers(clean_db: Engine) -> None:
    with clean_db.connect() as conn:
        dealers = dict(tracked_dealers(conn))
        n_tracked = conn.execute(
            select(func.count()).select_from(chain).where(chain.c.tjek_dealer_id.is_not(None))
        ).scalar_one()
    assert dealers["netto"] == NETTO
    assert dealers["365discount"] == "DWZE1w"
    assert len(dealers) == n_tracked == 11


@respx.mock
def test_tjek_stores_job(
    run: Callable[[str], RunResult],
    clean_db: Engine,
    raw_store: LocalRawStore,
    fixture_bytes: Callable[[str], bytes],
) -> None:
    netto = fixture_bytes("tjek/stores_netto.json")

    def respond(request: httpx.Request) -> httpx.Response:
        dealer = request.url.params["dealer_ids"]
        if dealer == NETTO:
            return httpx.Response(200, content=netto)
        if dealer == LIDL:
            return httpx.Response(404, json={"message": "not found"})
        return httpx.Response(200, json=[])

    respx.get(f"{BASE_URL}/stores").mock(side_effect=respond)
    result = run("tjek-stores")
    assert result.status == "succeeded"

    with clean_db.connect() as conn:
        (row,) = conn.execute(select(fetch_run)).all()
        assert row.stats["records"] == 4
        assert row.stats["dealer_errors"] == 1
        assert row.stats["raw_objects"] == 10  # 11 dealers, one failed
        assert conn.execute(select(func.count()).select_from(store)).scalar_one() == 4
        keys = conn.execute(select(raw_object.c.storage_key, raw_object.c.params)).all()
    netto_key = next(k for k, p in keys if p["dealer_ids"] == NETTO)
    assert raw_store.get(netto_key) == netto  # stored unchanged


@respx.mock
def test_tjek_stores_job_fails_when_every_dealer_fails(
    run: Callable[[str], RunResult], clean_db: Engine
) -> None:
    respx.get(f"{BASE_URL}/stores").mock(return_value=httpx.Response(403, json={}))
    with pytest.raises(TjekJobError, match="all 11 dealers failed"):
        run("tjek-stores")
    with clean_db.connect() as conn:
        assert conn.execute(select(fetch_run.c.status)).scalar_one() == "failed"


@respx.mock
def test_a_catalog_without_response_does_not_discard_the_others(
    run: Callable[[str], RunResult], clean_db: Engine, load_fixture: Callable[[str], Any]
) -> None:
    """Regression (finding R4): a timeout on one catalog must not fail the whole run."""
    day = timedelta(days=1)
    catalogs = [
        _catalog("ok", "Netto uge 47", -2 * day, 5 * day),
        _catalog("slow", "Netto uge 48", 3 * day, 10 * day),
    ]
    offers = load_fixture("tjek/offers_netto.json")

    def catalogs_for(request: httpx.Request) -> httpx.Response:
        if request.url.params["dealer_ids"] == NETTO:
            return httpx.Response(200, json=catalogs)
        return httpx.Response(200, json=[])

    def offers_for(request: httpx.Request) -> httpx.Response:
        if request.url.params["catalog_ids"] == "slow":
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(200, json=offers)

    respx.get(f"{BASE_URL}/catalogs").mock(side_effect=catalogs_for)
    respx.get(f"{BASE_URL}/offers").mock(side_effect=offers_for)

    result = run("tjek-offers")

    assert result.status == "succeeded"
    assert result.stats["catalog_errors"] == 1
    with clean_db.connect() as conn:
        assert conn.execute(select(func.count()).select_from(listing)).scalar_one() == len(offers)


@respx.mock
def test_tjek_offers_job(
    run: Callable[[str], RunResult], clean_db: Engine, load_fixture: Callable[[str], Any]
) -> None:
    day = timedelta(days=1)
    catalogs = [
        _catalog("current", "Netto uge 47", -2 * day, 5 * day),
        _catalog("upcoming", "Netto uge 48", 3 * day, 10 * day),
        _catalog("nonfood", "Netto Nonfood uge 47", -2 * day, 5 * day),
        _catalog("expired", "Netto uge 45", -10 * day, -3 * day),
        _catalog("far", "Netto jul", 20 * day, 30 * day),
    ]
    offers = load_fixture("tjek/offers_netto.json")

    def catalogs_for(request: httpx.Request) -> httpx.Response:
        dealer = request.url.params["dealer_ids"]
        if dealer == NETTO:
            return httpx.Response(200, json=catalogs)
        if dealer == SUPERBRUGSEN:
            return httpx.Response(500, json={})
        return httpx.Response(200, json=[])

    def offers_for(request: httpx.Request) -> httpx.Response:
        catalog_id = request.url.params["catalog_ids"]
        if catalog_id == "current":
            return httpx.Response(200, json=offers)
        if catalog_id == "upcoming":
            return httpx.Response(404, json={})
        raise AssertionError(f"catalog {catalog_id} must not be fetched")

    respx.get(f"{BASE_URL}/catalogs").mock(side_effect=catalogs_for)
    offers_route = respx.get(f"{BASE_URL}/offers").mock(side_effect=offers_for)

    result = run("tjek-offers")
    assert result.status == "succeeded"
    assert {c.request.url.params["catalog_ids"] for c in offers_route.calls} == {
        "current",
        "upcoming",
    }
    with clean_db.connect() as conn:
        stats = conn.execute(select(fetch_run.c.stats)).scalar_one()
        assert stats["records"] == len(offers)
        assert stats["catalogs_fetched"] == 2
        assert stats["catalogs_skipped_nonfood"] == 1
        assert stats["catalogs_skipped_period"] == 2
        assert stats["catalog_errors"] == 1
        assert stats["dealer_errors"] == 1
        assert stats["offers_inserted"] == len(offers)
        endpoints = conn.execute(select(raw_object.c.endpoint)).scalars().all()
        assert sorted(set(endpoints)) == ["catalogs", "offers"]
        assert endpoints.count("catalogs") == 10  # superbrugsen failed
        n_listings = conn.execute(select(func.count()).select_from(listing)).scalar_one()
        assert n_listings == len(offers)

    # a second identical run changes nothing but freshness
    second = run("tjek-offers")
    assert second.status == "succeeded"
    with clean_db.connect() as conn:
        stats = conn.execute(
            select(fetch_run.c.stats).where(fetch_run.c.id == second.run_id)
        ).scalar_one()
        assert stats["offers_unchanged"] == len(offers)
        assert stats.get("offers_inserted", 0) == 0
        assert conn.execute(select(func.count()).select_from(listing)).scalar_one() == n_listings
        raw_ids = set(conn.execute(select(listing.c.raw_object_id)).scalars())
        latest = set(
            conn.execute(
                select(raw_object.c.id).where(
                    raw_object.c.fetch_run_id == second.run_id, raw_object.c.endpoint == "offers"
                )
            ).scalars()
        )
    assert raw_ids == latest
    assert json.dumps(stats)  # stats stay JSON-serializable
