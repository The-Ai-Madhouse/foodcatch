"""Open Food Facts payloads -> ``product`` enrichment.

``product`` - update the ``product`` row with the payload's EAN (from ``payload.params``):

* found: ``quantity_text``, ``net_quantity``/``net_unit`` (normalized to kg, l or stk),
  ``nova_group`` (1-4), ``nutriscore_grade`` (a-e) are set from the response (values Open Food
  Facts does not have become NULL); ``name``/``brand`` are filled only when still empty
  (Salling's data wins).
* not found: only ``off_checked_at`` is set, earlier enrichment is kept.

``off_checked_at`` is always set to the payload's ``fetched_at`` (not ``now()``), so the EAN is
not retried daily and replaying the raw store reproduces the live state. Products are never
created here: unknown EANs are counted and skipped.

Also home of :func:`eans_due_for_enrichment`, the selection query of the ``off-enrich`` job.

Entry point: :func:`ingest_payload` (see :mod:`foodcatch.ingest` for the rules).
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Final

from pydantic import ValidationError
from sqlalchemy import Connection, func, or_, select, update

from foodcatch.config import Settings
from foodcatch.db.tables import NUTRISCORE_GRADES, product
from foodcatch.ingest import IngestResult, RawPayload
from foodcatch.sources import SourceSchemaError
from foodcatch.sources.openfoodfacts import (
    EAN_PATTERN,
    ENDPOINT_PRODUCT,
    OffProduct,
    OffProductResponse,
)

RECHECK_AFTER: Final = timedelta(days=90)
"""Products checked longer ago than this are looked up again."""

# unit -> (normalized unit, divisor converting the amount into the normalized unit)
_UNIT_FACTORS: Mapping[str, tuple[str, Decimal]] = {
    "mg": ("kg", Decimal(1_000_000)),
    "g": ("kg", Decimal(1000)),
    "gr": ("kg", Decimal(1000)),
    "gram": ("kg", Decimal(1000)),
    "kg": ("kg", Decimal(1)),
    "ml": ("l", Decimal(1000)),
    "cl": ("l", Decimal(100)),
    "dl": ("l", Decimal(10)),
    "l": ("l", Decimal(1)),
    "ltr": ("l", Decimal(1)),
    "liter": ("l", Decimal(1)),
    "stk": ("stk", Decimal(1)),
    "pcs": ("stk", Decimal(1)),
}
# A single amount with a unit at the start of the quantity text ("500 g", "1,5 l"); multipacks
# such as "6 x 33 cl" deliberately do not match.
_QUANTITY_TEXT = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*([a-z]+)\.?(?:\s|$)", re.IGNORECASE)
_QUANTITY_STEP = Decimal("0.0001")


class UnsupportedEndpointError(ValueError):
    """The payload's endpoint is not one this ingester understands."""


class MissingEanError(ValueError):
    """The payload carries no usable EAN."""


@dataclass(frozen=True, slots=True)
class Enrichment:
    """Normalized product facts from one Open Food Facts product."""

    name: str | None
    brand: str | None
    quantity_text: str | None
    net_quantity: Decimal | None
    net_unit: str | None
    nova_group: int | None
    nutriscore_grade: str | None


def normalize_quantity(amount: Decimal, unit: str) -> tuple[Decimal, str] | None:
    """Convert ``amount`` ``unit`` to kg, l or stk; ``None`` for unknown units or amounts <= 0.

    >>> normalize_quantity(Decimal(500), "g")
    (Decimal('0.5'), 'kg')
    """
    factor = _UNIT_FACTORS.get(unit.strip().lower().rstrip("."))
    if factor is None or amount <= 0:
        return None
    net_unit, divisor = factor
    value = (amount / divisor).quantize(_QUANTITY_STEP, ROUND_HALF_UP).normalize()
    if value <= 0:
        return None
    return value, net_unit


