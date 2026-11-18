"""Open Food Facts source: response model, lookups and rate limiting (fixtures + respx)."""

from __future__ import annotations

from collections.abc import Callable
from decimal import Decimal

import httpx
import pytest
import respx

from foodcatch.http import HOST_RATES_PER_SECOND, HostThrottle, RetryingTransport
from foodcatch.sources import SourceHTTPError, SourceSchemaError
from foodcatch.sources.openfoodfacts import (
    BASE_URL,
    ENDPOINT_PRODUCT,
    FIELDS,
    InvalidEanError,
    OffProduct,
    OffProductResponse,
    fetch_product,
    product_url,
)

FOUND_EAN = "3017620422003"
MISSING_EAN = "5712345678908"
OFF_HOST = "world.openfoodfacts.org"

type FixtureBytes = Callable[[str], bytes]


def test_found_fixture(fixture_bytes: FixtureBytes) -> None:
    response = OffProductResponse.model_validate_json(
        fixture_bytes("openfoodfacts/product_found.json")
    )
    assert response.found
    assert response.code == FOUND_EAN
    item = response.product
    assert item is not None
    assert item.product_name == "Nutella"
    assert item.brands == "Ferrero, Nutella"
    assert item.quantity == "400 g e"
    assert item.product_quantity == Decimal(400)
    assert item.product_quantity_unit == "g"
    assert item.nova_group == 3
    assert item.nutriscore_grade == "e"
    assert "en:spreads" in item.categories_tags


def test_not_found_fixture(fixture_bytes: FixtureBytes) -> None:
    response = OffProductResponse.model_validate_json(
        fixture_bytes("openfoodfacts/product_not_found.json")
    )
    assert not response.found
    assert response.product is None


def test_product_fields_are_parsed_leniently() -> None:
    item = OffProduct.model_validate(
        {
            "product_name": "  ",
            "brands": 42,
            "product_quantity": "1,5",
            "nova_group": "4",
            "nutriscore_grade": "unknown",
            "categories_tags": ["en:milks", 7, None],
        }
    )
    assert item.product_name is None
    assert item.brands == "42"
    assert item.product_quantity == Decimal("1.5")
    assert item.nova_group == 4
    assert item.nutriscore_grade == "unknown"  # normalized to NULL by ingest
    assert item.categories_tags == ["en:milks"]

    odd = OffProduct.model_validate(
        {"product_quantity": "about 500", "nova_group": 2.5, "categories_tags": "x"}
    )
    assert (odd.product_quantity, odd.nova_group, odd.categories_tags) == (None, None, [])


def test_envelope_is_strict() -> None:
    with pytest.raises(ValueError, match="status"):
        OffProductResponse.model_validate({"code": "1", "status": 7})


@pytest.mark.parametrize("ean", ["", "123", "12345678901234567", "57123456789O8", "1/2"])
def test_invalid_ean_is_never_sent(ean: str) -> None:
    with pytest.raises(InvalidEanError):
        product_url(ean)


@respx.mock
def test_fetch_found(http_client: httpx.Client, fixture_bytes: FixtureBytes) -> None:
    body = fixture_bytes("openfoodfacts/product_found.json")
    route = respx.get(f"{BASE_URL}/product/{FOUND_EAN}.json").respond(200, content=body)
    fetched = fetch_product(http_client, FOUND_EAN)

    assert fetched.endpoint == ENDPOINT_PRODUCT
    assert fetched.body == body
    assert fetched.data.found
    assert fetched.params == {"ean": FOUND_EAN, "fields": ",".join(FIELDS)}
    request = route.calls.last.request
    assert request.url.params["fields"] == ",".join(FIELDS)
    assert request.headers["User-Agent"].startswith("foodcatch/")


@respx.mock
def test_fetch_not_found_is_a_valid_answer(
    http_client: httpx.Client, fixture_bytes: FixtureBytes
) -> None:
    body = fixture_bytes("openfoodfacts/product_not_found.json")
    respx.get(f"{BASE_URL}/product/{MISSING_EAN}.json").respond(404, content=body)
    fetched = fetch_product(http_client, MISSING_EAN)
    assert not fetched.data.found
    assert fetched.body == body


@respx.mock
def test_fetch_not_found_with_status_200(http_client: httpx.Client) -> None:
    respx.get(f"{BASE_URL}/product/{MISSING_EAN}.json").respond(
        200, json={"code": MISSING_EAN, "status": 0, "status_verbose": "product not found"}
    )
    assert not fetch_product(http_client, MISSING_EAN).data.found


@respx.mock
def test_fetch_html_404_is_an_error(http_client: httpx.Client) -> None:
    respx.get(f"{BASE_URL}/product/{MISSING_EAN}.json").respond(404, text="<html>nope</html>")
    with pytest.raises(SourceHTTPError) as info:
        fetch_product(http_client, MISSING_EAN)
    assert info.value.status_code == 404


@respx.mock
def test_fetch_server_error_after_retries(http_client: httpx.Client) -> None:
    route = respx.get(f"{BASE_URL}/product/{FOUND_EAN}.json").respond(503)
    with pytest.raises(SourceHTTPError):
        fetch_product(http_client, FOUND_EAN)
    assert route.call_count == 5


@respx.mock
def test_fetch_schema_mismatch(http_client: httpx.Client) -> None:
    respx.get(f"{BASE_URL}/product/{FOUND_EAN}.json").respond(200, json={"status": 1})
    with pytest.raises(SourceSchemaError, match="product"):
        fetch_product(http_client, FOUND_EAN)


def test_rate_limit_is_below_100_reads_per_minute(fixture_bytes: FixtureBytes) -> None:
    """The shared throttle spaces Open Food Facts requests to at most 90 per minute."""
    assert HOST_RATES_PER_SECOND[OFF_HOST] * 60 <= 100
    now = [0.0]
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        now[0] += seconds

    body = fixture_bytes("openfoodfacts/product_found.json")
    throttle = HostThrottle(sleep=sleep, clock=lambda: now[0])
    transport = RetryingTransport(
        httpx.MockTransport(lambda _request: httpx.Response(200, content=body)),
        throttle=throttle,
        sleep=sleep,
    )
    with httpx.Client(transport=transport) as client:
        for _ in range(10):
            fetch_product(client, FOUND_EAN)

    assert len(slept) == 9  # every request after the first waited for its slot
    assert now[0] >= 9 * 60 / 90 - 1e-9  # 10 requests take at least 6 s: <= 90/min
