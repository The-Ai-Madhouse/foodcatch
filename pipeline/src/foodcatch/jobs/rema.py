"""Rema job.

* ``rema-products`` (daily) - every page of the catalogue; ``ctx.ingest(page)`` per page.
  Quality metric: ``records`` (product price periods).

After all pages, price periods of products that disappeared from the catalogue are closed, but
only when the run saw (nearly) the whole catalogue as announced by ``meta.pagination.total``, so
a truncated response never ends the prices of thousands of products. That step lives in
:class:`~foodcatch.ingest.rema.CatalogueRun`, so ``foodcatch reprocess`` replays it per run.
"""

from __future__ import annotations

from foodcatch.ingest.rema import COMPLETE_CATALOGUE_FRACTION, CatalogueRun
from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job
from foodcatch.sources.rema import PAGE_SIZE, iter_product_pages

__all__ = ["COMPLETE_CATALOGUE_FRACTION", "collect_rema_products"]


@register_job("rema-products", source="rema", description="REMA 1000 catalogue and prices")
def collect_rema_products(ctx: JobContext) -> None:
    """Fetch and ingest the complete REMA 1000 catalogue."""
    catalogue = CatalogueRun()
    for page in iter_product_pages(ctx.http, per_page=PAGE_SIZE):
        ctx.ingest(page)
        catalogue.add_page(page.data)
    if not catalogue.complete:
        ctx.log.warning(
            "rema.incomplete_catalogue",
            products_seen=len(catalogue.seen),
            announced_total=catalogue.announced_total,
        )
    ctx.record_ingest(catalogue.finish(ctx.conn, at=ctx.started_at))
