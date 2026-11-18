"""Salling jobs (owned by the Salling module).

* ``salling-stores`` (weekly) - :func:`foodcatch.sources.salling.iter_stores` for every brand
  in ``BRANDS``; ``ctx.ingest(page)`` per page. Quality metric: ``records`` (stores).
* ``salling-food-waste`` (twice daily) - geo-tiled food-waste collection within a hard request
  budget (ADR 0005). The Salling key gets HTTP 429 for a long period after about 60 requests,
  so the job cannot ask every store separately. Instead it queries
  :func:`foodcatch.sources.salling.fetch_food_waste_near` (one request returns the ~17 nearest
  stores) at points chosen by :class:`foodcatch.jobs.salling_geo.GeoTiler`: the region stores
  (``REGION_CENTERS`` / ``REGION_RADIUS_KM``, whose clearances become listings) first, then the
  rest of the country in rotation, least recently checked first. Each response is one raw
  object, ingested with ``ctx.ingest`` like before. Covered stores get
  ``store.food_waste_checked_at`` = the run start, which drives the rotation.

  Limits and outcome:

  - At most ``SALLING_FOOD_WASTE_MAX_CALLS`` requests per run (including the store list
    bootstrap when no store is known yet).
  - Requests are sent without retries (:data:`foodcatch.http.NO_RETRY`). A **429** stops
    fetching at once (``quota_exhausted``; the ``Retry-After`` value is logged), the data
    fetched so far is kept. 401/403 and schema mismatches fail the run. Other HTTP or network
    errors are tolerated: the target is retried once, and after :data:`MAX_FAILED_CALLS`
    failures fetching stops.
  - The run is ``degraded`` (via :meth:`~foodcatch.jobs.context.JobContext.degrade`) when the
    region was not fully covered, whatever stopped it. National coverage may stay incomplete:
    it is completed by later runs.
  - Quality metric: ``region_clearances`` - valid clearances of the region stores, each store
    counted once. It does not depend on how much of the rest of the country a run covered.
"""

from __future__ import annotations

from datetime import timedelta

import httpx
from sqlalchemy import Connection, func, select, update

from foodcatch.config import Settings
from foodcatch.db.tables import chain, store
from foodcatch.geo import in_region
from foodcatch.http import NO_RETRY
from foodcatch.ingest.salling import STORE_SOURCE, is_valid_clearance
from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job
from foodcatch.jobs.salling_geo import GeoTiler, ReturnedStore, TargetStore
from foodcatch.sources import Fetched, SourceHTTPError
from foodcatch.sources.salling import (
    BRANDS,
    FoodWasteResponse,
    fetch_food_waste_near,
    iter_stores,
)

STORE_MAX_AGE = timedelta(days=21)
"""Stores not seen by the weekly store job (or a food-waste response) for this long are skipped."""
AUTH_STATUS_CODES = frozenset({401, 403})
RATE_LIMITED = 429
MAX_FAILED_CALLS = 3
"""Failed requests (other than 429) after which a food-waste run stops fetching."""
QUALITY_METRIC = "region_clearances"


class QuotaExhaustedError(Exception):
    """Salling answered 429: the key's request quota is used up."""

    def __init__(self, retry_after: str | None) -> None:
        super().__init__(f"HTTP 429 (Retry-After: {retry_after})")
        self.retry_after = retry_after


def _rate_limited(exc: SourceHTTPError) -> QuotaExhaustedError:
    return QuotaExhaustedError(exc.headers.get("retry-after"))


