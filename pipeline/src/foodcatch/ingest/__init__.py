"""Ingest: raw payload -> normalized rows (architecture §4 step 4).

Each source has one module exposing a single entry point with the :class:`Ingester` signature::

    def ingest_payload(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult

It parses ``payload.body`` with the source's pydantic models (dispatching on
``payload.endpoint``) and upserts rows on their natural keys. Rules:

* **Idempotent**: ingesting the same payload twice yields the same database state.
* Runs inside the caller's transaction: never call ``commit()``/``begin()`` on ``conn``
  (use ``conn.begin_nested()`` if a savepoint is needed).
* Set ``last_seen_at = now()`` on every row it sees (the ``api`` views rely on it) and
  ``raw_object_id = payload.raw_object_id`` on listings.
* Report every inserted or updated ``listing.id`` in ``IngestResult.listing_ids`` so the
  post-fetch hooks classify them and recompute deals.

The same function is used live (``JobContext.ingest``) and when replaying the raw store
(``foodcatch reprocess``), which guarantees reprocessing reproduces live ingest.
"""

from __future__ import annotations

import importlib
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, cast
from uuid import UUID

from sqlalchemy import Connection

from foodcatch.config import Settings
from foodcatch.sources import RAW_SOURCES

INGEST_MODULES: Mapping[str, str] = {source: f"foodcatch.ingest.{source}" for source in RAW_SOURCES}
INGEST_ENTRY_POINT = "ingest_payload"


@dataclass(frozen=True, slots=True)
class RawPayload:
    """A stored raw object together with its (uncompressed) body."""

    raw_object_id: UUID
    source: str
    endpoint: str
    params: Mapping[str, Any]
    body: bytes
    fetched_at: datetime


@dataclass(slots=True)
class IngestResult:
    """Outcome of ingesting one or more payloads.

    Attributes:
        records: number of domain records seen (the default job quality metric).
        listing_ids: ids of listings inserted or changed (input for classify/deals).
        counts: free-form counters merged into ``fetch_run.stats`` (e.g. ``stores_upserted``).
    """

    records: int = 0
    listing_ids: set[UUID] = field(default_factory=set[UUID])
    counts: Counter[str] = field(default_factory=Counter[str])

    def merge(self, other: IngestResult) -> IngestResult:
        """Add ``other`` into this result (in place) and return ``self``."""
        self.records += other.records
        self.listing_ids |= other.listing_ids
        self.counts.update(other.counts)
        return self


class Ingester(Protocol):
    """Signature of every ``foodcatch.ingest.<source>.ingest_payload``."""

    def __call__(
        self, conn: Connection, payload: RawPayload, *, settings: Settings
    ) -> IngestResult: ...


class UnknownSourceError(KeyError):
    """Raised for a source without an ingest module."""


def get_ingester(source: str) -> Ingester:
    """Return ``foodcatch.ingest.<source>.ingest_payload``.

    Raises:
        UnknownSourceError: if ``source`` is not one of :data:`foodcatch.sources.RAW_SOURCES`.
    """
    try:
        module_name = INGEST_MODULES[source]
    except KeyError as exc:
        raise UnknownSourceError(source) from exc
    module = importlib.import_module(module_name)
    return cast(Ingester, getattr(module, INGEST_ENTRY_POINT))


__all__ = [
    "INGEST_MODULES",
    "IngestResult",
    "Ingester",
    "RawPayload",
    "UnknownSourceError",
    "get_ingester",
]
