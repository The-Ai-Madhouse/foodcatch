"""Rema source: response models and pagination (recorded fixture + respx).

``fixtures/rema/products_page1.json`` is page 1 of the live catalogue (2026-11-18) trimmed to
10 products - regular and campaign prices, future price periods, deposit and max quantity,
units kg/ltr/stk/mtr and organic products with and without the word in the text - plus two
weight items from pages 2 and 3 (page 1 has none): loose tomatoes and a smoked pork joint.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest
import respx

from foodcatch.sources import SourceHTTPError, SourceSchemaError
from foodcatch.sources.rema import (
    BASE_URL,
    ENDPOINT_PRODUCTS,
    MAX_PAGES,
    RemaProductPage,
    iter_product_pages,
)

PRODUCTS_URL = f"{BASE_URL}/products"
FIXTURE = "rema/products_page1.json"


def _page(body: dict[str, Any], *, page: int, last_page: int) -> dict[str, Any]:
    result = copy.deepcopy(body)
    result["meta"]["pagination"].update(current_page=page, last_page=last_page)
    return result


def test_fixture_validates(fixture_bytes: Callable[[str], bytes]) -> None:
    page = RemaProductPage.model_validate_json(fixture_bytes(FIXTURE))
    assert len(page.data) == 12
    assert page.meta.pagination.total == 3956
    assert page.meta.pagination.last_page == 4

    by_id = {p.id: p for p in page.data}
    marmelade = by_id[100004]
    assert marmelade.name == "JORDBÆRMARMELADE"
    assert marmelade.underline == "285 GR. / EASIS"
    assert marmelade.label_names == ["Ikke tilsat sukker"]
    (price,) = marmelade.prices
    assert price.price == Decimal("23.95")
    assert price.compare_unit_price == Decimal("84.04")
    assert price.compare_unit == "kg"
    assert not price.is_campaign
    assert price.starting_at == datetime(2025, 11, 20, tzinfo=UTC)

    beer = by_id[200101]
    assert len(beer.prices) == 2  # this week's campaign and next week's
    campaign = beer.prices[0]
    assert campaign.is_campaign
    assert campaign.max_quantity == 12
    assert campaign.price_over_max_quantity == Decimal("43.5")
    assert campaign.deposit == Decimal(6)

    tomatoes = by_id[306137]
    assert tomatoes.is_weight_item
    assert tomatoes.underline == "0.12 KG. / HOLLAND KL.1"
    (per_kg,) = tomatoes.prices
    assert (per_kg.price, per_kg.compare_unit_price) == (Decimal("3.45"), Decimal(30))
    assert sum(p.is_weight_item for p in page.data) == 2


def test_null_lists_and_underline_are_accepted() -> None:
    body = {
        "data": [{"id": 1, "name": "X", "underline": None, "labels": None, "prices": None}],
        "meta": {"pagination": {"current_page": 1, "last_page": 1, "per_page": 10, "total": 1}},
    }
    page = RemaProductPage.model_validate(body)
    assert page.data[0].underline == ""
    assert page.data[0].prices == []
    assert page.data[0].labels == []


@respx.mock
def test_iter_pages_follows_pagination(
    http_client: httpx.Client, load_fixture: Callable[[str], Any]
) -> None:
    body = load_fixture(FIXTURE)
    page1 = json.dumps(_page(body, page=1, last_page=2)).encode()
    page2 = json.dumps(_page(body, page=2, last_page=2)).encode()
    route = respx.get(PRODUCTS_URL).mock(
        side_effect=[httpx.Response(200, content=page1), httpx.Response(200, content=page2)]
    )

    pages = list(iter_product_pages(http_client, per_page=1000))

    assert [p.params for p in pages] == [
        {"per_page": 1000, "page": 1},
        {"per_page": 1000, "page": 2},
    ]
    assert [p.body for p in pages] == [page1, page2]
    assert all(p.endpoint == ENDPOINT_PRODUCTS for p in pages)
    assert route.call_count == 2
    assert route.calls[1].request.url.params["page"] == "2"
    assert route.calls[1].request.headers["User-Agent"].startswith("foodcatch/")


@respx.mock
def test_iter_pages_stops_at_an_empty_page(http_client: httpx.Client) -> None:
    empty = {
        "data": [],
        "meta": {"pagination": {"current_page": 1, "last_page": 3, "per_page": 1000, "total": 0}},
    }
    route = respx.get(PRODUCTS_URL).mock(return_value=httpx.Response(200, json=empty))
    assert len(list(iter_product_pages(http_client))) == 1
    assert route.call_count == 1


@respx.mock
def test_iter_pages_rejects_an_absurd_page_count(
    http_client: httpx.Client, load_fixture: Callable[[str], Any]
) -> None:
    body = _page(load_fixture(FIXTURE), page=1, last_page=MAX_PAGES + 1)
    respx.get(PRODUCTS_URL).mock(return_value=httpx.Response(200, json=body))
    with pytest.raises(SourceSchemaError, match="safety limit"):
        list(iter_product_pages(http_client))


@respx.mock
def test_iter_pages_rejects_a_wrong_page(
    http_client: httpx.Client, load_fixture: Callable[[str], Any]
) -> None:
    body = _page(load_fixture(FIXTURE), page=3, last_page=4)
    respx.get(PRODUCTS_URL).mock(return_value=httpx.Response(200, json=body))
    with pytest.raises(SourceSchemaError, match="asked for page 1, got page 3"):
        list(iter_product_pages(http_client))


@respx.mock
def test_schema_change_is_a_hard_failure(
    http_client: httpx.Client, load_fixture: Callable[[str], Any]
) -> None:
    body = load_fixture(FIXTURE)
    del body["data"][0]["prices"][0]["is_campaign"]
    respx.get(PRODUCTS_URL).mock(return_value=httpx.Response(200, json=body))
    with pytest.raises(SourceSchemaError, match="products"):
        list(iter_product_pages(http_client))


@respx.mock
def test_http_error_after_retries(http_client: httpx.Client) -> None:
    route = respx.get(PRODUCTS_URL).mock(return_value=httpx.Response(503))
    with pytest.raises(SourceHTTPError) as info:
        list(iter_product_pages(http_client))
    assert info.value.status_code == 503
    assert route.call_count == 5  # the shared client retried
