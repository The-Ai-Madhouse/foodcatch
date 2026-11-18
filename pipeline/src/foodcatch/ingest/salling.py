"""Salling payloads -> ``store`` (source ``salling``), ``product``, ``product_reference_price``
and food-waste ``listing`` rows (owned by the Salling module).

Dispatch on ``payload.endpoint``:

* ``stores`` - upsert ``store`` on ``(source, source_store_id)``; chain via
  ``chain.salling_brand``; coordinates are ``[lon, lat]``; drop hours/attributes.
* ``food-waste`` - for **all** stores upsert ``product`` (on ``ean`` = ``product.ean``, never
  ``offer.ean``; ``source_category`` = the Danish category path) and
  ``product_reference_price`` from ``originalPrice`` (new row only when the price changes).
  Only for stores within ``settings.region_radius_km`` of ``settings.region_centers``
  (:func:`foodcatch.geo.in_region`) upsert ``listing`` rows: source ``salling_food_waste``,
  kind ``clearance``, ``store_id`` set, ``product_id`` set, ``price`` = newPrice,
  ``reference_price`` = originalPrice, ``valid_from``/``valid_to`` = startTime/endTime,
  ``extra`` = ``{"stock": <number>, "stock_unit": <text>, "percent_discount": <number>}``
  (``api.food_waste_near`` reads ``stock``/``stock_unit``).

Entry point: :func:`ingest_payload` (see :mod:`foodcatch.ingest` for the rules).
"""

from __future__ import annotations

from sqlalchemy import Connection

from foodcatch.config import Settings
from foodcatch.ingest import IngestResult, RawPayload


def ingest_payload(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
    """Parse one raw salling payload and upsert normalized rows."""
    raise NotImplementedError
