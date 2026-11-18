"""Salling Group developer API (official; owned by the Salling module).

Base URL :data:`BASE_URL`; every request sends ``Authorization: Bearer <SALLING_API_KEY>`` via
:func:`auth_headers` as a per-request header (never in recorded params). Rate limits are
undocumented: the shared client throttles to 4 requests/s and retries 429/5xx.

Endpoints used (raw-store endpoint names in :data:`ENDPOINT_STORES` / :data:`ENDPOINT_FOOD_WASTE`):

* ``GET /v2/stores?brand=netto|foetex|bilka&country=dk&per_page=..&page=..`` -> a JSON list of
  stores (``id`` uuid, ``name``, ``brand``, ``address{street, zip, city, country, extra}``,
  ``coordinates [lon, lat]``, ``hours`` (large; dropped after raw storage), ``attributes``).
  Pagination is page based; the ``Link`` response header announces ``rel="next"`` while more
  pages follow (and ``x-total-count`` the total). Without a ``Link`` header a page shorter than
  ``per_page`` is the last one, and requesting a page beyond the last answers HTTP 400 ("The
  last page is currently N ..."). Without ``country=dk`` the ``netto`` brand includes the German
  and Polish stores.
* ``GET /v1/food-waste/{storeId}`` -> ``{store, clearances: [{offer, product}]}``.
  ``offer``: currency, discount, ean (clearance-label code - do NOT use as product id), endTime,
  lastUpdate, newPrice, originalPrice, percentDiscount, startTime, stock, stockUnit
  (``each`` or ``kg``). ``product``: categories{da, en} (may be ``{}``), description
  (abbreviated upper-case name), ean (the real GTIN - or a short in-store code for
  variable-weight goods), image (may be null).
* ``/v1/leaflet-offers`` is forbidden for our key - do not use.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Iterator
from decimal import Decimal

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from foodcatch.sources import Fetched, SourceHTTPError, get_validated, link_relations

BASE_URL = "https://api.sallinggroup.com"
BRANDS: tuple[str, ...] = ("netto", "foetex", "bilka")
COUNTRY = "dk"
ENDPOINT_STORES = "stores"
ENDPOINT_FOOD_WASTE = "food-waste"
STORES_PATH = "/v2/stores"
FOOD_WASTE_PATH = "/v1/food-waste/{store_id}"
DEFAULT_PER_PAGE = 100
MAX_STORE_PAGES = 100
"""Safety stop for pagination (Netto DK has ~600 stores, i.e. 6 pages of 100)."""

CATEGORY_SEPARATOR = ">"
_STORE_ID = re.compile(r"[A-Za-z0-9-]+")
HTTP_BAD_REQUEST = 400
_PAST_LAST_PAGE = "last page"


def auth_headers(api_key: str) -> dict[str, str]:
    """Per-request authorization header for the Salling API."""
    return {"Authorization": f"Bearer {api_key}"}


class _Model(BaseModel):
    """Base for Salling response models: camelCase aliases, unknown fields ignored."""

    model_config = ConfigDict(
        extra="ignore", frozen=True, alias_generator=to_camel, populate_by_name=True
    )


class SallingAddress(_Model):
    """Postal address of a store."""

    street: str | None = None
    zip: str | None = None
    city: str | None = None
    country: str | None = None
    extra: str | None = None


class SallingStore(_Model):
    """One store from ``GET /v2/stores`` (also the ``store`` object of a food-waste response).

    ``hours`` and ``attributes`` are deliberately not modelled: they stay in the raw store only.
    """

    id: str = Field(min_length=1)
    name: str
    brand: str
    address: SallingAddress = Field(default_factory=SallingAddress)
    coordinates: tuple[float, float] | None = None
    """``[lon, lat]`` (GeoJSON order)."""

    @property
    def lat(self) -> float | None:
        """Latitude, or ``None`` when the store has no coordinates."""
        return self.coordinates[1] if self.coordinates else None

    @property
    def lon(self) -> float | None:
        """Longitude, or ``None`` when the store has no coordinates."""
        return self.coordinates[0] if self.coordinates else None


class ClearanceOffer(_Model):
    """The price part of a clearance (``offer``)."""

    currency: str | None = None
    discount: Decimal | None = None
    ean: str | None = None
    """Code printed on the clearance label; identifies the clearance, not the product."""
    end_time: AwareDatetime
    last_update: AwareDatetime | None = None
    new_price: Decimal
    original_price: Decimal | None = None
    percent_discount: Decimal | None = None
    start_time: AwareDatetime
    stock: int | float | None = None
    stock_unit: str | None = None


class ProductCategories(_Model):
    """Category paths per language (``"A>B>Leaf"``); either may be missing."""

    da: str | None = None
    en: str | None = None


class ClearanceProduct(_Model):
    """The product part of a clearance (``product``)."""

    categories: ProductCategories = Field(default_factory=ProductCategories)
    description: str
    """Abbreviated upper-case product name, e.g. ``"A38 ØKO 1KG ARLA CULTURA"``."""
    ean: str
    image: str | None = None

    @property
    def category_path(self) -> str | None:
        """The Danish category path, or ``None`` when absent or blank."""
        path = (self.categories.da or "").strip()
        return path or None

    @property
    def category_leaf(self) -> str | None:
        """Last segment of :attr:`category_path` (paths may repeat earlier segments)."""
        path = self.category_path
        return path.rsplit(CATEGORY_SEPARATOR, 1)[-1].strip() if path else None


class Clearance(_Model):
    """One food-waste clearance: an offer for a product in a store."""

    offer: ClearanceOffer
    product: ClearanceProduct


class FoodWasteResponse(_Model):
    """Response of ``GET /v1/food-waste/{storeId}``."""

    store: SallingStore
    clearances: list[Clearance] = Field(default_factory=list[Clearance])


def is_past_last_page(exc: SourceHTTPError) -> bool:
    """Whether ``exc`` is the API's answer to a page number beyond the last page."""
    return exc.status_code == HTTP_BAD_REQUEST and _PAST_LAST_PAGE in str(exc).lower()


