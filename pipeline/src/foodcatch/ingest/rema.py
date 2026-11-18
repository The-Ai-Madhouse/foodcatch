"""Rema payloads -> ``listing`` rows.

``products`` - one listing per product price period: source ``rema``, chain ``rema1000``,
``source_item_id`` = product id, kind ``regular`` (``is_campaign`` false) or ``offer`` (true),
``title`` = name, ``description`` = underline, unit from ``compare_unit`` (``kg``; ``ltr``/
``liter``/``l`` -> ``l``; ``stk``/``stk.`` -> ``stk``; other units such as ``ml`` or ``mtr`` are
left without unit and unit price rather than guessed), ``unit_price_min = unit_price_max =
compare_unit_price`` and ``size = price / compare_unit_price`` (rounded to 3 decimals; the
compare price itself is rounded by Rema, so the size is approximate),
``max_per_customer`` = ``max_quantity``.

Validity: Rema sends calendar dates as midnight-UTC timestamps. They are read as Danish calendar
days, giving the half-open period ``[start day 00:00, day after end day 00:00)`` in
``Europe/Copenhagen``, so a campaign "until 21 Nov" stays current all of 21 Nov. ``ending_at``
in 2099 means "until further notice" and becomes ``valid_to = NULL``. Timestamps that are not a
plain midnight UTC are taken as they are.

History: the natural key ``(source, source_item_id, valid_from, price)`` turns Rema's price
periods into history. A product's open price period that no longer appears in a newer payload
(e.g. a regular price replaced by a new one) is closed at the payload's ``fetched_at``; products
missing from the whole catalogue are closed by the job (:func:`close_vanished_products`).

Matching hint: about 40 % of Rema's organic products carry the ``Økologi`` label without the word
appearing in the name or underline. The matcher reads organic status from the text and treats
its absence as "not organic", so ``ØKOLOGISK`` is appended to the description for those products.

Entry point: :func:`ingest_payload` (see :mod:`foodcatch.ingest` for the rules).
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Final
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import ValidationError
from sqlalchemy import Boolean, Connection, func, literal_column, not_, or_, tuple_, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import insert as pg_insert

from foodcatch.config import Settings
from foodcatch.db.tables import listing
from foodcatch.ingest import IngestResult, RawPayload
from foodcatch.sources import SourceSchemaError
from foodcatch.sources.rema import ENDPOINT_PRODUCTS, RemaPrice, RemaProduct, RemaProductPage

SOURCE: Final = "rema"
CHAIN_ID: Final = "rema1000"
COPENHAGEN: Final = ZoneInfo("Europe/Copenhagen")
OPEN_END_YEAR: Final = 2099
"""``ending_at`` in this year or later means the price has no announced end."""

ORGANIC_LABEL: Final = "Økologi"
ORGANIC_HINT: Final = "ØKOLOGISK"
_ORGANIC_TEXT = re.compile(r"økologisk|\bøko\b", re.IGNORECASE)

_UNITS: Mapping[str, str] = {
    "kg": "kg",
    "kilo": "kg",
    "l": "l",
    "ltr": "l",
    "liter": "l",
    "stk": "stk",
}
_CENT = Decimal("0.01")
_UNIT_PRICE_STEP = Decimal("0.0001")
_SIZE_STEP = Decimal("0.001")
_UPSERT_CHUNK = 1000  # rows per INSERT; ~20 columns each keeps us far below 65535 parameters

# Columns whose change makes a listing "changed" (re-classified, deals recomputed).
_CONTENT_COLUMNS: Final = (
    "chain_id",
    "kind",
    "title",
    "description",
    "reference_price",
    "unit",
    "size_min",
    "size_max",
    "unit_price_min",
    "unit_price_max",
    "member_only",
    "max_per_customer",
    "valid_to",
)


class UnsupportedEndpointError(ValueError):
    """The payload's endpoint is not one this ingester understands."""


# --------------------------------------------------------------------------- normalization
def normalize_unit(compare_unit: str | None) -> str | None:
    """Map Rema's ``compare_unit`` to ``kg``/``l``/``stk``; ``None`` for anything else.

    >>> normalize_unit("ltr"), normalize_unit("stk."), normalize_unit("mtr")
    ('l', 'stk', None)
    """
    if compare_unit is None:
        return None
    return _UNITS.get(compare_unit.strip().lower().rstrip("."))


def _is_calendar_date(ts: datetime) -> bool:
    return ts.utcoffset() == timedelta(0) and ts.time() == time(0)


