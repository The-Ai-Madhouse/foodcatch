"""Open Food Facts job (owned by the Open Food Facts module).

* ``off-enrich`` (daily) - look up products with ``off_checked_at IS NULL`` (bounded batch per
  run to respect the rate limit); ``ctx.ingest(response)`` per EAN. No quality metric (the
  number of unchecked EANs varies naturally).
"""

from __future__ import annotations

from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job


@register_job(
    "off-enrich",
    source="openfoodfacts",
    description="Open Food Facts enrichment of new EANs",
    quality_metric=None,
    post_fetch=False,
)
def collect_off_enrich(ctx: JobContext) -> None:
    """Enrich products that have not been looked up in Open Food Facts yet."""
    raise NotImplementedError
