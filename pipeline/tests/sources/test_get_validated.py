from __future__ import annotations

import httpx
import pytest
import respx
from pydantic import BaseModel

from foodcatch.sources import SourceHTTPError, SourceSchemaError, get_validated

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
