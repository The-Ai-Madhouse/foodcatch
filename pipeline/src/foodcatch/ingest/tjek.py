"""Tjek payloads -> ``store`` (source ``tjek``) and offer ``listing`` rows (Tjek module).

Dispatch on ``payload.endpoint``:

* ``stores`` - upsert ``store`` on ``(source, source_store_id)``; chain via
  ``chain.tjek_dealer_id``.
* ``catalogs`` - nothing to store beyond the raw object (catalog ids are recorded on listings).
* ``offers`` - upsert ``listing`` (source ``tjek``, kind ``offer``, ``catalog_id``) on
  ``(source, source_item_id, valid_from, price)``: unit/size/unit prices per the PoC rule,
  ``reference_price`` from ``pre_price`` or "Normalpris" in the description,
  ``member_only`` from membership hints, ``max_per_customer`` from "Max. N stk.".

Entry point: :func:`ingest_payload` (see :mod:`foodcatch.ingest` for the rules).
"""

from __future__ import annotations

from sqlalchemy import Connection

from foodcatch.config import Settings
from foodcatch.ingest import IngestResult, RawPayload


def ingest_payload(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
    """Parse one raw tjek payload and upsert normalized rows."""
    raise NotImplementedError
