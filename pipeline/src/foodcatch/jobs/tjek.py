"""Tjek jobs.

* ``tjek-stores`` (weekly) - stores of all dealers in ``chain.tjek_dealer_id``.
* ``tjek-offers`` (daily) - for every dealer: the listed catalogs, then all offers of each food
  catalog that is current or starts within :data:`~foodcatch.sources.tjek.UPCOMING_DAYS` days.

Every response goes through ``ctx.ingest`` (catalog lists included), so ``foodcatch reprocess``
replays exactly what happened live. An HTTP error for one dealer or catalog is logged and
counted (``dealer_errors`` / ``catalog_errors``) and the job continues with the next one; the
record-count quality check flags a run that lost a large share of its data. A schema mismatch
or an error for *every* dealer fails the run.

Quality metric: ``records`` (stores resp. offers seen).
"""

from __future__ import annotations

from sqlalchemy import Connection, select

from foodcatch.db.tables import chain
from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job
from foodcatch.sources import SourceError, SourceHTTPError
from foodcatch.sources.tjek import (
    UPCOMING_DAYS,
    fetch_catalogs,
    is_current_or_upcoming,
    is_food_catalog,
    iter_offers,
    iter_stores,
)


class TjekJobError(SourceError):
    """No dealer could be fetched at all."""


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
        except SourceHTTPError as exc:
            failed += 1
            ctx.count("dealer_errors")
            ctx.log.error("tjek.dealer_failed", chain=chain_id, dealer_id=dealer_id, error=str(exc))
            continue
        ctx.log.info("tjek.stores_fetched", chain=chain_id, stores=stores)
        if stores == 0:
            ctx.log.warning("tjek.no_stores", chain=chain_id, dealer_id=dealer_id)
    _check_some_succeeded(ctx, len(dealers), failed)


def _collect_catalog(ctx: JobContext, chain_id: str, catalog_id: str) -> int:
    """Ingest all offer pages of one catalog; returns the number of offers seen."""
    offers = 0
    for page in iter_offers(ctx.http, catalog_id):
        offers += ctx.ingest(page).records
    ctx.log.info("tjek.catalog_fetched", chain=chain_id, catalog_id=catalog_id, offers=offers)
    return offers


@register_job("tjek-offers", source="tjek", description="Tjek catalogs and offers")
def collect_tjek_offers(ctx: JobContext) -> None:
    """Fetch and ingest current catalogs and their offers for every tracked dealer."""
    dealers = tracked_dealers(ctx.conn)
    failed = 0
    for chain_id, dealer_id in dealers:
        try:
            catalogs = fetch_catalogs(ctx.http, dealer_id)
        except SourceHTTPError as exc:
            failed += 1
            ctx.count("dealer_errors")
            ctx.log.error("tjek.dealer_failed", chain=chain_id, dealer_id=dealer_id, error=str(exc))
            continue
        ctx.ingest(catalogs)
        for catalog in catalogs.data:
            if not is_food_catalog(catalog.label):
                ctx.count("catalogs_skipped_nonfood")
                continue
            if not is_current_or_upcoming(catalog, ctx.started_at, days_ahead=UPCOMING_DAYS):
                ctx.count("catalogs_skipped_period")
                continue
            ctx.count("catalogs_fetched")
            try:
                _collect_catalog(ctx, chain_id, catalog.id)
            except SourceHTTPError as exc:
                ctx.count("catalog_errors")
                ctx.log.error(
                    "tjek.catalog_failed", chain=chain_id, catalog_id=catalog.id, error=str(exc)
                )
    _check_some_succeeded(ctx, len(dealers), failed)
