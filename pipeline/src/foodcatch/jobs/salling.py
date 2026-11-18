"""Salling jobs (owned by the Salling module).

* ``salling-stores`` (weekly) - :func:`foodcatch.sources.salling.iter_stores` for every brand
  in ``BRANDS``; ``ctx.ingest(page)`` per page. Quality metric: ``records`` (stores).
* ``salling-food-waste`` (twice daily) - for every Salling store in the DB (all of Denmark),
  :func:`foodcatch.sources.salling.fetch_food_waste`; ``ctx.ingest(response)`` per store.
  Quality metric: ``records`` (clearances).

Use ``ctx.settings.require_salling_api_key()`` and ``ctx.http``.
"""

from __future__ import annotations

from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job


@register_job(
    "salling-stores",
    source="salling",
    description="Salling Group stores (Netto, føtex, Bilka)",
    post_fetch=False,
)
def collect_salling_stores(ctx: JobContext) -> None:
    """Fetch and ingest all Salling stores."""
    raise NotImplementedError


@register_job(
    "salling-food-waste",
    source="salling",
    description="Salling food-waste clearances for all stores",
)
def collect_salling_food_waste(ctx: JobContext) -> None:
    """Fetch and ingest food-waste clearances of every Salling store."""
    raise NotImplementedError
