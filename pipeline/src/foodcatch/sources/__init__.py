"""External API clients: one module per source.

Every source module exposes pydantic models for the responses it uses and fetch functions that
return :class:`Fetched` objects: the validated payload *and* the body exactly as received, so the
job can store it unchanged in the raw store (architecture §4 steps 2-3). Use
:func:`get_validated` for every request; it raises :class:`SourceSchemaError` when a response
does not match the model (a hard failure - we never store data we could not validate).

Raw-store source names (``raw_object.source``, ``fetch_run.source``) are :data:`RAW_SOURCES`.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from pydantic import TypeAdapter, ValidationError

type RawSource = Literal["salling", "tjek", "rema", "openfoodfacts"]
RAW_SOURCES: tuple[RawSource, ...] = ("salling", "tjek", "rema", "openfoodfacts")

type QueryParams = Mapping[str, str | int | float | bool]


class SourceError(Exception):
    """Base class for errors talking to an external source."""


class SourceHTTPError(SourceError):
    """The source answered with an HTTP error status (after retries)."""

    def __init__(self, status_code: int, url: str, detail: str = "") -> None:
        super().__init__(f"HTTP {status_code} from {url}" + (f": {detail}" if detail else ""))
        self.status_code = status_code
        self.url = url


class SourceSchemaError(SourceError):
    """The response did not match the expected pydantic model."""


@dataclass(frozen=True, slots=True)
class Fetched[T]:
    """One validated API response.

    Attributes:
        endpoint: raw-store endpoint name (a single path segment, e.g. ``food-waste``).
        params: request parameters to record in ``raw_object.params`` (never secrets).
        body: the response body exactly as received.
        data: the validated payload.
    """

    endpoint: str
    params: Mapping[str, Any]
    body: bytes
    data: T
    url: str = field(default="", compare=False)


def get_validated[T](
    client: httpx.Client,
    url: str,
    *,
    endpoint: str,
    model: type[T] | TypeAdapter[T],
    params: QueryParams | None = None,
    headers: Mapping[str, str] | None = None,
) -> Fetched[T]:
    """GET ``url`` and validate the JSON body against ``model``.

    Args:
        client: the shared client from :func:`foodcatch.http.create_client`.
        url: absolute URL.
        endpoint: raw-store endpoint name recorded with the payload.
        model: a pydantic model class, any type (e.g. ``list[Store]``) or a ``TypeAdapter``.
        params: query parameters; recorded with the payload, so never put secrets here.
        headers: per-request headers (e.g. authorization); not recorded.

    Raises:
        SourceHTTPError: for 4xx/5xx responses (after the client's retries).
        SourceSchemaError: if the body is not valid JSON for ``model``.
    """
    response = client.get(url, params=dict(params) if params else None, headers=headers)
    public_url = str(response.request.url.copy_with(query=None))
    if response.is_error:
        raise SourceHTTPError(response.status_code, public_url, response.text[:200])
    adapter: TypeAdapter[T] = model if isinstance(model, TypeAdapter) else TypeAdapter(model)
    try:
        data = adapter.validate_json(response.content)
    except ValidationError as exc:
        raise SourceSchemaError(
            f"{endpoint}: response from {public_url} does not match the expected schema: "
            f"{exc.error_count()} error(s), first: {exc.errors()[0]['msg']} at "
            f"{exc.errors()[0]['loc']}"
        ) from exc
    return Fetched(
        endpoint=endpoint,
        params=dict(params or {}),
        body=response.content,
        data=data,
        url=public_url,
    )
