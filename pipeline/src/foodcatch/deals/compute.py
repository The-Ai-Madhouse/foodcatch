"""Deal computation (architecture §6; owned by the deals module).

:func:`recompute_deals` upserts ``deal`` rows (current matcher version) for every current or
upcoming Netto offer variant affected by ``listing_ids``: the Netto listings themselves and
Netto offers whose class matches a changed competitor/Rema/history listing. For each variant:

* ``netto_unit_price_worst`` / ``_best`` from the listing's unit-price range,
* ``price_applies`` (homogeneous offer or unit-price spread <= 25 %),
* ``references`` - **all** same-class references (``comparability == "same"`` and the
  reference's price applies to its variant): ``offer``, ``regular``, ``history``,
  ``ean_reference`` as JSON objects
  ``{kind, chain_id, listing_id, title, unit_price, unit, valid_from, valid_to}``.

Runs inside the caller's transaction (never commit).
"""

from __future__ import annotations

from collections.abc import Collection
from uuid import UUID

from sqlalchemy import Connection


def recompute_deals(conn: Connection, *, listing_ids: Collection[UUID] | None = None) -> int:
    """Recompute deals affected by ``listing_ids`` (``None`` = all); returns rows written.

    Stub: writes nothing until the deals module is implemented (a no-op hook).
    """
    del conn, listing_ids
    return 0
