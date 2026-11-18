"""Tjek / eTilbudsavis API (unofficial, no key; owned by the Tjek module).

Base URL :data:`BASE_URL`. Only ``/v2`` endpoints; ``/v4/rpc/*`` needs a key we do not have.

* ``GET /dealers?country_id=DK&limit=100&offset=N``
* ``GET /stores?dealer_ids=ID1,ID2&limit=100&offset=N`` (optional ``r_lat``, ``r_lng``,
  ``r_radius`` in metres) -> id, dealer_id, street, city, zip_code, latitude, longitude, ...
* ``GET /catalogs?dealer_ids=ID&limit=24`` -> id, label, run_from, run_till (ISO, ``+0000``),
  offer_count, page_count. Only currently listed catalogs. Skip labels containing "Nonfood"
  (case-insensitive) - see :func:`is_food_catalog`.
* ``GET /offers?catalog_ids=ID&limit=100&offset=N`` -> id, heading, description,
  pricing{price, pre_price, currency}, quantity{unit{symbol, si{symbol, factor}},
  size{from, to}, pieces{from, to, min, max}}, run_from, run_till, dealer_id, catalog_id,
  catalog_page, store_id, category_ids (always empty). ``pre_price`` is almost always null;
  descriptions contain "Normalpris 19,95", "Max. 6 stk. pr. kunde pr. dag", "Pr. kg max. 61,25"
  and membership hints ("Netto+", "medlem", "Et medlemskab af Coop").

Unit price rule (PoC): the SI factor converts size to kg/l/stk (``pcs`` -> ``stk``);
``lo = size.from * factor * pieces.from``, ``hi = size.to * factor * pieces.from``;
``unit_price_min = price / hi``, ``unit_price_max = price / lo``.

Chain <-> dealer id mapping is the ``chain.tjek_dealer_id`` column (seeded by migration).

Expected public API: models :class:`TjekStore`, :class:`TjekCatalog`, :class:`TjekOffer`;
:func:`iter_stores`, :func:`fetch_catalogs`, :func:`iter_offers`, :func:`is_food_catalog`.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence

import httpx
from pydantic import BaseModel, ConfigDict

from foodcatch.sources import Fetched

BASE_URL = "https://squid-api.tjek.com/v2"
PAGE_SIZE = 100
ENDPOINT_STORES = "stores"
ENDPOINT_CATALOGS = "catalogs"
ENDPOINT_OFFERS = "offers"


class TjekStore(BaseModel):
    """One store from ``GET /stores`` (fields to be defined by the Tjek module)."""

    model_config = ConfigDict(extra="ignore", frozen=True)


class TjekCatalog(BaseModel):
    """One catalog from ``GET /catalogs`` (fields to be defined by the Tjek module)."""

    model_config = ConfigDict(extra="ignore", frozen=True)


class TjekOffer(BaseModel):
    """One offer from ``GET /offers`` (fields to be defined by the Tjek module)."""

    model_config = ConfigDict(extra="ignore", frozen=True)


def is_food_catalog(label: str | None) -> bool:
    """False for catalogs whose label contains "Nonfood" (case-insensitive)."""
    raise NotImplementedError


def iter_stores(
    client: httpx.Client, dealer_ids: Sequence[str]
) -> Iterator[Fetched[list[TjekStore]]]:
    """Yield every page of stores of the given dealers."""
    raise NotImplementedError


def fetch_catalogs(client: httpx.Client, dealer_id: str) -> Fetched[list[TjekCatalog]]:
    """Currently listed catalogs of one dealer."""
    raise NotImplementedError


def iter_offers(client: httpx.Client, catalog_id: str) -> Iterator[Fetched[list[TjekOffer]]]:
    """Yield every page of offers of one catalog."""
    raise NotImplementedError
