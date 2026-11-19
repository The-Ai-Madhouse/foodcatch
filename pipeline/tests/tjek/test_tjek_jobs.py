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
from foodcatch.db.tables import chain, fetch_run, listing, raw_object, store, tjek_catalog_fetch
from foodcatch.http import create_client
from foodcatch.jobs.runner import RunResult, run_job
from foodcatch.jobs.tjek import (
    REFRESH_SLACK,
    TjekJobError,
    catalog_fingerprint,
    fetch_reason,
    tracked_dealers,
)
from foodcatch.sources.tjek import BASE_URL, TjekCatalog
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
) -> Callable[..., RunResult]:
    def runner(job: str, **overrides: Any) -> RunResult:
        return run_job(
            job,
            settings=settings.model_copy(update=overrides),
            engine=clean_db,
            raw_store=raw_store,
            http=http,
            hooks=(),
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
            return httpx.Response(200, json=[{**o, "catalog_id": catalog_id} for o in offers])
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

    # a second identical run fetches only the catalog lists: nothing changed, nothing is due
    second = run("tjek-offers")
    assert second.status == "succeeded"
    # only "upcoming" again: it failed before, so it is still new
    assert [c.request.url.params["catalog_ids"] for c in offers_route.calls[2:]] == ["upcoming"]
    with clean_db.connect() as conn:
        stats = conn.execute(
            select(fetch_run.c.stats).where(fetch_run.c.id == second.run_id)
        ).scalar_one()
        assert stats["catalogs_seen"] == 2
        assert stats["catalogs_skipped_unchanged"] == 1  # "current"
        assert stats["catalogs_fetched"] == 1
        assert stats["catalogs_fetched_new"] == 1
        assert stats["current_listings"] == len(offers)
        assert stats["quality"]["status"] == "succeeded"
        assert stats.get("offers_inserted", 0) == 0
        assert conn.execute(select(func.count()).select_from(listing)).scalar_one() == n_listings
        second_raw = conn.execute(
            select(raw_object.c.endpoint).where(raw_object.c.fetch_run_id == second.run_id)
        ).scalars()
        assert sorted(set(second_raw)) == ["catalogs"]
    assert json.dumps(stats)  # stats stay JSON-serializable


# ------------------------------------------------------------------ skipping unchanged catalogs

_NOW = datetime(2026, 11, 19, 4, 7, tzinfo=UTC)


def _model(**changes: Any) -> TjekCatalog:
    day = timedelta(days=1)
    return TjekCatalog.model_validate(
        {**_catalog("c1", "Netto uge 47", -2 * day, 5 * day), **changes}
    )


def test_fingerprint_follows_content_fields_only() -> None:
    base = _model()
    assert catalog_fingerprint(base) == catalog_fingerprint(_model())
    for changes in (
        {"offer_count": 11},
        {"page_count": 12},
        {"label": "Netto uge 47 (rettet)"},
        {"run_till": _iso(datetime.now(UTC) + timedelta(days=6))},
        {"publish": "2026-11-10T23:00:00+0000"},
        {"images": {"view": "https://example.test/p-replacement-1.webp"}},
    ):
        assert catalog_fingerprint(_model(**changes)) != catalog_fingerprint(base), changes
    assert catalog_fingerprint(_model(branding={"color": "fff"})) == catalog_fingerprint(base)


@pytest.mark.parametrize(
    ("state", "fingerprint", "days", "expected"),
    [
        (None, "a", 3, "new"),
        (("a", _NOW - timedelta(days=1)), "b", 3, "changed"),
        (("a", _NOW - timedelta(days=1)), "a", 3, None),
        (("a", _NOW - timedelta(days=3) + REFRESH_SLACK + timedelta(minutes=1)), "a", 3, None),
        # the daily run started a few minutes earlier than the one that fetched it
        (("a", _NOW - timedelta(days=3) + timedelta(minutes=5)), "a", 3, "refresh"),
        (("a", _NOW - timedelta(days=4)), "a", 3, "refresh"),
        (("a", _NOW - timedelta(minutes=1)), "a", 0, "refresh"),
    ],
)
def test_fetch_reason(
    state: tuple[str, datetime] | None, fingerprint: str, days: int, expected: str | None
) -> None:
    assert fetch_reason(state, fingerprint, _NOW, days) == expected


class _Tjek:
    """respx routes for one Netto catalog list; offers from the fixture for every catalog."""

    def __init__(self, catalogs: list[dict[str, Any]], offers: list[dict[str, Any]]) -> None:
        self.catalogs = catalogs
        self.netto_status = 200
        self.offers = offers
        self.catalog_route = respx.get(f"{BASE_URL}/catalogs").mock(side_effect=self._catalogs)
        self.offer_route = respx.get(f"{BASE_URL}/offers").mock(side_effect=self._offers)

    def _catalogs(self, request: httpx.Request) -> httpx.Response:
        if request.url.params["dealer_ids"] == NETTO:
            return httpx.Response(self.netto_status, json=self.catalogs)
        return httpx.Response(200, json=[])

    def _offers(self, request: httpx.Request) -> httpx.Response:
        catalog_id = request.url.params["catalog_ids"]
        offers = [
            {**o, "id": f"{catalog_id}-{o['id']}", "catalog_id": catalog_id} for o in self.offers
        ]
        return httpx.Response(200, json=offers)

    def fetched_since(self, start: int) -> list[str]:
        calls = self.offer_route.calls[start:]
        return sorted(c.request.url.params["catalog_ids"] for c in calls)


def _stats(engine: Engine, result: RunResult) -> dict[str, Any]:
    with engine.connect() as conn:
        return conn.execute(
            select(fetch_run.c.stats).where(fetch_run.c.id == result.run_id)
        ).scalar_one()


@respx.mock
def test_tjek_offers_skips_unchanged_catalogs(
    run: Callable[..., RunResult], clean_db: Engine, load_fixture: Callable[[str], Any]
) -> None:
    day = timedelta(days=1)
    tjek = _Tjek(
        [
            _catalog("a", "Netto uge 47", -2 * day, 5 * day),
            _catalog("b", "Netto uge 48", 3 * day, 10 * day),
        ],
        load_fixture("tjek/offers_netto.json")[:5],
    )

    # 1. first run: every catalog is new
    first = run("tjek-offers")
    stats = _stats(clean_db, first)
    assert tjek.fetched_since(0) == ["a", "b"]
    assert stats["catalogs_seen"] == 2
    assert stats["catalogs_fetched"] == stats["catalogs_fetched_new"] == 2
    assert stats["offer_pages_fetched"] == 2
    assert stats.get("catalogs_skipped_unchanged", 0) == 0
    with clean_db.connect() as conn:
        state = {r.catalog_id: r for r in conn.execute(select(tjek_catalog_fetch))}
    assert set(state) == {"a", "b"}
    assert state["a"].chain_id == "netto"
    assert state["a"].offer_count == 10
    assert state["a"].offers_fetched_at == first_started(clean_db, first)
    with clean_db.connect() as conn:
        seen_before = dict(conn.execute(select(listing.c.id, listing.c.last_seen_at)).all())

    # 2. unchanged catalogs: only the catalog lists are fetched, listings stay as they are
    calls = len(tjek.offer_route.calls)
    second = run("tjek-offers")
    stats = _stats(clean_db, second)
    assert second.status == "succeeded"
    assert tjek.fetched_since(calls) == []
    assert len(tjek.catalog_route.calls) == 2 * 11
    assert stats["catalogs_seen"] == stats["catalogs_skipped_unchanged"] == 2
    assert stats.get("catalogs_fetched", 0) == stats.get("offer_pages_fetched", 0) == 0
    assert stats.get("records", 0) == 0
    assert stats["current_listings"] == _stats(clean_db, first)["current_listings"] == 10
    assert stats["quality"] == {
        "metric": "current_listings",
        "current": 10.0,
        "previous": 10.0,
        "status": "succeeded",
        "message": "",
    }
    with clean_db.connect() as conn:
        assert dict(conn.execute(select(listing.c.id, listing.c.last_seen_at)).all()) == (
            seen_before
        )

    # 3. a changed fingerprint refetches only that catalog
    tjek.catalogs[1] = {**tjek.catalogs[1], "offer_count": 12}
    calls = len(tjek.offer_route.calls)
    stats = _stats(clean_db, run("tjek-offers"))
    assert tjek.fetched_since(calls) == ["b"]
    assert stats["catalogs_fetched_changed"] == 1
    assert stats["catalogs_skipped_unchanged"] == 1
    with clean_db.connect() as conn:
        offer_count = conn.execute(
            select(tjek_catalog_fetch.c.offer_count).where(tjek_catalog_fetch.c.catalog_id == "b")
        ).scalar_one()
    assert offer_count == 12

    # 4. a last full fetch older than TJEK_FULL_REFRESH_DAYS refetches
    with clean_db.begin() as conn:
        conn.execute(
            tjek_catalog_fetch.update()
            .where(tjek_catalog_fetch.c.catalog_id == "a")
            .values(offers_fetched_at=func.now() - timedelta(days=4))
        )
    calls = len(tjek.offer_route.calls)
    stats = _stats(clean_db, run("tjek-offers"))
    assert tjek.fetched_since(calls) == ["a"]
    assert stats["catalogs_fetched_refresh"] == 1
    calls = len(tjek.offer_route.calls)
    stats = _stats(clean_db, run("tjek-offers", tjek_full_refresh_days=7))
    assert tjek.fetched_since(calls) == []

    # 5. TJEK_FULL_REFRESH_DAYS=0 forces a full refresh
    calls = len(tjek.offer_route.calls)
    stats = _stats(clean_db, run("tjek-offers", tjek_full_refresh_days=0))
    assert tjek.fetched_since(calls) == ["a", "b"]
    assert stats["catalogs_fetched_refresh"] == 2


def first_started(engine: Engine, result: RunResult) -> datetime:
    with engine.connect() as conn:
        return conn.execute(
            select(fetch_run.c.started_at).where(fetch_run.c.id == result.run_id)
        ).scalar_one()


@respx.mock
def test_a_failed_catalog_is_fetched_again_next_run(
    run: Callable[..., RunResult], clean_db: Engine, load_fixture: Callable[[str], Any]
) -> None:
    day = timedelta(days=1)
    tjek = _Tjek(
        [_catalog("a", "Netto uge 47", -2 * day, 5 * day)], load_fixture("tjek/offers_netto.json")
    )
    tjek.offer_route.side_effect = httpx.ReadTimeout("slow")
    assert run("tjek-offers").stats["catalog_errors"] == 1
    with clean_db.connect() as conn:
        assert conn.execute(select(func.count()).select_from(tjek_catalog_fetch)).scalar_one() == 0
    tjek.offer_route.side_effect = tjek._offers  # pyright: ignore[reportPrivateUsage]
    calls = len(tjek.offer_route.calls)
    assert run("tjek-offers").stats["catalogs_fetched_new"] == 1
    assert tjek.fetched_since(calls) == ["a"]


@respx.mock
def test_tjek_offers_degrades_when_listed_catalogs_disappear(
    run: Callable[..., RunResult], load_fixture: Callable[[str], Any]
) -> None:
    """The quality metric still catches a lost dealer although listings stay in the database."""
    day = timedelta(days=1)
    tjek = _Tjek(
        [_catalog("a", "Netto uge 47", -2 * day, 5 * day)], load_fixture("tjek/offers_netto.json")
    )
    assert run("tjek-offers").status == "succeeded"
    tjek.netto_status = 503
    result = run("tjek-offers")
    assert result.status == "degraded"
    assert result.stats["current_listings"] == 0
    assert "current_listings dropped 100%" in result.message
