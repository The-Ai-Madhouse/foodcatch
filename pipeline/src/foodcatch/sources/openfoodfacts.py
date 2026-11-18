"""Open Food Facts product lookup by EAN.

``GET https://world.openfoodfacts.org/api/v2/product/{ean}.json?fields=product_name,brands,
quantity,product_quantity,product_quantity_unit,nova_group,nutriscore_grade,categories_tags``

* found: HTTP 200, ``{"code": ..., "status": 1, "status_verbose": "product found",
  "product": {...}}``
* not found: HTTP **404** with ``{"code": ..., "status": 0, "status_verbose": "product not
  found"}``. This is a valid answer (it is stored raw and marks the EAN as checked), not an
  error.

Limit ~100 product reads per minute; the shared client throttles this host to 1.5 requests/s
(90/min) and sends the required User-Agent.

The envelope (``code``, ``status``) is validated strictly. The product fields are crowd-sourced
and loosely typed (numbers as strings, ``"unknown"`` grades, ...): values that cannot be read
become ``None`` instead of failing the lookup.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Annotated, Final

import httpx
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

from foodcatch.sources import (
    Fetched,
    SourceHTTPError,
    SourceSchemaError,
    get_or_network_error,
)

BASE_URL = "https://world.openfoodfacts.org/api/v2"
FIELDS = (
    "product_name",
    "brands",
    "quantity",
    "product_quantity",
    "product_quantity_unit",
    "nova_group",
    "nutriscore_grade",
    "categories_tags",
)
ENDPOINT_PRODUCT = "product"
EAN_PATTERN: Final = re.compile(r"[0-9]{8,14}")
"""What we send to Open Food Facts: GTIN-8 to GTIN-14, digits only."""

STATUS_FOUND: Final = 1
HTTP_NOT_FOUND: Final = 404
STATUS_NOT_FOUND: Final = 0


def _lenient_decimal(value: object) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value).strip().replace(",", "."))
    except InvalidOperation:
        return None
    return number if number.is_finite() else None


def _lenient_int(value: object) -> int | None:
    number = _lenient_decimal(value)
    if number is None or number != number.to_integral_value():
        return None
    return int(number)


def _lenient_str(value: object) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, int | float) and not isinstance(value, bool):
        return str(value)
    return None


def _lenient_str_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]  # pyright: ignore[reportUnknownVariableType]


type LenientStr = Annotated[str | None, BeforeValidator(_lenient_str)]


class OffProduct(BaseModel):
    """The requested product fields (each optional and leniently parsed)."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    product_name: LenientStr = None
    brands: LenientStr = None
    quantity: LenientStr = None
    product_quantity: Annotated[Decimal | None, BeforeValidator(_lenient_decimal)] = None
    product_quantity_unit: LenientStr = None
    nova_group: Annotated[int | None, BeforeValidator(_lenient_int)] = None
    nutriscore_grade: LenientStr = None
    categories_tags: Annotated[list[str], BeforeValidator(_lenient_str_list)] = Field(
        default_factory=list[str]
    )


class OffProductResponse(BaseModel):
    """Response of the product endpoint, for found and not-found EANs alike."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    code: str
    status: int = Field(ge=0, le=1)
    status_verbose: str = ""
    product: OffProduct | None = None

    @property
    def found(self) -> bool:
        """True when Open Food Facts knows the product."""
        return self.status == STATUS_FOUND and self.product is not None


class InvalidEanError(ValueError):
    """The EAN is not 8-14 digits (never sent to Open Food Facts)."""


def product_url(ean: str) -> str:
    """URL of the product endpoint for ``ean``.

    Raises:
        InvalidEanError: if ``ean`` is not 8-14 digits.
    """
    if not EAN_PATTERN.fullmatch(ean):
        raise InvalidEanError(f"not an EAN: {ean!r}")
    return f"{BASE_URL}/product/{ean}.json"


def fetch_product(client: httpx.Client, ean: str) -> Fetched[OffProductResponse]:
    """Look up one EAN (a "not found" answer is a valid response, not an error).

    The recorded params are ``{"ean": ean, "fields": "..."}``; only ``fields`` is sent as a
    query parameter (the EAN is part of the path).

    Raises:
        InvalidEanError: if ``ean`` is not 8-14 digits.
        SourceHTTPError: for HTTP errors other than the documented "not found" 404.
        SourceNetworkError: if no response arrived (after the client's retries).
        SourceSchemaError: if the body is not a valid product response.
    """
    url = product_url(ean)
    fields = ",".join(FIELDS)
    response = get_or_network_error(
        client, url, endpoint=ENDPOINT_PRODUCT, params={"fields": fields}
    )
    public_url = str(response.request.url.copy_with(query=None))
    if response.is_error and response.status_code != HTTP_NOT_FOUND:
        raise SourceHTTPError(response.status_code, public_url, response.text[:200])
    try:
        data = OffProductResponse.model_validate_json(response.content)
    except ValidationError as exc:
        if response.is_error:  # e.g. an HTML 404 page: not the documented answer
            raise SourceHTTPError(response.status_code, public_url, response.text[:200]) from exc
        raise SourceSchemaError(
            f"{ENDPOINT_PRODUCT}: response from {public_url} does not match the expected schema: "
            f"{exc.error_count()} error(s), first: {exc.errors()[0]['msg']} at "
            f"{exc.errors()[0]['loc']}"
        ) from exc
    if response.is_error and data.status != STATUS_NOT_FOUND:
        raise SourceHTTPError(response.status_code, public_url, response.text[:200])
    return Fetched(
        endpoint=ENDPOINT_PRODUCT,
        params={"ean": ean, "fields": fields},
        body=response.content,
        data=data,
        url=public_url,
    )


__all__ = [
    "BASE_URL",
    "EAN_PATTERN",
    "ENDPOINT_PRODUCT",
    "FIELDS",
    "InvalidEanError",
    "OffProduct",
    "OffProductResponse",
    "fetch_product",
    "product_url",
]
