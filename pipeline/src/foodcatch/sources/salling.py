"""Salling Group developer API (official; owned by the Salling module).

Base URL :data:`BASE_URL`; every request sends ``Authorization: Bearer <SALLING_API_KEY>`` via
:func:`auth_headers` as a per-request header (never in recorded params). Rate limits are
undocumented: the shared client throttles to 4 requests/s and retries 429/5xx.

Endpoints used (raw-store endpoint names in :data:`ENDPOINT_STORES` / :data:`ENDPOINT_FOOD_WASTE`):

* ``GET /v2/stores?brand=netto|foetex|bilka&per_page=..&page=..`` -> list of stores
  (``id`` uuid, ``name``, ``brand``, ``address{street, zip, city, country, extra}``,
  ``coordinates [lon, lat]``, ``hours`` (large; dropped after raw storage), ``attributes``).
* ``GET /v1/food-waste/{storeId}`` -> ``{store, clearances: [{offer, product}]}``.
  ``offer``: currency, discount, ean (clearance-label code - do NOT use), endTime, lastUpdate,
  newPrice, originalPrice, percentDiscount, startTime, stock, stockUnit.
  ``product``: categories{da, en} (may be missing), description (abbreviated upper-case name),
  ean (the real GTIN - use this), image.
* ``/v1/leaflet-offers`` is forbidden for our key - do not use.

Expected public API:

* pydantic models :class:`SallingStore`, :class:`FoodWasteResponse` (+ nested models).
* :func:`iter_stores` - pages of stores for one brand.
* :func:`fetch_food_waste` - clearances of one store.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
from pydantic import BaseModel, ConfigDict

from foodcatch.sources import Fetched

BASE_URL = "https://api.sallinggroup.com"
BRANDS: tuple[str, ...] = ("netto", "foetex", "bilka")
ENDPOINT_STORES = "stores"
ENDPOINT_FOOD_WASTE = "food-waste"


def auth_headers(api_key: str) -> dict[str, str]:
    """Per-request authorization header for the Salling API."""
    return {"Authorization": f"Bearer {api_key}"}


class SallingStore(BaseModel):
    """One store from ``GET /v2/stores`` (fields to be defined by the Salling module)."""

    model_config = ConfigDict(extra="ignore", frozen=True)


class FoodWasteResponse(BaseModel):
    """Response of ``GET /v1/food-waste/{storeId}`` (fields to be defined by the Salling module)."""

    model_config = ConfigDict(extra="ignore", frozen=True)


def iter_stores(
    client: httpx.Client, api_key: str, *, brand: str, per_page: int = 100
) -> Iterator[Fetched[list[SallingStore]]]:
    """Yield every page of stores of ``brand`` (one :class:`Fetched` per HTTP response)."""
    raise NotImplementedError


def fetch_food_waste(
    client: httpx.Client, api_key: str, store_id: str
) -> Fetched[FoodWasteResponse]:
    """Fetch the current clearances of one store."""
    raise NotImplementedError