def iter_stores(
    client: httpx.Client, api_key: str, *, brand: str, per_page: int = DEFAULT_PER_PAGE
) -> Iterator[Fetched[list[SallingStore]]]:
    """Yield every page of Danish stores of ``brand`` (one :class:`Fetched` per HTTP response).

    When the response has a ``Link`` header, pages are requested while it announces
    ``rel="next"``. Otherwise pages are requested until one is shorter than ``per_page``; when
    the store count is an exact multiple of ``per_page`` the extra request is answered with
    HTTP 400 "last page", which also ends the iteration (:func:`is_past_last_page`). A page
    repeating the previous one and :data:`MAX_STORE_PAGES` stop the iteration as safety nets.

    Raises:
        SourceHTTPError: for HTTP errors (after the shared client's retries).
        SourceSchemaError: if a page does not match :class:`SallingStore`.
    """
    previous_ids: list[str] | None = None
    for page in range(1, MAX_STORE_PAGES + 1):
        try:
            fetched = get_validated(
                client,
                BASE_URL + STORES_PATH,
                endpoint=ENDPOINT_STORES,
                model=list[SallingStore],
                params={"brand": brand, "country": COUNTRY, "per_page": per_page, "page": page},
                headers=auth_headers(api_key),
            )
        except SourceHTTPError as exc:
            if page > 1 and is_past_last_page(exc):
                return
            raise
        ids = [store.id for store in fetched.data]
        if ids and ids == previous_ids:
            return
        yield fetched
        links = link_relations(fetched.headers)
        if links is not None and "next" not in links:
            return
        if links is None and len(ids) < per_page:
            return
        previous_ids = ids


def fetch_food_waste(
    client: httpx.Client, api_key: str, store_id: str
) -> Fetched[FoodWasteResponse]:
    """Fetch the current clearances of one store.

    The store id is part of the URL path; it is recorded as ``params["store_id"]`` so the raw
    object stays self-describing.

    Raises:
        SourceHTTPError: for HTTP errors, e.g. 404 for an unknown or closed store.
        SourceSchemaError: if the body does not match :class:`FoodWasteResponse`.
        ValueError: if ``store_id`` is not a plain id (it becomes a URL path segment).
    """
    if not _STORE_ID.fullmatch(store_id):
        raise ValueError(f"invalid Salling store id: {store_id!r}")
    fetched = get_validated(
        client,
        BASE_URL + FOOD_WASTE_PATH.format(store_id=store_id),
        endpoint=ENDPOINT_FOOD_WASTE,
        model=FoodWasteResponse,
        headers=auth_headers(api_key),
    )
    return dataclasses.replace(fetched, params={"store_id": store_id})


__all__ = [
    "BASE_URL",
    "BRANDS",
    "ENDPOINT_FOOD_WASTE",
    "ENDPOINT_STORES",
    "Clearance",
    "ClearanceOffer",
    "ClearanceProduct",
    "FoodWasteResponse",
    "ProductCategories",
    "SallingAddress",
    "SallingStore",
    "auth_headers",
    "fetch_food_waste",
    "is_past_last_page",
    "iter_stores",
]