def net_quantity(item: OffProduct) -> tuple[Decimal, str] | None:
    """Net content from ``product_quantity`` + unit, else from a simple ``quantity`` text."""
    if item.product_quantity is not None and item.product_quantity_unit:
        return normalize_quantity(item.product_quantity, item.product_quantity_unit)
    if item.quantity:
        match = _QUANTITY_TEXT.match(item.quantity)
        if match:
            amount = Decimal(match.group(1).replace(",", "."))
            return normalize_quantity(amount, match.group(2))
    return None


def _nova(value: int | None) -> int | None:
    return value if value is not None and 1 <= value <= 4 else None


def _nutriscore(value: str | None) -> str | None:
    grade = (value or "").strip().lower()
    return grade if grade in NUTRISCORE_GRADES else None


def _first_brand(brands: str | None) -> str | None:
    if not brands:
        return None
    first = brands.split(",")[0].strip()
    return first or None


def extract(item: OffProduct) -> Enrichment:
    """Normalize the fields we keep from an Open Food Facts product."""
    quantity = net_quantity(item)
    return Enrichment(
        name=item.product_name,
        brand=_first_brand(item.brands),
        quantity_text=item.quantity,
        net_quantity=quantity[0] if quantity else None,
        net_unit=quantity[1] if quantity else None,
        nova_group=_nova(item.nova_group),
        nutriscore_grade=_nutriscore(item.nutriscore_grade),
    )


def _payload_ean(payload: RawPayload, response: OffProductResponse) -> str:
    ean = str(payload.params.get("ean") or response.code).strip()
    if not EAN_PATTERN.fullmatch(ean):
        raise MissingEanError(f"openfoodfacts payload {payload.raw_object_id} has no valid EAN")
    return ean


def ingest_payload(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
    """Apply one raw ``openfoodfacts`` product response to the ``product`` table.

    Raises:
        UnsupportedEndpointError: for an endpoint other than ``product``.
        SourceSchemaError: if the stored body is not a valid product response.
        MissingEanError: if neither the params nor the body carry a valid EAN.
    """
    del settings  # no configuration needed
    if payload.endpoint != ENDPOINT_PRODUCT:
        raise UnsupportedEndpointError(f"openfoodfacts: unsupported endpoint {payload.endpoint!r}")
    try:
        response = OffProductResponse.model_validate_json(payload.body)
    except ValidationError as exc:
        raise SourceSchemaError(
            f"openfoodfacts/{payload.endpoint}: invalid payload: {exc}"
        ) from exc
    ean = _payload_ean(payload, response)

    values: dict[str, Any] = {"off_checked_at": payload.fetched_at}
    counts: Counter[str] = Counter()
    if response.found and response.product is not None:
        found = extract(response.product)
        values.update(
            quantity_text=found.quantity_text,
            net_quantity=found.net_quantity,
            net_unit=found.net_unit,
            nova_group=found.nova_group,
            nutriscore_grade=found.nutriscore_grade,
            name=func.coalesce(product.c.name, found.name),
            brand=func.coalesce(product.c.brand, found.brand),
        )
        counts["off_found"] += 1
    else:
        counts["off_not_found"] += 1

    updated = conn.execute(
        update(product).where(product.c.ean == ean).values(**values).returning(product.c.id)
    ).first()
    if updated is None:
        counts["off_unknown_ean"] += 1
    return IngestResult(records=1, counts=counts)


def eans_due_for_enrichment(
    conn: Connection, *, now: datetime, limit: int, recheck_after: timedelta = RECHECK_AFTER
) -> list[str]:
    """EANs to look up: never checked first, then those checked before ``now - recheck_after``.

    Only well-formed EANs (8-14 digits) are returned, so a malformed one never blocks the batch.
    """
    stmt = (
        select(product.c.ean)
        .where(product.c.ean.regexp_match(f"^{EAN_PATTERN.pattern}$"))
        .where(
            or_(
                product.c.off_checked_at.is_(None),
                product.c.off_checked_at < now - recheck_after,
            )
        )
        .order_by(
            product.c.off_checked_at.asc().nulls_first(),
            product.c.first_seen_at,
            product.c.ean,
        )
        .limit(limit)
    )
    return list(conn.execute(stmt).scalars())