def _danish_midnight(ts: datetime, *, days: int = 0) -> datetime:
    day = ts.date() + timedelta(days=days)
    return datetime.combine(day, time(0), tzinfo=COPENHAGEN)


def to_valid_from(starting_at: datetime) -> datetime:
    """Start of the validity period (see module docstring)."""
    return _danish_midnight(starting_at) if _is_calendar_date(starting_at) else starting_at


def to_valid_to(ending_at: datetime) -> datetime | None:
    """Exclusive end of the validity period, ``None`` for "until further notice"."""
    if ending_at.year >= OPEN_END_YEAR:
        return None
    return _danish_midnight(ending_at, days=1) if _is_calendar_date(ending_at) else ending_at


def describe(product: RemaProduct) -> str:
    """Listing description: the underline plus an organic hint when only the label says so."""
    description = product.underline.strip()
    if ORGANIC_LABEL in product.label_names and not _ORGANIC_TEXT.search(
        f"{product.name} {description}"
    ):
        return f"{description} / {ORGANIC_HINT}" if description else ORGANIC_HINT
    return description


@dataclass(frozen=True, slots=True)
class RemaListing:
    """A normalized Rema price period, ready to upsert as a ``listing`` row."""

    source_item_id: str
    kind: str
    title: str
    description: str
    price: Decimal
    unit: str | None
    size: Decimal | None
    unit_price: Decimal | None
    max_per_customer: int | None
    valid_from: datetime
    valid_to: datetime | None
    extra: Mapping[str, Any]

    @property
    def key(self) -> tuple[str, datetime, Decimal]:
        """Natural key within the source: ``(source_item_id, valid_from, price)``."""
        return (self.source_item_id, self.valid_from, self.price)

    def as_row(self, raw_object_id: UUID) -> dict[str, Any]:
        """Column values for :data:`foodcatch.db.tables.listing`."""
        return {
            "source": SOURCE,
            "source_item_id": self.source_item_id,
            "chain_id": CHAIN_ID,
            "store_id": None,
            "catalog_id": None,
            "kind": self.kind,
            "title": self.title,
            "description": self.description,
            "product_id": None,
            "price": self.price,
            "reference_price": None,
            "unit": self.unit,
            "size_min": self.size,
            "size_max": self.size,
            "unit_price_min": self.unit_price,
            "unit_price_max": self.unit_price,
            "member_only": False,
            "max_per_customer": self.max_per_customer,
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "raw_object_id": raw_object_id,
            "extra": dict(self.extra),
        }


