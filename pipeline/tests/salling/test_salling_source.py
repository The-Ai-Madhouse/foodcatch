"""Salling source: response models and fetchers (recorded fixtures + respx)."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest
import respx
from pydantic import TypeAdapter

from foodcatch.sources import SourceHTTPError, SourceSchemaError
from foodcatch.sources.salling import (
    BASE_URL,
    ENDPOINT_FOOD_WASTE,
    ENDPOINT_STORES,
    FoodWasteResponse,
    SallingStore,
    fetch_food_waste,
    iter_stores,
)

API_KEY = "test-key"
STORES_URL = f"{BASE_URL}/v2/stores"
HVIDOVRE = "7fd81b2b-219b-4795-a561-c1a9d3fb28d1"


def test_store_model_parses_recorded_page(fixture_bytes: Callable[[str], bytes]) -> None:
    stores = TypeAdapter(list[SallingStore]).validate_json(
        fixture_bytes("salling/stores_netto_page1.json")
    )
    assert [s.id for s in stores][:1] == [HVIDOVRE]
    first = stores[0]
    assert first.name == "Netto Laurits Olsens Vej"
    assert first.brand == "netto"
    assert first.address.zip == "2650"
    assert first.address.city == "Hvidovre"
    assert first.address.country == "DK"
    # coordinates are [lon, lat]
    assert first.lat == pytest.approx(55.663435)
    assert first.lon == pytest.approx(12.4762406)
    assert not hasattr(first, "hours")


def test_store_without_coordinates() -> None:
    item = SallingStore.model_validate({"id": "x", "name": "Netto X", "brand": "netto"})
    assert item.lat is None
    assert item.lon is None


def test_food_waste_model_parses_recorded_response(
    fixture_bytes: Callable[[str], bytes],
) -> None:
    response = FoodWasteResponse.model_validate_json(
        fixture_bytes("salling/food_waste_netto_hvidovre.json")
    )
    assert response.store.id == HVIDOVRE
    assert len(response.clearances) == 6
    by_name = {c.product.description: c for c in response.clearances}

    a38 = by_name["A38 ØKO 1KG ARLA CULTURA"]
    assert a38.product.ean == "5760466870306"
    assert a38.offer.ean == "5712580607528"  # clearance-label code, not the product GTIN
    assert isinstance(a38.offer.new_price, Decimal)
    assert a38.offer.start_time.tzinfo is not None
    assert a38.offer.stock_unit == "each"
    assert a38.product.category_path is not None
    assert a38.product.category_leaf == "A38, tykmælk & ymer"

    mozzarella = by_name["MOZZARELLA 1KG SAY CHEESE"]
    assert mozzarella.product.category_path is None  # "categories": {}
    assert mozzarella.product.category_leaf is None


def test_food_waste_variable_weight_and_repeated_category(
    fixture_bytes: Callable[[str], bytes],
) -> None:
    response = FoodWasteResponse.model_validate_json(
        fixture_bytes("salling/food_waste_bilka_tilst.json")
    )
    by_name = {c.product.description: c for c in response.clearances}
    grill = by_name["GRILLBAKKE 3 SLAGTERMEST."]
    assert grill.offer.stock_unit == "kg"
    assert isinstance(grill.offer.stock, float)
    assert grill.offer.new_price == Decimal("48.95")
    spege = by_name["TILST SPEGEPØLSE"]
    assert spege.product.image is None
    risalamande = by_name["RIS A LA MANDE STEFF H."]
    assert risalamande.product.category_path is not None
    assert risalamande.product.category_path.count(">") > 3
    assert risalamande.product.category_leaf == "Middagsretter"


def _store_page(ids: list[str]) -> list[dict[str, Any]]:
    return [
        {"id": i, "name": f"Netto {i}", "brand": "netto", "coordinates": [12.5, 55.7]} for i in ids
    ]


@respx.mock
def test_iter_stores_paginates_until_short_page(http_client: httpx.Client) -> None:
    route = respx.get(STORES_URL).mock(
        side_effect=[
            httpx.Response(200, json=_store_page(["a", "b"])),
            httpx.Response(200, json=_store_page(["c"])),
        ]
    )
    pages = list(iter_stores(http_client, API_KEY, brand="netto", per_page=2))

    assert [[s.id for s in p.data] for p in pages] == [["a", "b"], ["c"]]
    assert route.call_count == 2
    assert [p.params for p in pages] == [
        {"brand": "netto", "country": "dk", "per_page": 2, "page": 1},
        {"brand": "netto", "country": "dk", "per_page": 2, "page": 2},
    ]
    assert all(p.endpoint == ENDPOINT_STORES for p in pages)
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert request.url.params["page"] == "2"
    assert request.url.params["country"] == "dk"
    assert API_KEY not in json.dumps([p.params for p in pages])
    assert json.loads(pages[0].body)[0]["id"] == "a"  # body kept unchanged


@respx.mock
def test_iter_stores_exact_multiple_ends_with_empty_page(http_client: httpx.Client) -> None:
    route = respx.get(STORES_URL).mock(
        side_effect=[
            httpx.Response(200, json=_store_page(["a", "b"])),
            httpx.Response(200, json=[]),
        ]
    )
    pages = list(iter_stores(http_client, API_KEY, brand="bilka", per_page=2))
    assert [len(p.data) for p in pages] == [2, 0]
    assert route.call_count == 2


# Recorded answer (trace id dropped) to a page number beyond the last page.
PAST_LAST_PAGE = {
    "contactInfo": "apisupport@sallinggroup.com",
    "error": "The last page is currently 1, but you requested page 2. You can access the last "
    "page here: https://api.sallinggroup.com/v2/stores?brand=bilka&country=dk&per_page=2&page=1",
    "statusCode": 400,
}


@respx.mock
def test_iter_stores_exact_multiple_ends_with_past_last_page_error(
    http_client: httpx.Client,
) -> None:
    route = respx.get(STORES_URL).mock(
        side_effect=[
            httpx.Response(200, json=_store_page(["a", "b"])),
            httpx.Response(400, json=PAST_LAST_PAGE),
        ]
    )
    pages = list(iter_stores(http_client, API_KEY, brand="bilka", per_page=2))
    assert [len(p.data) for p in pages] == [2]
    assert route.call_count == 2


@respx.mock
def test_iter_stores_other_bad_request_fails(http_client: httpx.Client) -> None:
    respx.get(STORES_URL).mock(
        side_effect=[
            httpx.Response(200, json=_store_page(["a", "b"])),
            httpx.Response(400, json={"error": "invalid brand", "statusCode": 400}),
        ]
    )
    with pytest.raises(SourceHTTPError) as info:
        list(iter_stores(http_client, API_KEY, brand="bilka", per_page=2))
    assert info.value.status_code == 400


@respx.mock
def test_iter_stores_first_page_bad_request_fails(http_client: httpx.Client) -> None:
    respx.get(STORES_URL).mock(return_value=httpx.Response(400, json=PAST_LAST_PAGE))
    with pytest.raises(SourceHTTPError):
        list(iter_stores(http_client, API_KEY, brand="bilka"))


@respx.mock
def test_iter_stores_stops_when_page_parameter_is_ignored(http_client: httpx.Client) -> None:
    route = respx.get(STORES_URL).mock(
        return_value=httpx.Response(200, json=_store_page(["a", "b"]))
    )
    pages = list(iter_stores(http_client, API_KEY, brand="netto", per_page=2))
    assert len(pages) == 1
    assert route.call_count == 2


@respx.mock
def test_iter_stores_schema_error(http_client: httpx.Client) -> None:
    respx.get(STORES_URL).mock(return_value=httpx.Response(200, json=[{"id": "a"}]))
    with pytest.raises(SourceSchemaError):
        list(iter_stores(http_client, API_KEY, brand="netto"))


@respx.mock
def test_fetch_food_waste_records_store_id(
    http_client: httpx.Client, fixture_bytes: Callable[[str], bytes]
) -> None:
    body = fixture_bytes("salling/food_waste_netto_hvidovre.json")
    route = respx.get(f"{BASE_URL}/v1/food-waste/{HVIDOVRE}").mock(
        return_value=httpx.Response(200, content=body)
    )
    fetched = fetch_food_waste(http_client, API_KEY, HVIDOVRE)

    assert fetched.endpoint == ENDPOINT_FOOD_WASTE
    assert fetched.params == {"store_id": HVIDOVRE}
    assert fetched.body == body
    assert fetched.data.store.id == HVIDOVRE
    assert route.calls.last.request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert route.calls.last.request.headers["User-Agent"].startswith("foodcatch/")


@respx.mock
def test_fetch_food_waste_not_found(http_client: httpx.Client) -> None:
    respx.get(f"{BASE_URL}/v1/food-waste/missing").mock(return_value=httpx.Response(404))
    with pytest.raises(SourceHTTPError) as info:
        fetch_food_waste(http_client, API_KEY, "missing")
    assert info.value.status_code == 404


@pytest.mark.parametrize("store_id", ["", "../stores", "a/b", "a?x=1"])
def test_fetch_food_waste_rejects_unsafe_store_id(http_client: httpx.Client, store_id: str) -> None:
    with pytest.raises(ValueError, match="invalid Salling store id"):
        fetch_food_waste(http_client, API_KEY, store_id)


def test_food_waste_times_are_utc(fixture_bytes: Callable[[str], bytes]) -> None:
    response = FoodWasteResponse.model_validate_json(
        fixture_bytes("salling/food_waste_netto_oesterbro.json")
    )
    offer = response.clearances[0].offer
    assert offer.end_time.utcoffset() == datetime(2026, 1, 1, tzinfo=UTC).utcoffset()
    assert offer.end_time >= offer.start_time
