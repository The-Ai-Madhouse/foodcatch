"""REMA 1000 product catalogue (unofficial app API, no key).

``GET https://cphapp.rema1000.dk/api/v3/products?per_page=1000&page=N`` - paginated via
``meta.pagination.last_page`` (~3956 products, 4 pages of 1000). Per product: ``id``, ``name``
(upper case), ``underline`` (size/brand text such as ``"1 KG. / REMA 1000, ØKOLOGISK"``),
``labels`` (e.g. ``Økologi``), ``is_weight_item`` and ``prices``: one entry per price period
with ``price``, ``is_campaign``, ``is_advertised``, ``starting_at``/``ending_at`` (calendar
dates sent as midnight UTC timestamps; ``2099-12-31`` means "until further notice"),
``compare_unit`` (``kg``, ``ltr``, ``stk``, and for non-food ``ml``, ``mtr``, ``sæt``, ...),
``compare_unit_price``, ``max_quantity``, ``price_over_max_quantity`` and ``deposit``.
There is no EAN.

The models validate the fields the pipeline uses and ignore the rest; the raw body keeps
everything.
"""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Annotated

import httpx
from pydantic import AwareDatetime, BaseModel, BeforeValidator, ConfigDict, Field

from foodcatch.sources import Fetched, SourceSchemaError, get_validated

BASE_URL = "https://cphapp.rema1000.dk/api/v3"
PAGE_SIZE = 1000
ENDPOINT_PRODUCTS = "products"
MAX_PAGES = 100
"""Safety stop: the catalogue has ~4 pages; far more means the pagination is broken."""


def _none_as_empty_list(value: object) -> object:
    return [] if value is None else value


def _none_as_empty_str(value: object) -> object:
    return "" if value is None else value


class RemaLabel(BaseModel):
    """A product label such as ``Økologi`` or ``Nøglehul``."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    name: str


class RemaPrice(BaseModel):
    """One price period of a product (regular shelf price or campaign)."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    price: Decimal = Field(ge=0)
    is_campaign: bool
    is_advertised: bool = False
    starting_at: AwareDatetime
    ending_at: AwareDatetime
    compare_unit: str | None = None
    compare_unit_price: Decimal | None = Field(default=None, ge=0)
    max_quantity: int | None = Field(default=None, ge=0)
    price_over_max_quantity: Decimal | None = Field(default=None, ge=0)
    deposit: Decimal | None = Field(default=None, ge=0)


class RemaProduct(BaseModel):
    """One product of ``GET /products``."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    id: int
    name: str
    underline: Annotated[str, BeforeValidator(_none_as_empty_str)] = ""
    is_weight_item: bool = False
    labels: Annotated[list[RemaLabel], BeforeValidator(_none_as_empty_list)] = Field(
        default_factory=list[RemaLabel]
    )
    prices: Annotated[list[RemaPrice], BeforeValidator(_none_as_empty_list)] = Field(
        default_factory=list[RemaPrice]
    )

    @property
    def label_names(self) -> list[str]:
        """Names of the product's labels in API order."""
        return [label.name for label in self.labels]


class RemaPagination(BaseModel):
    """``meta.pagination`` of a product page."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    current_page: int = Field(ge=1)
    last_page: int = Field(ge=0)
    per_page: int = Field(ge=1)
    total: int = Field(ge=0)


class RemaMeta(BaseModel):
    """``meta`` of a product page."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    pagination: RemaPagination


class RemaProductPage(BaseModel):
    """One page of ``GET /products`` (``data`` + ``meta.pagination``)."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    data: list[RemaProduct]
    meta: RemaMeta


def fetch_product_page(
    client: httpx.Client, *, page: int, per_page: int = PAGE_SIZE
) -> Fetched[RemaProductPage]:
    """Fetch and validate one catalogue page.

    Raises:
        SourceHTTPError: for an HTTP error status (after the client's retries).
        SourceSchemaError: if the body does not match :class:`RemaProductPage` or the server
            answered with another page than requested.
    """
    fetched = get_validated(
        client,
        f"{BASE_URL}/products",
        endpoint=ENDPOINT_PRODUCTS,
        model=RemaProductPage,
        params={"per_page": per_page, "page": page},
    )
    served = fetched.data.meta.pagination.current_page
    if served != page:
        raise SourceSchemaError(f"{ENDPOINT_PRODUCTS}: asked for page {page}, got page {served}")
    return fetched


def iter_product_pages(
    client: httpx.Client, *, per_page: int = PAGE_SIZE
) -> Iterator[Fetched[RemaProductPage]]:
    """Yield every page of the catalogue, starting at page 1.

    Stops after ``meta.pagination.last_page`` (or at the first empty page).

    Raises:
        SourceHTTPError: for an HTTP error status (after the client's retries).
        SourceSchemaError: for an invalid page or a pagination beyond :data:`MAX_PAGES`.
    """
    page = 1
    while True:
        fetched = fetch_product_page(client, page=page, per_page=per_page)
        yield fetched
        last_page = fetched.data.meta.pagination.last_page
        if last_page > MAX_PAGES:
            raise SourceSchemaError(
                f"{ENDPOINT_PRODUCTS}: last_page={last_page} exceeds the safety limit {MAX_PAGES}"
            )
        if page >= last_page or not fetched.data.data:
            return
        page += 1


__all__ = [
    "BASE_URL",
    "ENDPOINT_PRODUCTS",
    "MAX_PAGES",
    "PAGE_SIZE",
    "RemaLabel",
    "RemaMeta",
    "RemaPagination",
    "RemaPrice",
    "RemaProduct",
    "RemaProductPage",
    "fetch_product_page",
    "iter_product_pages",
]
