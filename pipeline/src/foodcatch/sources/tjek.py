"""Tjek / eTilbudsavis API (unofficial, no key).

Base URL :data:`BASE_URL`. Only ``/v2`` endpoints; ``/v4/rpc/*`` needs a key we do not have.

* ``GET /dealers?country_id=DK&limit=100&offset=N``
* ``GET /stores?dealer_ids=ID&limit=100&offset=N`` -> id, dealer_id, street, city, zip_code,
  latitude, longitude, country, ... (opening hours etc. are dropped by the models).
* ``GET /catalogs?dealer_ids=ID&limit=24`` -> id, label, run_from, run_till (ISO, ``+0000``),
  offer_count, page_count. Only currently listed catalogs (no history). Catalogs whose label
  contains "Nonfood" are skipped (:func:`is_food_catalog`).
* ``GET /offers?catalog_ids=ID&limit=100&offset=N`` -> id, heading, description,
  pricing{price, pre_price, currency}, quantity{unit{symbol, si{symbol, factor}}, size{from, to},
  pieces{from, to, min, max}}, run_from, run_till, dealer_id, catalog_id, catalog_page, store_id.

Pagination: ``offset + limit`` may not exceed :data:`MAX_RESULTS` (1000); the API answers
``400 PAGINATION_MAX_REACHED`` beyond that. Stores are therefore fetched one dealer at a time
(the largest Danish chain has ~550 stores) and :class:`TjekPaginationLimitError` is raised
instead of silently truncating a result set that reaches the cap.

Chain <-> dealer id mapping is the ``chain.tjek_dealer_id`` column (seeded by migration).
Normalization of offers (unit prices, reference price, membership) lives in
:mod:`foodcatch.ingest.tjek`.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from datetime import datetime, timedelta
from decimal import Decimal

import httpx
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from foodcatch.sources import Fetched, QueryParams, SourceError, get_validated

BASE_URL = "https://squid-api.tjek.com/v2"
PAGE_SIZE = 100
CATALOG_LIMIT = 24
MAX_RESULTS = 1000
"""The API refuses ``offset + limit > MAX_RESULTS``."""
COUNTRY_ID = "DK"
UPCOMING_DAYS = 7
"""Catalogs starting within this many days are fetched in advance."""

ENDPOINT_DEALERS = "dealers"
ENDPOINT_STORES = "stores"
ENDPOINT_CATALOGS = "catalogs"
ENDPOINT_OFFERS = "offers"


class TjekPaginationLimitError(SourceError):
    """A result set reached the API's pagination cap, so it would be truncated."""


class _TjekModel(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True, populate_by_name=True)


class TjekCountry(_TjekModel):
    """Country reference (``{"id": "DK"}``)."""

    id: str


class TjekDealer(_TjekModel):
    """One dealer (chain) from ``GET /dealers``."""

    id: str
    name: str
    website: str | None = None
    country: TjekCountry | None = None


class TjekStore(_TjekModel):
    """One store from ``GET /stores`` (only the fields we keep)."""

    id: str
    dealer_id: str
    name: str | None = None
    street: str | None = None
    city: str | None = None
    zip_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    country: TjekCountry | None = None


class TjekCatalog(_TjekModel):
    """One catalog (leaflet) from ``GET /catalogs``."""

    id: str
    dealer_id: str
    label: str | None = None
    run_from: datetime
    run_till: datetime
    offer_count: int | None = None
    page_count: int | None = None


class TjekPricing(_TjekModel):
    """``offer.pricing``: the offer price and the (rarely set) previous price."""

    price: Decimal
    pre_price: Decimal | None = None
    currency: str | None = None


class TjekSiUnit(_TjekModel):
    """``quantity.unit.si``: base unit (``kg``, ``l``, ``pcs``) and the factor to reach it."""

    symbol: str | None = None
    factor: Decimal | None = None


class TjekUnit(_TjekModel):
    """``quantity.unit``: the unit the size is expressed in (e.g. ``g``) and its SI mapping."""

    symbol: str | None = None
    si: TjekSiUnit | None = None


class TjekRange(_TjekModel):
    """A ``{from, to}`` range (``quantity.size``)."""

    from_: Decimal | None = Field(default=None, alias="from")
    to: Decimal | None = None


class TjekPieces(TjekRange):
    """``quantity.pieces``: pack count range; ``max`` is the per-customer limit when set."""

    min: int | None = None
    max: int | None = None


class TjekQuantity(_TjekModel):
    """``offer.quantity``."""

    unit: TjekUnit | None = None
    size: TjekRange | None = None
    pieces: TjekPieces | None = None


class TjekOffer(_TjekModel):
    """One offer from ``GET /offers``."""

    id: str
    heading: str
    description: str | None = None
    catalog_page: int | None = None
    pricing: TjekPricing
    quantity: TjekQuantity | None = None
    run_from: datetime
    run_till: datetime | None = None
    dealer_id: str
    catalog_id: str | None = None
    store_id: str | None = None