def _decimal_or_none(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def build_listing(product: RemaProduct, price: RemaPrice) -> RemaListing | None:
    """Normalize one price period; ``None`` if its period is invalid (ends before it starts)."""
    valid_from = to_valid_from(price.starting_at)
    valid_to = to_valid_to(price.ending_at)
    if valid_to is not None and valid_to < valid_from:
        return None
    amount = price.price.quantize(_CENT, ROUND_HALF_UP)
    unit = normalize_unit(price.compare_unit)
    unit_price: Decimal | None = None
    size: Decimal | None = None
    if unit is not None and price.compare_unit_price is not None and price.compare_unit_price > 0:
        unit_price = price.compare_unit_price.quantize(_UNIT_PRICE_STEP, ROUND_HALF_UP)
        size = (amount / price.compare_unit_price).quantize(_SIZE_STEP, ROUND_HALF_UP)
        if size <= 0:
            unit_price = size = None
    if unit_price is None:
        unit = None
    # Every key is always present (null when absent) so a disappearing value overwrites the
    # stored one while keys written by other modules (e.g. matching) survive the merge.
    extra: dict[str, Any] = {
        "is_advertised": price.is_advertised,
        "is_weight_item": product.is_weight_item,
        "compare_unit": price.compare_unit,
        "deposit": _decimal_or_none(price.deposit),
        "price_over_max_quantity": _decimal_or_none(price.price_over_max_quantity),
        "labels": product.label_names,
    }
    return RemaListing(
        source_item_id=str(product.id),
        kind="offer" if price.is_campaign else "regular",
        title=product.name.strip(),
        description=describe(product),
        price=amount,
        unit=unit,
        size=size,
        unit_price=unit_price,
        max_per_customer=price.max_quantity or None,
        valid_from=valid_from,
        valid_to=valid_to,
        extra=extra,
    )


@dataclass(frozen=True, slots=True)
class NormalizedPage:
    """The listings of one page plus counters about what was skipped."""

    listings: list[RemaListing]
    product_ids: list[str]
    counts: Counter[str]


def normalize_page(page: RemaProductPage) -> NormalizedPage:
    """Turn a validated page into de-duplicated listings (pure; no database access)."""
    counts: Counter[str] = Counter()
    by_key: dict[tuple[str, datetime, Decimal], RemaListing] = {}
    product_ids: list[str] = []
    for product in page.data:
        product_ids.append(str(product.id))
        counts["rema_products"] += 1
        if not product.prices:
            counts["rema_products_without_price"] += 1
        for price in product.prices:
            item = build_listing(product, price)
            if item is None:
                counts["rema_invalid_periods"] += 1
                continue
            if item.unit is None:
                counts["rema_prices_without_unit_price"] += 1
            if item.key in by_key:
                counts["rema_duplicate_prices"] += 1
            by_key[item.key] = item
    return NormalizedPage(list(by_key.values()), product_ids, counts)


# ------------------------------------------------------------------------------- database
def _key_column() -> Any:
    return tuple_(listing.c.source_item_id, listing.c.valid_from, listing.c.price)


def _upsert(
    conn: Connection, listings: Sequence[RemaListing], raw_object_id: UUID
) -> tuple[set[UUID], set[UUID]]:
    """Insert new listings and update changed ones; returns ``(inserted, updated)`` ids.

    Unchanged rows are left alone here (see :func:`_touch`), so the ids returned are exactly
    the listings that need classification and deal recomputation.
    """
    inserted: set[UUID] = set()
    updated: set[UUID] = set()
    for start in range(0, len(listings), _UPSERT_CHUNK):
        chunk = listings[start : start + _UPSERT_CHUNK]
        stmt = pg_insert(listing).values([item.as_row(raw_object_id) for item in chunk])
        excluded = stmt.excluded
        changed = or_(
            *(listing.c[name].is_distinct_from(excluded[name]) for name in _CONTENT_COLUMNS),
            not_(listing.c.extra.contains(excluded.extra)),
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[
                listing.c.source,
                listing.c.source_item_id,
                listing.c.valid_from,
                listing.c.price,
            ],
            set_={
                **{name: excluded[name] for name in _CONTENT_COLUMNS},
                "extra": listing.c.extra.op("||", return_type=JSONB)(excluded.extra),
                "raw_object_id": excluded.raw_object_id,
                "last_seen_at": func.now(),
            },
            where=changed,
        ).returning(listing.c.id, literal_column("(xmax = 0)", Boolean).label("inserted"))
        for row in conn.execute(stmt):
            (inserted if row.inserted else updated).add(row.id)
    return inserted, updated


def _touch(
    conn: Connection, keys: Sequence[tuple[str, datetime, Decimal]], raw_object_id: UUID
) -> None:
    """Mark every listing of the payload as seen now (including unchanged ones)."""
    for start in range(0, len(keys), _UPSERT_CHUNK):
        conn.execute(
            update(listing)
            .where(listing.c.source == SOURCE)
            .where(_key_column().in_(keys[start : start + _UPSERT_CHUNK]))
            .values(last_seen_at=func.now(), raw_object_id=raw_object_id)
        )


def _closed_at(at: datetime) -> Any:
    """``valid_to`` of a period closed at ``at`` (a period that never started ends at its start)."""
    return func.greatest(listing.c.valid_from, at)


def _open_after(at: datetime) -> Any:
    """Periods that closing at ``at`` would shorten (so closing twice changes nothing)."""
    return or_(listing.c.valid_to.is_(None), listing.c.valid_to > _closed_at(at))


def _close_superseded(
    conn: Connection,
    product_ids: Collection[str],
    keys: Sequence[tuple[str, datetime, Decimal]],
    at: datetime,
) -> set[UUID]:
    """Close open price periods of ``product_ids`` that are no longer in the payload.

    A period that is still open (or not yet started) at ``at`` but missing from the payload was
    withdrawn or replaced: its ``valid_to`` becomes ``at`` (or ``valid_from`` for a period that
    never started).
    """
    if not product_ids:
        return set()
    stmt = (
        update(listing)
        .where(listing.c.source == SOURCE)
        .where(listing.c.source_item_id.in_(list(product_ids)))
        .where(_open_after(at))
        .values(valid_to=_closed_at(at))
        .returning(listing.c.id)
    )
    if keys:
        stmt = stmt.where(not_(_key_column().in_(list(keys))))
    return set(conn.execute(stmt).scalars())


def close_vanished_products(
    conn: Connection, *, seen_item_ids: Collection[str], at: datetime
) -> set[UUID]:
    """Close every open Rema price period of products missing from a complete catalogue.

    Call this only after a run fetched the *whole* catalogue: every open (or future) period of
    a product id not in ``seen_item_ids`` gets ``valid_to = at``. Returns the closed ids.
    """
    stmt = (
        update(listing)
        .where(listing.c.source == SOURCE)
        .where(_open_after(at))
        .values(valid_to=_closed_at(at))
        .returning(listing.c.id)
    )
    if seen_item_ids:
        stmt = stmt.where(not_(listing.c.source_item_id.in_(list(seen_item_ids))))
    return set(conn.execute(stmt).scalars())


def ingest_page(
    conn: Connection, page: RemaProductPage, *, raw_object_id: UUID, fetched_at: datetime
) -> IngestResult:
    """Upsert one validated page (see module docstring)."""
    normalized = normalize_page(page)
    keys = [item.key for item in normalized.listings]
    inserted, updated = _upsert(conn, normalized.listings, raw_object_id)
    _touch(conn, keys, raw_object_id)
    closed = _close_superseded(conn, normalized.product_ids, keys, fetched_at.astimezone(UTC))
    counts = normalized.counts
    counts["rema_listings_inserted"] += len(inserted)
    counts["rema_listings_updated"] += len(updated)
    counts["rema_listings_closed"] += len(closed)
    return IngestResult(
        records=len(normalized.listings),
        listing_ids=inserted | updated | closed,
        counts=counts,
    )


def _parse(payload: RawPayload) -> RemaProductPage:
    if payload.endpoint != ENDPOINT_PRODUCTS:
        raise UnsupportedEndpointError(f"rema: unsupported endpoint {payload.endpoint!r}")
    try:
        return RemaProductPage.model_validate_json(payload.body)
    except ValidationError as exc:
        raise SourceSchemaError(f"rema/{payload.endpoint}: invalid payload: {exc}") from exc


def ingest_payload(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
    """Parse one raw ``rema`` payload and upsert its listings.

    Raises:
        UnsupportedEndpointError: for an endpoint other than ``products``.
        SourceSchemaError: if the stored body does not match :class:`RemaProductPage`.
    """
    del settings  # Rema ingest needs no configuration
    page = _parse(payload)
    return ingest_page(
        conn, page, raw_object_id=payload.raw_object_id, fetched_at=payload.fetched_at
    )


COMPLETE_CATALOGUE_FRACTION: Final = 0.95
"""Share of ``meta.pagination.total`` a run must see before vanished products are closed."""


@dataclass(slots=True)
class CatalogueRun:
    """The run-level step of ``rema-products``: close products that left the catalogue.

    Fed with every page of one run (live by the job, on replay by ``foodcatch reprocess``),
    :meth:`finish` closes the open price periods of products the run did not see - but only
    when it saw (nearly) the whole catalogue as announced by ``meta.pagination.total``, so a
    truncated response never ends the prices of thousands of products.
    """

    seen: set[str] = field(default_factory=set[str])
    announced_total: int = 0

    def add_page(self, page: RemaProductPage) -> None:
        """Take note of one page of the run."""
        self.announced_total = max(self.announced_total, page.meta.pagination.total)
        self.seen |= item_ids(page.data)

    def add(self, payload: RawPayload) -> None:
        """:class:`~foodcatch.ingest.RunReplay`: take note of one stored page."""
        self.add_page(_parse(payload))

    @property
    def complete(self) -> bool:
        """Whether the run saw enough of the catalogue to close vanished products."""
        return bool(self.seen) and len(self.seen) >= COMPLETE_CATALOGUE_FRACTION * (
            self.announced_total
        )

    def finish(self, conn: Connection, *, at: datetime) -> IngestResult:
        """Close vanished products as of ``at`` (the run's ``started_at``) if complete."""
        result = IngestResult()
        result.counts["rema_products_seen"] = len(self.seen)
        if not self.complete:
            result.counts["rema_vanished_check_skipped"] += 1
            return result
        closed = close_vanished_products(conn, seen_item_ids=self.seen, at=at)
        result.counts["rema_listings_closed_vanished"] += len(closed)
        result.listing_ids |= closed
        return result


def replay_run() -> CatalogueRun:
    """Entry point for ``foodcatch reprocess`` (see :mod:`foodcatch.ingest`)."""
    return CatalogueRun()


def item_ids(products: Iterable[RemaProduct]) -> set[str]:
    """``source_item_id`` values of ``products``."""
    return {str(product.id) for product in products}
