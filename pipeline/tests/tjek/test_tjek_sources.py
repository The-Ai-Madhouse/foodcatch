"""Tjek source module: models, catalog selection and pagination (recorded fixtures + respx)."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
import respx

from foodcatch.sources import SourceHTTPError, SourceSchemaError
from foodcatch.sources.tjek import (
    BASE_URL,
    CATALOG_LIMIT,
    PAGE_SIZE,
    TjekCatalog,
    TjekPaginationLimitError,
    fetch_catalogs,
    is_current_or_upcoming,
    is_food_catalog,
    iter_dealers,
    iter_offers,
    iter_stores,
)


def _store(i: int, dealer_id: str = "9ba51") -> dict[str, Any]:
    return {"id": f"s{i}", "dealer_id": dealer_id, "street": "Vej 1", "zip_code": "8000"}


def _catalog(run_from: str, run_till: str, label: str = "Netto uge 47") -> TjekCatalog:
    return TjekCatalog.model_validate(
        {
            "id": "c1",
            "dealer_id": "9ba51",
            "label": label,
            "run_from": run_from,
            "run_till": run_till,
        }
    )


# --------------------------------------------------------------------------- catalogs


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("Netto uge 47", True),
        ("Netto Nonfood uge 47", False),
        ("NONFOOD", False),
        ("Lidl nonfood-avis", False),
        (None, True),
        ("", True),
    ],
)
def test_is_food_catalog(label: str | None, expected: bool) -> None:
    assert is_food_catalog(label) is expected


NOW = datetime(2026, 11, 18, 12, tzinfo=UTC)


@pytest.mark.parametrize(
    ("run_from", "run_till", "expected"),
    [
        ("2026-11-13T23:00:00+0000", "2026-11-20T22:59:59+0000", True),  # current
        ("2026-11-20T23:00:00+0000", "2026-11-27T22:59:59+0000", True),  # starts in 2.5 days
        ("2026-11-25T12:00:00+0000", "2026-12-01T22:59:59+0000", True),  # exactly 7 days ahead
        ("2026-11-25T12:00:01+0000", "2026-12-01T22:59:59+0000", False),  # too far ahead
        ("2026-11-06T23:00:00+0000", "2026-11-13T22:59:59+0000", False),  # expired
        ("2026-11-06T23:00:00+0000", "2026-11-18T12:00:00+0000", True),  # ends right now
    ],
)
def test_is_current_or_upcoming(run_from: str, run_till: str, expected: bool) -> None:
    assert is_current_or_upcoming(_catalog(run_from, run_till), NOW) is expected


@respx.mock
def test_fetch_catalogs_recorded(
    http_client: httpx.Client, fixture_bytes: Callable[[str], bytes]
) -> None:
    body = fixture_bytes("tjek/catalogs_netto.json")
    route = respx.get(f"{BASE_URL}/catalogs").mock(return_value=httpx.Response(200, content=body))
    fetched = fetch_catalogs(http_client, "9ba51")
    assert fetched.body == body
    assert fetched.endpoint == "catalogs"
    assert fetched.params == {"dealer_ids": "9ba51", "limit": CATALOG_LIMIT}
    assert [c.label for c in fetched.data] == [
        "Netto uge 48",
        "Netto uge 47",
        "Netto Nonfood uge 47",
    ]
    week47 = fetched.data[1]
    assert week47.id == "40K-WXWp"
    assert week47.run_from == datetime(2026, 11, 13, 23, tzinfo=UTC)
    assert week47.offer_count == 223
    assert [is_food_catalog(c.label) for c in fetched.data] == [True, True, False]
    assert route.calls.last.request.url.params["dealer_ids"] == "9ba51"


@respx.mock
def test_catalog_without_run_till_is_a_schema_error(http_client: httpx.Client) -> None:
    respx.get(f"{BASE_URL}/catalogs").mock(
        return_value=httpx.Response(200, json=[{"id": "c1", "dealer_id": "9ba51"}])
    )
    with pytest.raises(SourceSchemaError, match="catalogs"):
        fetch_catalogs(http_client, "9ba51")


# --------------------------------------------------------------------------- pagination


@respx.mock
def test_stores_paginate_until_a_short_page(http_client: httpx.Client) -> None:
    pages = {
        0: [_store(i) for i in range(PAGE_SIZE)],
        PAGE_SIZE: [_store(i) for i in range(PAGE_SIZE, PAGE_SIZE + 3)],
    }

    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=pages[int(request.url.params["offset"])])

    route = respx.get(f"{BASE_URL}/stores").mock(side_effect=respond)
    fetched = list(iter_stores(http_client, ["9ba51"]))
    assert [len(p.data) for p in fetched] == [PAGE_SIZE, 3]
    assert [p.params for p in fetched] == [
        {"dealer_ids": "9ba51", "limit": PAGE_SIZE, "offset": 0},
        {"dealer_ids": "9ba51", "limit": PAGE_SIZE, "offset": PAGE_SIZE},
    ]
    assert route.call_count == 2


@respx.mock
def test_stores_are_fetched_one_dealer_at_a_time(
    http_client: httpx.Client, fixture_bytes: Callable[[str], bytes]
) -> None:
    netto = fixture_bytes("tjek/stores_netto.json")

    def respond(request: httpx.Request) -> httpx.Response:
        dealer = request.url.params["dealer_ids"]
        return (
            httpx.Response(200, content=netto)
            if dealer == "9ba51"
            else httpx.Response(200, json=[])
        )

    route = respx.get(f"{BASE_URL}/stores").mock(side_effect=respond)
    fetched = list(iter_stores(http_client, ["9ba51", "11deC"]))
    assert [p.params["dealer_ids"] for p in fetched] == ["9ba51", "11deC"]
    assert fetched[0].body == netto
    netto_stores = fetched[0].data
    assert len(netto_stores) == 4
    first = netto_stores[0]
    assert (first.id, first.dealer_id, first.zip_code, first.city) == (
        "86d7kOL",
        "9ba51",
        "4300",
        "Holbæk",
    )
    assert first.latitude == pytest.approx(55.7151231)
    assert first.country is not None
    assert first.country.id == "DK"
    assert route.call_count == 2


@respx.mock
def test_pagination_cap_raises_instead_of_truncating(http_client: httpx.Client) -> None:
    route = respx.get(f"{BASE_URL}/stores").mock(
        return_value=httpx.Response(200, json=[_store(i) for i in range(PAGE_SIZE)])
    )
    with pytest.raises(TjekPaginationLimitError, match="1000"):
        list(iter_stores(http_client, ["9ba51"]))
    assert route.call_count == 10  # offsets 0..900; offset 1000 would be refused by the API


@respx.mock
def test_offers_recorded_page(
    http_client: httpx.Client, fixture_bytes: Callable[[str], bytes]
) -> None:
    body = fixture_bytes("tjek/offers_netto.json")
    route = respx.get(f"{BASE_URL}/offers").mock(return_value=httpx.Response(200, content=body))
    (page,) = list(iter_offers(http_client, "40K-WXWp"))
    assert page.endpoint == "offers"
    assert page.params == {"catalog_ids": "40K-WXWp", "limit": PAGE_SIZE, "offset": 0}
    assert len(page.data) == len(json.loads(body))
    eggs = page.data[0]
    assert eggs.heading == "Dava danske frilandsæg"
    assert eggs.quantity is not None
    assert eggs.quantity.unit is not None
    assert eggs.quantity.unit.si is not None
    assert eggs.quantity.unit.si.symbol == "pcs"
    assert route.calls.last.request.headers["User-Agent"].startswith("foodcatch/")


@respx.mock
def test_offer_without_price_is_a_schema_error(http_client: httpx.Client) -> None:
    bad = [{"id": "o1", "heading": "x", "run_from": "2026-11-13T23:00:00+0000", "dealer_id": "d"}]
    respx.get(f"{BASE_URL}/offers").mock(return_value=httpx.Response(200, json=bad))
    with pytest.raises(SourceSchemaError, match="offers"):
        list(iter_offers(http_client, "c1"))


@respx.mock
def test_http_error_propagates(http_client: httpx.Client) -> None:
    respx.get(f"{BASE_URL}/offers").mock(return_value=httpx.Response(404, json={"code": 1}))
    with pytest.raises(SourceHTTPError) as info:
        list(iter_offers(http_client, "c1"))
    assert info.value.status_code == 404


@respx.mock
def test_dealers_recorded(http_client: httpx.Client, fixture_bytes: Callable[[str], bytes]) -> None:
    body = fixture_bytes("tjek/dealers.json")
    respx.get(f"{BASE_URL}/dealers").mock(return_value=httpx.Response(200, content=body))
    (page,) = list(iter_dealers(http_client))
    assert page.params == {"country_id": "DK", "limit": PAGE_SIZE, "offset": 0}
    assert "DWZE1w" in {d.id for d in page.data}
