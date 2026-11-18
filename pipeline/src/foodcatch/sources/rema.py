"""REMA 1000 product catalogue (unofficial app API, no key; owned by the Rema module).

``GET https://cphapp.rema1000.dk/api/v3/products?per_page=1000&page=N`` - paginated via
``meta.pagination.last_page`` (~3956 products). Fields: id, name, underline (size/brand text),
labels, is_weight_item, prices[{price, is_campaign, is_advertised, starting_at, ending_at,
compare_unit ("kg", "ltr", "stk." ...), compare_unit_price, max_quantity,
price_over_max_quantity, deposit}], ... No EAN.

Expected public API: models :class:`RemaProduct`, :class:`RemaProductPage`;
:func:`iter_product_pages`.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
from pydantic import BaseModel, ConfigDict

from foodcatch.sources import Fetched

BASE_URL = "https://cphapp.rema1000.dk/api/v3"
PAGE_SIZE = 1000
ENDPOINT_PRODUCTS = "products"


class RemaProduct(BaseModel):
    """One product (fields to be defined by the Rema module)."""

    model_config = ConfigDict(extra="ignore", frozen=True)


class RemaProductPage(BaseModel):
    """One page of ``GET /products`` (``data`` + ``meta.pagination``)."""

    model_config = ConfigDict(extra="ignore", frozen=True)


def iter_product_pages(
    client: httpx.Client, *, per_page: int = PAGE_SIZE
) -> Iterator[Fetched[RemaProductPage]]:
    """Yield every page of the catalogue."""
    raise NotImplementedError