DEALER_PAGE: TypeAdapter[list[TjekDealer]] = TypeAdapter(list[TjekDealer])
STORE_PAGE: TypeAdapter[list[TjekStore]] = TypeAdapter(list[TjekStore])
CATALOG_LIST: TypeAdapter[list[TjekCatalog]] = TypeAdapter(list[TjekCatalog])
OFFER_PAGE: TypeAdapter[list[TjekOffer]] = TypeAdapter(list[TjekOffer])


def is_food_catalog(label: str | None) -> bool:
    """False for catalogs whose label contains "Nonfood" (case-insensitive)."""
    return "nonfood" not in (label or "").casefold()


def is_current_or_upcoming(
    catalog: TjekCatalog, now: datetime, *, days_ahead: int = UPCOMING_DAYS
) -> bool:
    """True if ``catalog`` is valid at ``now`` or starts within ``days_ahead`` days.

    Args:
        catalog: the catalog to test.
        now: a timezone-aware reference time (normally the run's start).
        days_ahead: how far ahead upcoming catalogs are included.
    """
    return catalog.run_till >= now and catalog.run_from <= now + timedelta(days=days_ahead)


def _paginate[T](
    client: httpx.Client,
    path: str,
    *,
    endpoint: str,
    model: TypeAdapter[list[T]],
    params: QueryParams,
    page_size: int = PAGE_SIZE,
) -> Iterator[Fetched[list[T]]]:
    """Yield pages until one is shorter than ``page_size``.

    Raises:
        TjekPaginationLimitError: if the result set reaches :data:`MAX_RESULTS`.
    """
    offset = 0
    while True:
        page = get_validated(
            client,
            f"{BASE_URL}/{path}",
            endpoint=endpoint,
            model=model,
            params={**params, "limit": page_size, "offset": offset},
        )
        yield page
        if len(page.data) < page_size:
            return
        offset += page_size
        if offset + page_size > MAX_RESULTS:
            raise TjekPaginationLimitError(
                f"{endpoint} {dict(params)}: more than {MAX_RESULTS} results; "
                "the API cannot page further, narrow the query"
            )


def iter_dealers(
    client: httpx.Client, *, country_id: str = COUNTRY_ID
) -> Iterator[Fetched[list[TjekDealer]]]:
    """Yield every page of dealers in ``country_id`` (used to look up dealer ids)."""
    return _paginate(
        client,
        "dealers",
        endpoint=ENDPOINT_DEALERS,
        model=DEALER_PAGE,
        params={"country_id": country_id},
    )


def iter_stores(
    client: httpx.Client, dealer_ids: Sequence[str]
) -> Iterator[Fetched[list[TjekStore]]]:
    """Yield every page of stores of the given dealers, one dealer at a time.

    One query per dealer keeps each result set below the API's pagination cap.

    Raises:
        TjekPaginationLimitError: if a single dealer has more than :data:`MAX_RESULTS` stores.
    """
    for dealer_id in dealer_ids:
        yield from _paginate(
            client,
            "stores",
            endpoint=ENDPOINT_STORES,
            model=STORE_PAGE,
            params={"dealer_ids": dealer_id},
        )


def fetch_catalogs(client: httpx.Client, dealer_id: str) -> Fetched[list[TjekCatalog]]:
    """Currently listed catalogs of one dealer (all of them, food or not)."""
    return get_validated(
        client,
        f"{BASE_URL}/catalogs",
        endpoint=ENDPOINT_CATALOGS,
        model=CATALOG_LIST,
        params={"dealer_ids": dealer_id, "limit": CATALOG_LIMIT},
    )


def iter_offers(client: httpx.Client, catalog_id: str) -> Iterator[Fetched[list[TjekOffer]]]:
    """Yield every page of offers of one catalog.

    Raises:
        TjekPaginationLimitError: if the catalog has more than :data:`MAX_RESULTS` offers.
    """
    return _paginate(
        client,
        "offers",
        endpoint=ENDPOINT_OFFERS,
        model=OFFER_PAGE,
        params={"catalog_ids": catalog_id},
    )


__all__ = [
    "BASE_URL",
    "CATALOG_LIMIT",
    "COUNTRY_ID",
    "ENDPOINT_CATALOGS",
    "ENDPOINT_DEALERS",
    "ENDPOINT_OFFERS",
    "ENDPOINT_STORES",
    "MAX_RESULTS",
    "PAGE_SIZE",
    "UPCOMING_DAYS",
    "TjekCatalog",
    "TjekCountry",
    "TjekDealer",
    "TjekOffer",
    "TjekPaginationLimitError",
    "TjekPieces",
    "TjekPricing",
    "TjekQuantity",
    "TjekRange",
    "TjekSiUnit",
    "TjekStore",
    "TjekUnit",
    "fetch_catalogs",
    "is_current_or_upcoming",
    "is_food_catalog",
    "iter_dealers",
    "iter_offers",
    "iter_stores",
]
