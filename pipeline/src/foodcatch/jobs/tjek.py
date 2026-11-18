"""Tjek jobs (owned by the Tjek module).

* ``tjek-stores`` (weekly) - stores of all dealers in ``chain.tjek_dealer_id``.
* ``tjek-offers`` (daily) - for every dealer: current catalogs (skip "Nonfood"), then all
  offers of each catalog; ``ctx.ingest(page)`` for every response (catalog lists included).

Quality metric: ``records``.
"""

from __future__ import annotations

from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job


@register_job(
    "tjek-stores",
    source="tjek",
    description="Tjek stores of all tracked chains",
    post_fetch=False,
)
def collect_tjek_stores(ctx: JobContext) -> None:
    """Fetch and ingest stores of every tracked dealer."""
    raise NotImplementedError


@register_job("tjek-offers", source="tjek", description="Tjek catalogs and offers")
def collect_tjek_offers(ctx: JobContext) -> None:
    """Fetch and ingest current catalogs and their offers for every tracked dealer."""
    raise NotImplementedError
