"""Rema payloads -> ``listing`` rows (owned by the Rema module).

``products`` - one listing per product price: source ``rema``, chain ``rema1000``, kind
``regular`` (``is_campaign`` false) or ``offer`` (true); unit from ``compare_unit``
(``ltr``/``liter`` -> ``l``, ``stk.`` -> ``stk``), ``unit_price_min = unit_price_max =
compare_unit_price``; ``valid_from``/``valid_to`` = ``starting_at``/``ending_at``.

Entry point: :func:`ingest_payload` (see :mod:`foodcatch.ingest` for the rules).
"""

from __future__ import annotations

from sqlalchemy import Connection

from foodcatch.config import Settings
from foodcatch.ingest import IngestResult, RawPayload


def ingest_payload(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
    """Parse one raw rema payload and upsert normalized rows."""
    raise NotImplementedError