def load_target_stores(
    conn: Connection, settings: Settings, *, max_age: timedelta = STORE_MAX_AGE
) -> list[TargetStore]:
    """Salling stores with coordinates seen within ``max_age``, with region flag and check time."""
    rows = conn.execute(
        select(
            store.c.source_store_id,
            chain.c.salling_brand,
            store.c.lat,
            store.c.lon,
            store.c.food_waste_checked_at,
        )
        .join(chain, chain.c.id == store.c.chain_id)
        .where(
            store.c.source == STORE_SOURCE,
            store.c.last_seen_at >= func.now() - max_age,
            store.c.lat.is_not(None),
            store.c.lon.is_not(None),
        )
        .order_by(store.c.source_store_id)
    ).all()
    return [
        TargetStore(
            id=str(store_id),
            brand=str(brand or ""),
            lat=float(lat),
            lon=float(lon),
            in_region=in_region(lat, lon, settings.region_centers, settings.region_radius_km),
            checked_at=checked_at,
        )
        for store_id, brand, lat, lon, checked_at in rows
    ]


def mark_checked(ctx: JobContext, store_ids: set[str]) -> None:
    """Persist the rotation state: ``store.food_waste_checked_at`` = the run start."""
    if not store_ids:
        return
    ctx.conn.execute(
        update(store)
        .where(store.c.source == STORE_SOURCE, store.c.source_store_id.in_(sorted(store_ids)))
        .values(food_waste_checked_at=ctx.started_at)
    )


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


class _FoodWasteRun:
    """State of one ``salling-food-waste`` run (see the module docstring)."""

    def __init__(self, ctx: JobContext, api_key: str) -> None:
        self.ctx = ctx
        self.api_key = api_key
        self.budget = ctx.settings.salling_food_waste_max_calls
        self.calls = 0
        self.failures = 0
        self.stop_reason = ""
        self.responded: set[str] = set()

    def _spend(self) -> None:
        self.calls += 1
        self.ctx.count("salling_calls")

    def bootstrap_stores(self) -> None:
        """Fetch the store list (no store known yet), within the budget and without retries.

        Raises:
            QuotaExhaustedError: on HTTP 429.
        """
        self.ctx.log.info("salling.no_known_stores", action="fetching store list first")
        bootstrapped = 0
        try:
            for brand in BRANDS:
                for page in iter_stores(self.ctx.http, self.api_key, brand=brand, retry=NO_RETRY):
                    # One request per page: Salling announces further pages in the Link header.
                    self._spend()
                    bootstrapped += self.ctx.ingest(page).records
                    if self.calls >= self.budget:
                        self.stop_reason = f"call budget of {self.budget} used up"
                        return
        except SourceHTTPError as exc:
            self._spend()
            if exc.status_code == RATE_LIMITED:
                raise _rate_limited(exc) from exc
            raise
        finally:
            # Store pages are not clearances: keep `records` comparable between runs.
            self.ctx.count("records", -bootstrapped)
            self.ctx.count("stores_bootstrapped", bootstrapped)

    def fetch(self, target: TargetStore) -> Fetched[list[FoodWasteResponse]] | None:
        """One geo request at ``target``; ``None`` if it failed in a tolerated way.

        Raises:
            QuotaExhaustedError: on HTTP 429.
            SourceHTTPError: on 401/403.
        """
        self._spend()
        try:
            return fetch_food_waste_near(
                self.ctx.http, self.api_key, lat=target.lat, lon=target.lon, retry=NO_RETRY
            )
        except SourceHTTPError as exc:
            if exc.status_code == RATE_LIMITED:
                raise _rate_limited(exc) from exc
            if exc.status_code in AUTH_STATUS_CODES:
                raise
            error = str(exc)
        except httpx.TransportError as exc:
            error = repr(exc)
        self.failures += 1
        self.ctx.count("geo_calls_failed")
        self.ctx.log.warning("salling.geo_call_failed", target=target.id, error=error)
        return None

    def count_new_stores(self, fetched: Fetched[list[FoodWasteResponse]]) -> None:
        """Per-store counters, each store once per run (responses overlap)."""
        settings = self.ctx.settings
        for response in fetched.data:
            item = response.store
            if item.id in self.responded:
                continue
            self.responded.add(item.id)
            self.ctx.count("stores_responded")
            lat, lon = item.lat, item.lon
            if (
                lat is not None
                and lon is not None
                and in_region(lat, lon, settings.region_centers, settings.region_radius_km)
            ):
                self.ctx.count("region_stores_responded")
                self.ctx.count(
                    QUALITY_METRIC, sum(1 for c in response.clearances if is_valid_clearance(c))
                )

    def tile(self, tiler: GeoTiler) -> None:
        """Query until everything is covered, the budget is spent or fetching must stop.

        Raises:
            QuotaExhaustedError: on HTTP 429 (data fetched before it is kept).
        """
        while True:
            target = tiler.next_target()
            if target is None:
                return
            if self.calls >= self.budget:
                self.stop_reason = f"call budget of {self.budget} used up"
                self.ctx.state.stats["budget_exhausted"] = True
                return
            fetched = self.fetch(target)
            if fetched is None:
                tiler.mark_failed(target)
                if self.failures >= MAX_FAILED_CALLS:
                    self.stop_reason = f"{self.failures} requests failed"
                    return
                continue
            self.ctx.count("geo_calls")
            self.ctx.ingest(fetched)
            self.count_new_stores(fetched)
            coverage = tiler.mark_covered(
                target,
                [
                    ReturnedStore(r.store.id, r.store.brand, r.store.lat, r.store.lon)
                    for r in fetched.data
                ],
            )
            self.ctx.count("stores_inferred_absent", len(coverage.inferred))
            self.ctx.log.info(
                "salling.geo_call",
                target=target.id,
                region=target.in_region,
                returned=len(fetched.data),
                newly_covered=len(coverage.stores),
                calls=self.calls,
            )


