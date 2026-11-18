"""Open Food Facts job.

* ``off-enrich`` (daily) - look up products whose EAN was never checked (or was checked more
  than 90 days ago), at most ``OFF_BATCH_SIZE`` per run (default 500, about 6 minutes at the
  client's 1.5 requests/s, well within Open Food Facts' 100 reads/minute);
  ``ctx.ingest(response)`` per EAN. No quality metric (the number of unchecked EANs varies
  naturally).

A failed lookup of one EAN (HTTP error after retries, unreadable response) is logged, counted
as ``off_errors`` and skipped - the EAN stays unchecked and is retried next run. Several failures
in a row mean Open Food Facts is unavailable and fail the run.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from foodcatch.ingest.openfoodfacts import eans_due_for_enrichment
from foodcatch.jobs.context import JobContext
from foodcatch.jobs.registry import register_job
from foodcatch.sources import SourceError
from foodcatch.sources.openfoodfacts import fetch_product

DEFAULT_BATCH_SIZE: Final = 500
MAX_CONSECUTIVE_ERRORS: Final = 5


class OffEnrichSettings(BaseSettings):
    """Settings of the ``off-enrich`` job (``OFF_BATCH_SIZE``)."""

    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False, frozen=True)

    off_batch_size: int = Field(default=DEFAULT_BATCH_SIZE, ge=1, le=10_000)


def load_job_settings(env_file: Path | None) -> OffEnrichSettings:
    """Read the job settings from the environment and the pipeline's ``.env`` file."""
    return OffEnrichSettings(_env_file=env_file)  # pyright: ignore[reportCallIssue]


@register_job(
    "off-enrich",
    source="openfoodfacts",
    description="Open Food Facts enrichment of new EANs",
    quality_metric=None,
    post_fetch=False,
)
def collect_off_enrich(ctx: JobContext) -> None:
    """Enrich products that have not been looked up in Open Food Facts yet."""
    batch_size = load_job_settings(ctx.settings.env_file_path).off_batch_size
    eans = eans_due_for_enrichment(ctx.conn, now=ctx.started_at, limit=batch_size)
    ctx.count("off_due", len(eans))
    ctx.log.info("off.batch", eans=len(eans), batch_size=batch_size)
    consecutive_errors = 0
    for ean in eans:
        try:
            fetched = fetch_product(ctx.http, ean)
        except SourceError as exc:
            consecutive_errors += 1
            ctx.count("off_errors")
            ctx.log.warning("off.lookup_failed", ean=ean, error=str(exc))
            if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                raise
            continue
        consecutive_errors = 0
        ctx.ingest(fetched)
