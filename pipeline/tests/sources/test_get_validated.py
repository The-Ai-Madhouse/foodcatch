from __future__ import annotations

import httpx
import pytest
import respx
from pydantic import BaseModel

from foodcatch.sources import (
    SourceError,
    SourceHTTPError,
    SourceNetworkError,
    SourceSchemaError,
    get_validated,
    link_relations,
)

URL = "https://api.example.test/stores"


class Store(BaseModel):
    id: str
    city: str


@respx.mock
def test_returns_body_unchanged_and_validated_data(http_client: httpx.Client) -> None:
    body = b'[{"id": "a1", "city": "K\xc3\xb8benhavn", "extra": 1}]'
    route = respx.get(URL).mock(return_value=httpx.Response(200, content=body))
    fetched = get_validated(
        http_client,
        URL,
        endpoint="stores",
        model=list[Store],
        params={"limit": 100},
        headers={"Authorization": "Bearer secret"},
    )
    assert fetched.body == body
    assert fetched.data == [Store(id="a1", city="København")]
    assert fetched.params == {"limit": 100}
    assert fetched.endpoint == "stores"
    assert fetched.url == URL
    assert route.calls.last.request.headers["Authorization"] == "Bearer secret"
    assert route.calls.last.request.url.params["limit"] == "100"


@respx.mock
def test_schema_mismatch_is_an_error(http_client: httpx.Client) -> None:
    respx.get(URL).mock(return_value=httpx.Response(200, json=[{"id": "a1"}]))
    with pytest.raises(SourceSchemaError, match="stores"):
        get_validated(http_client, URL, endpoint="stores", model=list[Store])


@respx.mock
def test_http_error_hides_query(http_client: httpx.Client) -> None:
    respx.get(URL).mock(return_value=httpx.Response(403, text="forbidden"))
    with pytest.raises(SourceHTTPError) as info:
        get_validated(http_client, URL, endpoint="stores", model=Store, params={"token": "x"})
    assert info.value.status_code == 403
    assert "token" not in str(info.value)


@respx.mock
def test_network_error_is_a_source_error_without_query(http_client: httpx.Client) -> None:
    respx.get(URL).mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(SourceNetworkError) as info:
        get_validated(http_client, URL, endpoint="stores", model=Store, params={"token": "x"})
    assert isinstance(info.value, SourceError)
    assert str(info.value) == f"stores: ConnectError for {URL}"
    assert isinstance(info.value.__cause__, httpx.ConnectError)


@respx.mock
def test_response_headers_are_exposed_without_cookies(http_client: httpx.Client) -> None:
    respx.get(URL).mock(
        return_value=httpx.Response(
            200,
            json=[],
            headers=[
                ("Link", '<https://api.example.test/stores?page=2>; rel="next"'),
                ("X-Total-Count", "3"),
                ("Set-Cookie", "session=secret"),
            ],
        )
    )
    fetched = get_validated(http_client, URL, endpoint="stores", model=list[Store])
    assert fetched.headers["x-total-count"] == "3"
    assert "set-cookie" not in fetched.headers
    assert link_relations(fetched.headers) == {"next": "https://api.example.test/stores?page=2"}


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (
            '<https://x/s?page=2>; rel="next", <https://x/s?page=9>; rel="last"',
            {"next": "https://x/s?page=2", "last": "https://x/s?page=9"},
        ),
        ("<https://x/s?page=1>; rel=first", {"first": "https://x/s?page=1"}),
        (
            '<https://x/s?page=1>; rel="prev first"',
            {"prev": "https://x/s?page=1", "first": "https://x/s?page=1"},
        ),
        ("<https://x/s>; title=nothing", {}),
        ("", {}),
    ],
)
def test_link_relations(value: str, expected: dict[str, str]) -> None:
    assert link_relations({"link": value}) == expected


def test_link_relations_without_header() -> None:
    assert link_relations({}) is None
