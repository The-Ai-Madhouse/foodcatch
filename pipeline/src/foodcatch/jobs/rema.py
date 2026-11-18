"""Rema job.

* ``rema-products`` (daily) - every page of the catalogue; ``ctx.ingest(page)`` per page.
  Quality metric: ``records`` (product price periods).

After all pages, price periods of products that disappeared from the catalogue are closed, but
only when the run saw (nearly) the whole catalogue as announced by ``meta.pagination.total``, so
a truncated response never ends the prices of thousands of products.
"""

from __future__ import annotations

from typing import Final

from foodcatch.ingest.rema import close_vanished_products, item_ids
from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job
from foodcatch.sources.rema import PAGE_SIZE, iter_product_pages

COMPLETE_CATALOGUE_FRACTION: Final = 0.95
"""Share of ``meta.pagination.total`` a run must see before vanished products are closed."""


@register_job("rema-products", source="rema", description="REMA 1000 catalogue and prices")
def collect_rema_products(ctx: JobContext) -> None:
    """Fetch and ingest the complete REMA 1000 catalogue."""
    seen: set[str] = set()
    announced_total = 0
    for page in iter_product_pages(ctx.http, per_page=PAGE_SIZE):
        announced_total = max(announced_total, page.data.meta.pagination.total)
        ctx.ingest(page)
        seen |= item_ids(page.data.data)
    ctx.count("rema_products_seen", len(seen))

    if not seen or len(seen) < COMPLETE_CATALOGUE_FRACTION * announced_total:
        ctx.count("rema_vanished_check_skipped")
        ctx.log.warning(
            "rema.incomplete_catalogue",
            products_seen=len(seen),
            announced_total=announced_total,
        )
        return
    closed = close_vanished_products(ctx.conn, seen_item_ids=seen, at=ctx.started_at)
    ctx.count("rema_listings_closed_vanished", len(closed))
    ctx.mark_listings(closed)
