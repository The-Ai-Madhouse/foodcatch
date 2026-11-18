"""Open Food Facts product lookup by EAN (owned by the Open Food Facts module).

``GET https://world.openfoodfacts.org/api/v2/product/{ean}.json?fields=product_name,brands,
quantity,product_quantity,product_quantity_unit,nova_group,nutriscore_grade,categories_tags``
-> ``status`` 1 found / 0 not found. Limit ~100 product reads per minute (the shared client
throttles this host to 1.5 requests/s); a User-Agent is required (sent by the shared client).

Expected public API: model :class:`OffProductResponse`; :func:`fetch_product`.
"""

from __future__ import annotations

import httpx
from pydantic import BaseModel, ConfigDict

from foodcatch.sources import Fetched

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


class OffProductResponse(BaseModel):
    """Response of the product endpoint (fields to be defined by the OFF module)."""

    model_config = ConfigDict(extra="ignore", frozen=True)


def fetch_product(client: httpx.Client, ean: str) -> Fetched[OffProductResponse]:
    """Look up one EAN (a "not found" answer is a valid response, not an error)."""
    raise NotImplementedError
