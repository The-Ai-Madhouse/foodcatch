"""``rema-products`` end to end: respx-mocked catalogue, real raw store and test database."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any

import httpx
import pytest
import respx
from sqlalchemy import Engine, func, select

from foodcatch.config import Settings
from foodcatch.db.tables import listing, raw_object
from foodcatch.jobs.runner import RunResult, run_job
from foodcatch.sources.rema import BASE_URL
from foodcatch.storage.raw import LocalRawStore

PRODUCTS_URL = f"{BASE_URL}/products"


@pytest.fixture
def catalogue(load_fixture: Callable[[str], Any]) -> dict[str, Any]:
    return load_fixture("rema/products_page1.json")


@pytest.fixture
def run(
    clean_db: Engine, settings: Settings, raw_store: LocalRawStore, http_client: httpx.Client
) -> Callable[[], RunResult]:
    def runner() -> RunResult:
        return run_job(
            "rema-products",
            settings=settings,
            engine=clean_db,
            raw_store=raw_store,
            http=http_client,
            hooks=(),
        )

    return runner


def _pages(catalogue: dict[str, Any], *chunks: slice, total: int | None = None) -> list[Any]:
    """Split the fixture's products into pages announcing ``total`` (default: all served)."""
    pages: list[Any] = []
    products = catalogue["data"]
    served = sum(len(products[chunk]) for chunk in chunks)
    for number, chunk in enumerate(chunks, start=1):
        page = copy.deepcopy(catalogue)
        page["data"] = products[chunk]
        page["meta"]["pagination"].update(
            current_page=number,
            last_page=len(chunks),
            total=served if total is None else total,
        )
        pages.append(page)
    return pages


def _mock(pages: list[Any]) -> respx.Route:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.params["per_page"] == "1000"
        return httpx.Response(200, json=pages[int(request.url.params["page"]) - 1])

    return respx.get(PRODUCTS_URL).mock(side_effect=respond)


def _count(engine: Engine, *where: Any) -> int:
    with engine.connect() as conn:
        return conn.execute(
            select(func.count()).select_from(listing).where(listing.c.source == "rema", *where)
        ).scalar_one()


@respx.mock
def test_rema_products_job(
    run: Callable[[], RunResult], catalogue: dict[str, Any], clean_db: Engine
) -> None:
    route = _mock(_pages(catalogue, slice(0, 6), slice(6, None)))
    result = run()

    assert result.status == "succeeded"
    assert route.call_count == 2
    assert result.stats["records"] == 15
    assert result.stats["raw_objects"] == 2
    assert result.stats["rema_products_seen"] == 12
    assert result.stats.get("rema_listings_closed_vanished", 0) == 0
    assert _count(clean_db) == 15
    with clean_db.connect() as conn:
        params = conn.execute(select(raw_object.c.params).order_by(raw_object.c.storage_key))
        assert [p["page"] for p in params.scalars()] == [1, 2]


@respx.mock
def test_rerun_is_idempotent_and_closes_vanished_products(
    run: Callable[[], RunResult], catalogue: dict[str, Any], clean_db: Engine
) -> None:
    _mock(_pages(catalogue, slice(0, None)))
    run()
    respx.clear()

    _mock(_pages(catalogue, slice(1, None)))  # JORDBÆRMARMELADE left the catalogue
    result = run()

    assert result.status == "succeeded"
    assert result.stats.get("rema_listings_inserted", 0) == 0
    assert result.stats.get("rema_listings_updated", 0) == 0
    assert result.stats["rema_listings_closed_vanished"] == 1
    assert _count(clean_db) == 15
    assert _count(clean_db, listing.c.source_item_id == "100004", listing.c.valid_to.is_(None)) == 0
    with clean_db.connect() as conn:
        closed_at = conn.execute(
            select(listing.c.valid_to).where(listing.c.source_item_id == "100004")
        ).scalar_one()
    assert closed_at is not None


@respx.mock
def test_incomplete_catalogue_closes_nothing(
    run: Callable[[], RunResult], catalogue: dict[str, Any], clean_db: Engine
) -> None:
    _mock(_pages(catalogue, slice(0, None)))
    run()
    respx.clear()

    _mock(_pages(catalogue, slice(1, None), total=3956))  # announced far more than served
    result = run()

    assert result.stats["rema_vanished_check_skipped"] == 1
    assert "rema_listings_closed_vanished" not in result.stats
    assert _count(clean_db, listing.c.source_item_id == "100004", listing.c.valid_to.is_(None)) == 1


@respx.mock
def test_schema_change_fails_the_run(
    run: Callable[[], RunResult], catalogue: dict[str, Any], clean_db: Engine
) -> None:
    pages = _pages(catalogue, slice(0, None))
    del pages[0]["data"][0]["prices"][0]["price"]
    _mock(pages)
    with pytest.raises(Exception, match="products"):
        run()
    assert _count(clean_db) == 0