@register_job(
    "salling-food-waste",
    source="salling",
    description="Salling food-waste clearances (geo-tiled, region first)",
    quality_metric=QUALITY_METRIC,
)
def collect_salling_food_waste(ctx: JobContext) -> None:
    """Fetch and ingest food-waste clearances: the region every run, the country in rotation."""
    api_key = ctx.settings.require_salling_api_key()
    run = _FoodWasteRun(ctx, api_key)
    ctx.state.stats["call_budget"] = run.budget
    ctx.count(QUALITY_METRIC, 0)
    tiler = GeoTiler([])
    try:
        targets = load_target_stores(ctx.conn, ctx.settings)
        if not targets:
            run.bootstrap_stores()
            targets = load_target_stores(ctx.conn, ctx.settings)
        tiler = GeoTiler(targets)
        run.tile(tiler)
    except QuotaExhaustedError as exc:
        run.stop_reason = "Salling quota exhausted (HTTP 429)"
        ctx.state.stats["quota_exhausted"] = True
        ctx.log.warning(
            "salling.quota_exhausted",
            retry_after=exc.retry_after,
            calls=run.calls,
            region_covered=tiler.region_covered,
            region_stores=tiler.region_total,
        )

    mark_checked(ctx, tiler.covered | run.responded)
    stats = ctx.state.stats
    stats["stores_known"] = len(tiler.stores)
    stats["stores_covered"] = len(tiler.covered)
    stats["region_stores"] = tiler.region_total
    stats["region_stores_covered"] = tiler.region_covered
    stats["national_stores"] = tiler.national_total
    stats["national_stores_covered"] = tiler.national_covered
    if not tiler.stores:
        ctx.degrade(f"no Salling store known ({run.stop_reason or 'the store list is empty'})")
    elif not tiler.region_complete:
        ctx.degrade(
            f"food-waste region not fully covered: {tiler.region_covered} of "
            f"{tiler.region_total} stores ({run.stop_reason or 'every target was tried'})"
        )
    elif run.stop_reason:
        ctx.log.warning("salling.food_waste_stopped_early", reason=run.stop_reason)
    ctx.log.info(
        "salling.food_waste_collected",
        calls=run.calls,
        region_stores=tiler.region_total,
        region_covered=tiler.region_covered,
        national_covered=tiler.national_covered,
        national_stores=tiler.national_total,
        region_clearances=stats[QUALITY_METRIC],
        listings_new=stats["listings_new"],
    )
