"""Rema job (owned by the Rema module).

* ``rema-products`` (daily) - every page of the catalogue; ``ctx.ingest(page)`` per page.
  Quality metric: ``records`` (product prices).
"""

from __future__ import annotations

from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job


@register_job("rema-products", source="rema", description="REMA 1000 catalogue and prices")
def collect_rema_products(ctx: JobContext) -> None:
    """Fetch and ingest the complete REMA 1000 catalogue."""
    raise NotImplementedError
