"""Salling jobs (owned by the Salling module).

* ``salling-stores`` (weekly) - :func:`foodcatch.sources.salling.iter_stores` for every brand
  in ``BRANDS``; ``ctx.ingest(page)`` per page. Quality metric: ``records`` (stores).
* ``salling-food-waste`` (twice daily) - for every Salling store in the DB (all of Denmark)
  seen within :data:`STORE_MAX_AGE`, :func:`foodcatch.sources.salling.fetch_food_waste`;
  ``ctx.ingest(response)`` per store. If no store is known yet, the store list is fetched first
  (those pages are stored raw too but do not count as records). Quality metric: ``records``
  (clearances).

A store answering 404 (closed or unknown) is skipped. Other per-store HTTP or network errors are
tolerated up to :func:`max_failed_stores`; beyond that the run fails. Authorization errors
(401/403) and schema mismatches fail the run immediately.
"""

from __future__ import annotations

import math
from datetime import timedelta

import httpx
from sqlalchemy import Connection, func, select

from foodcatch.db.tables import store
from foodcatch.ingest.salling import STORE_SOURCE
from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job
from foodcatch.sources import SourceError, SourceHTTPError
from foodcatch.sources.salling import BRANDS, fetch_food_waste, iter_stores

STORE_MAX_AGE = timedelta(days=21)
"""Stores not seen by the weekly store job (or a food-waste response) for this long are skipped."""
FAILED_STORES_FRACTION = 0.05
FAILED_STORES_MIN = 5
AUTH_STATUS_CODES = frozenset({401, 403})
NOT_FOUND = 404


class SallingFetchError(SourceError):
    """Too many stores could not be fetched in one food-waste run."""


def max_failed_stores(total: int) -> int:
    """How many per-store fetch failures a food-waste run tolerates for ``total`` stores."""
    return max(FAILED_STORES_MIN, math.ceil(total * FAILED_STORES_FRACTION))


def known_store_ids(conn: Connection, *, max_age: timedelta = STORE_MAX_AGE) -> list[str]:
    """Salling store ids seen within ``max_age``, in a stable order."""
    rows = conn.execute(
        select(store.c.source_store_id)
        .where(store.c.source == STORE_SOURCE, store.c.last_seen_at >= func.now() - max_age)
        .order_by(store.c.source_store_id)
    ).scalars()
    return [str(store_id) for store_id in rows]


def _collect_stores(ctx: JobContext, api_key: str) -> int:
    """Fetch and ingest all store pages of all brands; returns the number of stores."""
    total = 0
    for brand in BRANDS:
        for page in iter_stores(ctx.http, api_key, brand=brand):
            total += ctx.ingest(page).records
    return total


@register_job(
    "salling-stores",
    source="salling",
    description="Salling Group stores (Netto, føtex, Bilka)",
    post_fetch=False,
)
def collect_salling_stores(ctx: JobContext) -> None:
    """Fetch and ingest all Salling stores."""
    api_key = ctx.settings.require_salling_api_key()
    total = _collect_stores(ctx, api_key)
    ctx.log.info("salling.stores_collected", stores=total)


@register_job(
    "salling-food-waste",
    source="salling",
    description="Salling food-waste clearances for all stores",
)
def collect_salling_food_waste(ctx: JobContext) -> None:
    """Fetch and ingest food-waste clearances of every Salling store."""
    api_key = ctx.settings.require_salling_api_key()
    store_ids = known_store_ids(ctx.conn)
    if not store_ids:
        ctx.log.info("salling.no_known_stores", action="fetching store list first")
        bootstrapped = _collect_stores(ctx, api_key)
        # Store pages are not clearances: keep `records` comparable between runs.
        ctx.count("records", -bootstrapped)
        ctx.count("stores_bootstrapped", bootstrapped)
        store_ids = known_store_ids(ctx.conn)

    allowed_failures = max_failed_stores(len(store_ids))
    failures = 0
    for store_id in store_ids:
        try:
            fetched = fetch_food_waste(ctx.http, api_key, store_id)
        except SourceHTTPError as exc:
            if exc.status_code in AUTH_STATUS_CODES:
                raise
            if exc.status_code == NOT_FOUND:
                ctx.count("stores_not_found")
                ctx.log.warning("salling.store_not_found", store_id=store_id)
                continue
            failures += 1
            ctx.log.warning("salling.food_waste_failed", store_id=store_id, error=str(exc))
        except httpx.TransportError as exc:
            failures += 1
            ctx.log.warning("salling.food_waste_failed", store_id=store_id, error=repr(exc))
        else:
            ctx.ingest(fetched)
            ctx.count("stores_fetched")
            continue
        ctx.count("stores_failed")
        if failures > allowed_failures:
            raise SallingFetchError(
                f"{failures} of {len(store_ids)} stores failed (tolerated: {allowed_failures})"
            )
    ctx.log.info(
        "salling.food_waste_collected",
        stores=len(store_ids),
        failed=failures,
        clearances=ctx.stats["clearances"],
        listings_new=ctx.stats["listings_new"],
    )
