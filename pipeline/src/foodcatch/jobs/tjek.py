"""Tjek jobs.

* ``tjek-stores`` (weekly) - stores of all dealers in ``chain.tjek_dealer_id``.
* ``tjek-offers`` (daily) - for every dealer: the listed catalogs, then the offers of each food
  catalog that is current or starts within :data:`~foodcatch.sources.tjek.UPCOMING_DAYS` days,
  **if they need fetching** (below).

Every response goes through ``ctx.ingest`` (catalog lists included), so ``foodcatch reprocess``
replays exactly what happened live. An HTTP or network error (after the client's retries) for
one dealer or catalog is logged and counted (``dealer_errors`` / ``catalog_errors``) and the
job continues with the next one; the quality check flags a run that lost a large share of its
data. A schema mismatch or an error for *every* dealer fails the run.

**Skipping unchanged catalogs** (Tjek's API is unofficial; a leaflet rarely changes during its
week). The catalog lists are fetched on every run (one request per dealer). The offer pages of a
catalog are fetched only when (:func:`fetch_reason`):

* ``new`` - the catalog id has no row in ``tjek_catalog_fetch``;
* ``changed`` - its fingerprint (:func:`catalog_fingerprint`: label, period, publish time,
  offer and page counts, cover image) differs from the stored one;
* ``refresh`` - the last full fetch is ``TJEK_FULL_REFRESH_DAYS`` (default 3) days old or older,
  minus :data:`REFRESH_SLACK` for the jitter of the daily schedule. ``0`` fetches every catalog
  (a full refresh).

A skipped catalog's listings stay exactly as they are; nothing treats "not fetched today" as
withdrawn (Tjek ingest never closes listings missing from a payload, and ``last_seen_at`` is only
compared between versions of one offer id, which always belong to the same catalog). The state
row is written in the run's transaction after all pages of the catalog were ingested, so a failed
catalog is fetched again by the next run.

Quality metric: ``records`` (stores seen) for ``tjek-stores``; ``current_listings`` for
``tjek-offers``: Tjek listings still valid after the run whose catalog is a food catalog listed
in this run. It is stable on days that skip unchanged catalogs, and drops when dealers or their
catalogs disappear (``records`` would drop on every skip day).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Collection
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import Connection, delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from foodcatch.db.tables import chain, listing, tjek_catalog_fetch
from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job
from foodcatch.sources import SourceError, SourceHTTPError, SourceNetworkError
from foodcatch.sources.tjek import (
    UPCOMING_DAYS,
    TjekCatalog,
    fetch_catalogs,
    is_current_or_upcoming,
    is_food_catalog,
    iter_offers,
    iter_stores,
)


class TjekJobError(SourceError):
    """No dealer could be fetched at all."""


REFRESH_SLACK = timedelta(hours=6)
"""Tolerance of the ``refresh`` rule: a daily run that starts a little earlier than the one that
fetched the catalog must still count the full number of days."""

STATE_RETENTION = timedelta(days=90)
"""``tjek_catalog_fetch`` rows not fetched for this long are deleted (long expired catalogs)."""

type FetchReason = Literal["new", "changed", "refresh"]


def catalog_fingerprint(catalog: TjekCatalog) -> str:
    """Hash of the catalog-list fields that change when the leaflet's content changes.

    Tjek has no modified/version field. Label, period, publish time, offer and page counts and
    the cover image URL (its file name changes when the page is replaced) are used; the dealer
    and branding blocks are not, they say nothing about the offers.
    """
    fields = {
        "label": catalog.label,
        "run_from": catalog.run_from.isoformat(),
        "run_till": catalog.run_till.isoformat(),
        "publish": catalog.publish.isoformat() if catalog.publish else None,
        "offer_count": catalog.offer_count,
        "page_count": catalog.page_count,
        "cover": catalog.images.view if catalog.images else None,
    }
    encoded = json.dumps(fields, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def fetch_reason(
    state: tuple[str, datetime] | None,
    fingerprint: str,
    now: datetime,
    refresh_days: int,
) -> FetchReason | None:
    """Why the offers of a catalog must be fetched now, or ``None`` to skip them.

    Args:
        state: ``(fingerprint, offers_fetched_at)`` stored for the catalog, if any.
        fingerprint: the catalog's current :func:`catalog_fingerprint`.
        now: the run's start.
        refresh_days: ``TJEK_FULL_REFRESH_DAYS`` (0: always fetch).
    """
    if state is None:
        return "new"
    stored_fingerprint, fetched_at = state
    if stored_fingerprint != fingerprint:
        return "changed"
    if refresh_days == 0 or fetched_at <= now - timedelta(days=refresh_days) + REFRESH_SLACK:
        return "refresh"
    return None


def _fetch_state(conn: Connection, catalog_ids: Collection[str]) -> dict[str, tuple[str, datetime]]:
    rows = conn.execute(
        select(
            tjek_catalog_fetch.c.catalog_id,
            tjek_catalog_fetch.c.fingerprint,
            tjek_catalog_fetch.c.offers_fetched_at,
        ).where(tjek_catalog_fetch.c.catalog_id.in_(sorted(catalog_ids)))
    )
    return {catalog_id: (fp, at) for catalog_id, fp, at in rows}


def _record_fetch(
    conn: Connection, chain_id: str, catalog: TjekCatalog, fingerprint: str, at: datetime
) -> None:
    values = {
        "chain_id": chain_id,
        "fingerprint": fingerprint,
        "offer_count": catalog.offer_count,
        "offers_fetched_at": at,
    }
    stmt = pg_insert(tjek_catalog_fetch).values(catalog_id=catalog.id, **values)
    conn.execute(
        stmt.on_conflict_do_update(index_elements=[tjek_catalog_fetch.c.catalog_id], set_=values)
    )


def current_listings(conn: Connection, catalog_ids: Collection[str], at: datetime) -> int:
    """Tjek listings of ``catalog_ids`` that are still valid after ``at`` (quality metric)."""
    if not catalog_ids:
        return 0
    return conn.execute(
        select(func.count())
        .select_from(listing)
        .where(
            listing.c.source == "tjek",
            listing.c.catalog_id.in_(sorted(catalog_ids)),
            or_(listing.c.valid_to.is_(None), listing.c.valid_to > at),
        )
    ).scalar_one()


def tracked_dealers(conn: Connection) -> list[tuple[str, str]]:
    """``(chain_id, tjek_dealer_id)`` of every chain tracked on Tjek, ordered by chain id."""
    rows = conn.execute(
        select(chain.c.id, chain.c.tjek_dealer_id)
        .where(chain.c.tjek_dealer_id.is_not(None))
        .order_by(chain.c.id)
    )
    return [(chain_id, dealer_id) for chain_id, dealer_id in rows if dealer_id]


def _check_some_succeeded(ctx: JobContext, dealers: int, failed: int) -> None:
    if dealers and failed == dealers:
        raise TjekJobError(f"{ctx.job}: all {dealers} dealers failed; see the log")


@register_job(
    "tjek-stores",
    source="tjek",
    description="Tjek stores of all tracked chains",
    post_fetch=False,
)
def collect_tjek_stores(ctx: JobContext) -> None:
    """Fetch and ingest stores of every tracked dealer."""
    dealers = tracked_dealers(ctx.conn)
    failed = 0
    for chain_id, dealer_id in dealers:
        stores = 0
        try:
            for page in iter_stores(ctx.http, [dealer_id]):
                stores += ctx.ingest(page).records
        except (SourceHTTPError, SourceNetworkError) as exc:
            failed += 1
            ctx.count("dealer_errors")
            ctx.log.error("tjek.dealer_failed", chain=chain_id, dealer_id=dealer_id, error=str(exc))
            continue
        ctx.log.info("tjek.stores_fetched", chain=chain_id, stores=stores)
        if stores == 0:
            ctx.log.warning("tjek.no_stores", chain=chain_id, dealer_id=dealer_id)
    _check_some_succeeded(ctx, len(dealers), failed)


def _collect_catalog(ctx: JobContext, chain_id: str, catalog_id: str, reason: str) -> int:
    """Ingest all offer pages of one catalog; returns the number of offers seen."""
    offers = 0
    for page in iter_offers(ctx.http, catalog_id):
        ctx.count("offer_pages_fetched")
        offers += ctx.ingest(page).records
    ctx.log.info(
        "tjek.catalog_fetched", chain=chain_id, catalog_id=catalog_id, offers=offers, reason=reason
    )
    return offers


@register_job(
    "tjek-offers",
    source="tjek",
    description="Tjek catalogs and offers",
    quality_metric="current_listings",
)
def collect_tjek_offers(ctx: JobContext) -> None:
    """Fetch catalogs of every tracked dealer and the offers of new, changed or due catalogs."""
    dealers = tracked_dealers(ctx.conn)
    refresh_days = ctx.settings.tjek_full_refresh_days
    seen: set[str] = set()
    failed = 0
    for chain_id, dealer_id in dealers:
        try:
            catalogs = fetch_catalogs(ctx.http, dealer_id)
        except (SourceHTTPError, SourceNetworkError) as exc:
            failed += 1
            ctx.count("dealer_errors")
            ctx.log.error("tjek.dealer_failed", chain=chain_id, dealer_id=dealer_id, error=str(exc))
            continue
        ctx.ingest(catalogs)
        wanted: list[TjekCatalog] = []
        for catalog in catalogs.data:
            if not is_food_catalog(catalog.label):
                ctx.count("catalogs_skipped_nonfood")
            elif not is_current_or_upcoming(catalog, ctx.started_at, days_ahead=UPCOMING_DAYS):
                ctx.count("catalogs_skipped_period")
            else:
                wanted.append(catalog)
        state = _fetch_state(ctx.conn, [c.id for c in wanted])
        for catalog in wanted:
            seen.add(catalog.id)
            ctx.count("catalogs_seen")
            fingerprint = catalog_fingerprint(catalog)
            reason = fetch_reason(state.get(catalog.id), fingerprint, ctx.started_at, refresh_days)
            if reason is None:
                ctx.count("catalogs_skipped_unchanged")
                continue
            ctx.count("catalogs_fetched")
            ctx.count(f"catalogs_fetched_{reason}")
            try:
                _collect_catalog(ctx, chain_id, catalog.id, reason)
            except (SourceHTTPError, SourceNetworkError) as exc:
                ctx.count("catalog_errors")
                ctx.log.error(
                    "tjek.catalog_failed", chain=chain_id, catalog_id=catalog.id, error=str(exc)
                )
                continue
            _record_fetch(ctx.conn, chain_id, catalog, fingerprint, ctx.started_at)
    _check_some_succeeded(ctx, len(dealers), failed)
    ctx.conn.execute(
        delete(tjek_catalog_fetch).where(
            tjek_catalog_fetch.c.offers_fetched_at < ctx.started_at - STATE_RETENTION
        )
    )
    ctx.count("current_listings", current_listings(ctx.conn, seen, ctx.started_at))
