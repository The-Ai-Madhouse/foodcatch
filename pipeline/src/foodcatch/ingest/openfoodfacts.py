"""Open Food Facts payloads -> ``product`` enrichment (owned by the OFF module).

``product`` - update ``product`` (by EAN from ``payload.params``): name/brand if empty,
``quantity_text``, ``net_quantity``/``net_unit``, ``nova_group``, ``nutriscore_grade``; always
set ``off_checked_at`` (also for "not found", so the EAN is not retried daily).

Entry point: :func:`ingest_payload` (see :mod:`foodcatch.ingest` for the rules).
"""

from __future__ import annotations

from sqlalchemy import Connection

from foodcatch.config import Settings
from foodcatch.ingest import IngestResult, RawPayload


def ingest_payload(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
    """Parse one raw openfoodfacts payload and upsert normalized rows."""
    raise NotImplementedError
