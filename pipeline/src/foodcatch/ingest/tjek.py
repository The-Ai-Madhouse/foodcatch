"""Tjek payloads -> ``store`` (source ``tjek``) and offer ``listing`` rows.

Dispatch on ``payload.endpoint``:

* ``stores`` - upsert ``store`` on ``(source, source_store_id)``; chain via
  ``chain.tjek_dealer_id``. Stores outside Denmark and of untracked dealers are skipped.
* ``catalogs`` - nothing to store beyond the raw object (catalog ids are recorded on listings).
* ``offers`` - upsert ``listing`` (source ``tjek``, kind ``offer``, ``catalog_id``) on
  ``(source, source_item_id, valid_from, price)``, normalized by :func:`parse_offer`. When Tjek
  re-publishes an offer id with a new price or start, the earlier versions of that id are
  closed (``valid_to`` = the payload's fetch time, or their start if they never started), so
  only the latest version stays current (:func:`ingest_offers`).
* ``dealers`` - nothing to store (dealer ids are seeded on ``chain``).

Offer normalization (ported from ``poc/foodcatch_poc.py::parse_tjek_offer``):

* **Unit prices** - the SI factor converts the size to kg/l/stk (``pcs`` -> ``stk``);
  ``lo = size.from * factor * pieces.from``, ``hi = size.to * factor * pieces.from``;
  ``unit_price_min = price / hi``, ``unit_price_max = price / lo``. Without a positive size
  range the unit prices stay unknown.
* **Reference price** - ``pricing.pre_price``, else "Normalpris 19,95" in the description.
* **Membership** (:func:`is_member_price`) and **purchase limits**
  (:func:`parse_max_per_customer`) are read from the offer text; see those functions.

Entry point: :func:`ingest_payload` (see :mod:`foodcatch.ingest` for the rules).
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Final, Literal
from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import (
    Boolean,
    Connection,
    func,
    literal_column,
    not_,
    or_,
    select,
    tuple_,
    update,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert

from foodcatch.config import Settings
from foodcatch.db.tables import chain, listing, store
from foodcatch.ingest import IngestResult, RawPayload
from foodcatch.sources import SourceSchemaError
from foodcatch.sources.tjek import (
    CATALOG_LIST,
    COUNTRY_ID,
    ENDPOINT_CATALOGS,
    ENDPOINT_DEALERS,
    ENDPOINT_OFFERS,
    ENDPOINT_STORES,
    OFFER_PAGE,
    STORE_PAGE,
    TjekOffer,
    TjekQuantity,
    TjekStore,
)

SOURCE: Final = "tjek"
KIND: Final = "offer"

type Unit = Literal["kg", "l", "stk"]

_SI_UNITS: Mapping[str, Unit] = {"kg": "kg", "l": "l", "pcs": "stk"}
_CENT = Decimal("0.01")
_UNIT_PRICE_QUANTUM = Decimal("0.0001")

# --------------------------------------------------------------------------- text parsing

# PoC: Netto writes "Normalpris 19,95" in the description when pre_price is missing.
_NORMAL_PRICE = re.compile(r"normalpris\s*([\d.]+,\d{2}|\d+)", re.IGNORECASE)

# A Danish amount: "19,95", "1.299,95", "20", "8" (in "8.-"), "99" (in "99,-").
_AMOUNT = r"(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)"

# "Max. 6 stk. pr. kunde pr. dag", "Maks. 3 ps. pr. kunde", "Max. 6 rammer pr. variant pr.
# kunde", "Max. 6 stk. til denne pris". Never "Pr. kg max. 61,25" (an amount, not a count).
_MAX_PER_CUSTOMER = re.compile(
    r"\bma(?:x|ks)\.?\s*(\d+)\s+(?:[a-zæøå]+\.?\s+)?(?:pr\.?\s+variant\s+)?"
    r"(?:pr\.?\s+(?:kunde|husstand)|til\s+denne\s+pris)",
    re.IGNORECASE,
)

# Any sign that a membership/loyalty programme is involved in the price: "Medlemspris",
# "Medlemsrabat", "Medlemstilbud", "Et medlemskab af Coop", "Kun for medlemmer", "Pris
# ikke-medlem", "Netto+", "Lidl Plus", "føtex plus". A bare "medlem" is not enough ("et nyt
# medlem af familien" is a toy description).
_MEMBERSHIP_HINT = re.compile(
    r"medlems-?\w*|medlemmer|ikke-medlem|netto\+|lidl\s+plus|f[øo]tex\s+plus"
    r"|plus\s*pris|\+\s*pris\s*:?\s*\d|gælder\s+kun\s+med\s+.{0,25}app",
    re.IGNORECASE,
)
# Explicit member prices: Netto "+ PRIS 20:-", føtex "plus pris 99,-", MENY/Coop
# "MEDLEMSPRIS* PR. STK. 19,95" / "Medlemspris 15,96".
_MEMBER_AMOUNT = re.compile(
    r"(?:\+\s*pris|plus\s*pris|medlemspris\*?(?:\s+pr\.\s*[a-zæøå]+\.?)?)\s*:?\s*" + _AMOUNT,
    re.IGNORECASE,
)
# Explicit non-member prices: Coop "Pris ikke-medlem 149,95", "Pris ikke-medlem op til 55,00".
_NON_MEMBER_AMOUNT = re.compile(
    r"ikke-medlem\w*\s*:?\s*(?:op\s+til\s+)?" + _AMOUNT,
    re.IGNORECASE,
)


def parse_amount(text: str) -> Decimal:
    """Parse a Danish amount ("1.299,95", "19,95", "20") into a :class:`Decimal`."""
    return Decimal(text.replace(".", "").replace(",", "."))


def parse_normal_price(description: str | None) -> Decimal | None:
    """The "Normalpris x,xx" amount in an offer description, if any (PoC rule)."""
    match = _NORMAL_PRICE.search(description or "")
    if match is None:
        return None
    return parse_amount(match.group(1))


def parse_max_per_customer(text: str | None, pieces_max: int | None = None) -> int | None:
    """Per-customer purchase limit from "Max. N stk. pr. kunde" (or Tjek's ``pieces.max``).

    The text wins; ``pieces.max`` (which Tjek fills with the same number when it parses the
    limit itself) is only a fallback.
    """
    match = _MAX_PER_CUSTOMER.search(text or "")
    if match is not None:
        return int(match.group(1))
    return pieces_max if pieces_max and pieces_max > 0 else None


def is_member_price(text: str | None, price: Decimal) -> bool:
    """Whether ``price`` may only be available to members of a loyalty programme.

    Leaflets show membership prices in three ways, handled in this order:

    1. An explicit non-member price ("Pris ikke-medlem 149,95"): the offer price is a member
       price unless it equals one of the non-member prices.
    2. An explicit extra member price next to the regular one (Netto "+ PRIS 20:- ... Gælder kun
       med Netto+ appen", føtex "plus pris 99,-", "Medlemspris 15,96"): the offer price is a
       member price only if it equals one of those amounts.
    3. Any other membership hint ("Med Lidl Plus", "Gælder kun med Netto+ appen" without a
       second price, "Et medlemskab af Coop ..."): conservatively treated as a member price.

    Args:
        text: heading and description of the offer.
        price: the offer price.
    """
    text = text or ""
    if not _MEMBERSHIP_HINT.search(text):
        return False
    price = price.quantize(_CENT)
    non_member = {
        parse_amount(m.group(1)).quantize(_CENT) for m in _NON_MEMBER_AMOUNT.finditer(text)
    }
    if non_member:
        return price not in non_member
    member = {parse_amount(m.group(1)).quantize(_CENT) for m in _MEMBER_AMOUNT.finditer(text)}
    if member:
        return price in member
    return True


# ------------------------------------------------------------------------ offer normalization


@dataclass(frozen=True, slots=True)
class UnitQuantity:
    """Purchasable quantity of an offer in its base unit (``size_min <= size_max``)."""

    unit: Unit | None
    size_min: Decimal | None = None
    size_max: Decimal | None = None


def unit_quantity(quantity: TjekQuantity | None) -> UnitQuantity:
    """Base unit and size range of an offer (PoC rule).

    The SI factor converts the size to the base unit; the pack count (``pieces.from``)
    multiplies it. The size is unknown unless both ends of the range are positive.
    """
    if quantity is None:
        return UnitQuantity(unit=None)
    si = quantity.unit.si if quantity.unit else None
    unit = _SI_UNITS.get(si.symbol or "") if si else None
    if unit is None:
        return UnitQuantity(unit=None)
    size = quantity.size
    if size is None or not size.from_ or not size.to:
        return UnitQuantity(unit=unit)
    factor = (si.factor if si else None) or Decimal(1)
    pieces = (quantity.pieces.from_ if quantity.pieces else None) or Decimal(1)
    lo = size.from_ * factor * pieces
    hi = size.to * factor * pieces
    if lo <= 0 or hi <= 0:
        return UnitQuantity(unit=unit)
    lo, hi = min(lo, hi), max(lo, hi)
    return UnitQuantity(unit=unit, size_min=lo, size_max=hi)


@dataclass(frozen=True, slots=True)
class ParsedOffer:
    """A Tjek offer normalized to ``listing`` columns (without chain/provenance)."""

    source_item_id: str
    dealer_id: str
    catalog_id: str | None
    title: str
    description: str
    price: Decimal
    reference_price: Decimal | None
    unit: Unit | None
    size_min: Decimal | None
    size_max: Decimal | None
    unit_price_min: Decimal | None
    unit_price_max: Decimal | None
    member_only: bool
    max_per_customer: int | None
    valid_from: datetime
    valid_to: datetime | None


def _unit_price(price: Decimal, size: Decimal) -> Decimal:
    return (price / size).quantize(_UNIT_PRICE_QUANTUM, rounding=ROUND_HALF_UP)


def parse_offer(offer: TjekOffer) -> ParsedOffer:
    """Normalize one Tjek offer (port of the PoC's ``parse_tjek_offer``)."""
    raw_description = offer.description or ""
    price = offer.pricing.price.quantize(_CENT, rounding=ROUND_HALF_UP)
    quantity = unit_quantity(offer.quantity)
    unit_price_min = unit_price_max = None
    if quantity.size_min is not None and quantity.size_max is not None:
        unit_price_min = _unit_price(price, quantity.size_max)
        unit_price_max = _unit_price(price, quantity.size_min)
    reference = offer.pricing.pre_price or parse_normal_price(raw_description)
    pieces = offer.quantity.pieces if offer.quantity else None
    text = f"{offer.heading}\n{raw_description}"
    return ParsedOffer(
        source_item_id=offer.id,
        dealer_id=offer.dealer_id,
        catalog_id=offer.catalog_id,
        title=offer.heading.strip(),
        description=raw_description.replace("\n", " ").strip(),
        price=price,
        reference_price=(reference.quantize(_CENT, rounding=ROUND_HALF_UP) if reference else None),
        unit=quantity.unit,
        size_min=quantity.size_min,
        size_max=quantity.size_max,
        unit_price_min=unit_price_min,
        unit_price_max=unit_price_max,
        member_only=is_member_price(text, price),
        max_per_customer=parse_max_per_customer(text, pieces.max if pieces else None),
        valid_from=offer.run_from,
        valid_to=offer.run_till,
    )


# --------------------------------------------------------------------------------- ingest

# Listing columns owned by this ingester; a change in any of them marks the listing changed.
_CONTENT_COLUMNS: Final = (
    "chain_id",
    "catalog_id",
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
_STORE_COLUMNS: Final = ("chain_id", "name", "street", "zip", "city", "lat", "lon")


def _dealer_chains(conn: Connection) -> dict[str, str]:
    """``tjek_dealer_id -> chain.id`` for all tracked chains."""
    rows = conn.execute(
        select(chain.c.tjek_dealer_id, chain.c.id).where(chain.c.tjek_dealer_id.is_not(None))
    )
    return {dealer_id: chain_id for dealer_id, chain_id in rows if dealer_id}


def _validate[T](adapter: TypeAdapter[T], payload: RawPayload) -> T:
    try:
        return adapter.validate_json(payload.body)
    except ValidationError as exc:
        raise SourceSchemaError(
            f"tjek/{payload.endpoint} raw object {payload.raw_object_id} does not match the "
            f"schema: {exc.error_count()} error(s)"
        ) from exc


def ingest_stores(
    conn: Connection, stores: Sequence[TjekStore], *, dealer_chains: Mapping[str, str]
) -> IngestResult:
    """Upsert Danish stores of tracked dealers (``store.source = 'tjek'``)."""
    result = IngestResult()
    rows: dict[str, dict[str, Any]] = {}
    for s in stores:
        chain_id = dealer_chains.get(s.dealer_id)
        if s.country is not None and s.country.id != COUNTRY_ID:
            result.counts["stores_skipped_foreign"] += 1
            continue
        if chain_id is None:
            result.counts["stores_skipped_unknown_dealer"] += 1
            continue
        rows[s.id] = {
            "source": SOURCE,
            "source_store_id": s.id,
            "chain_id": chain_id,
            "name": s.name,
            "street": s.street,
            "zip": s.zip_code,
            "city": s.city,
            "lat": s.latitude,
            "lon": s.longitude,
        }
    result.records = len(rows)
    if not rows:
        return result
    stmt = pg_insert(store).values(list(rows.values()))
    stmt = stmt.on_conflict_do_update(
        index_elements=[store.c.source, store.c.source_store_id],
        set_={**{c: stmt.excluded[c] for c in _STORE_COLUMNS}, "last_seen_at": func.now()},
    )
    conn.execute(stmt)
    result.counts["stores_upserted"] += len(rows)
    return result


def _listing_row(offer: ParsedOffer, chain_id: str, raw_object_id: UUID) -> dict[str, Any]:
    row = asdict(offer)
    del row["dealer_id"]
    return {
        **row,
        "source": SOURCE,
        "kind": KIND,
        "chain_id": chain_id,
        "raw_object_id": raw_object_id,
    }


def _close_superseded(
    conn: Connection, keys: Sequence[tuple[str, datetime, Decimal]], at: datetime
) -> set[UUID]:
    """Close open versions of the page's offer ids that are not in the page.

    Tjek re-publishes an offer id with a corrected price or start date; the natural key then
    yields a second listing while the earlier one would stay current until its own end. Such
    an earlier version gets ``valid_to = at`` (or ``valid_from`` if it never started), like a
    superseded Rema price period. Closing twice changes nothing, so a replay is idempotent.
    """
    closed_at = func.greatest(listing.c.valid_from, at)
    stmt = (
        update(listing)
        .where(
            listing.c.source == SOURCE,
            listing.c.source_item_id.in_(sorted({item_id for item_id, _, _ in keys})),
            not_(tuple_(listing.c.source_item_id, listing.c.valid_from, listing.c.price).in_(keys)),
            or_(listing.c.valid_to.is_(None), listing.c.valid_to > closed_at),
        )
        .values(valid_to=closed_at)
        .returning(listing.c.id)
    )
    return set(conn.execute(stmt).scalars())


def ingest_offers(
    conn: Connection,
    offers: Iterable[TjekOffer],
    *,
    dealer_chains: Mapping[str, str],
    raw_object_id: UUID,
    fetched_at: datetime,
) -> IngestResult:
    """Upsert offers as ``listing`` rows and report inserted, changed or closed listing ids.

    Three statements per page: an upsert that only rewrites rows whose content differs (so its
    ``RETURNING`` yields exactly the inserted/changed listings), a touch of
    ``last_seen_at``/``raw_object_id`` on every listing of the page, and the closing of earlier
    versions of the page's offer ids (:func:`_close_superseded`, at ``fetched_at``).
    """
    result = IngestResult()
    rows: dict[tuple[str, datetime, Decimal], dict[str, Any]] = {}
    for offer in offers:
        result.records += 1
        parsed = parse_offer(offer)
        chain_id = dealer_chains.get(parsed.dealer_id)
        if chain_id is None:
            result.counts["offers_skipped_unknown_dealer"] += 1
            continue
        key = (parsed.source_item_id, parsed.valid_from, parsed.price)
        rows[key] = _listing_row(parsed, chain_id, raw_object_id)
    if not rows:
        return result

    stmt = pg_insert(listing).values(list(rows.values()))
    excluded = stmt.excluded
    stmt = stmt.on_conflict_do_update(
        index_elements=[
            listing.c.source,
            listing.c.source_item_id,
            listing.c.valid_from,
            listing.c.price,
        ],
        set_={
            **{c: excluded[c] for c in _CONTENT_COLUMNS},
            "last_seen_at": func.now(),
            "raw_object_id": excluded.raw_object_id,
        },
        where=or_(*(listing.c[c].is_distinct_from(excluded[c]) for c in _CONTENT_COLUMNS)),
    ).returning(listing.c.id, literal_column("xmax = 0", Boolean).label("inserted"))
    changed = conn.execute(stmt).all()
    inserted = sum(1 for row in changed if row.inserted)
    result.listing_ids.update(row.id for row in changed)
    result.counts["offers_inserted"] += inserted
    result.counts["offers_updated"] += len(changed) - inserted
    result.counts["offers_unchanged"] += len(rows) - len(changed)

    conn.execute(
        update(listing)
        .where(
            listing.c.source == SOURCE,
            tuple_(listing.c.source_item_id, listing.c.valid_from, listing.c.price).in_(list(rows)),
        )
        .values(last_seen_at=func.now(), raw_object_id=raw_object_id)
    )
    closed = _close_superseded(conn, list(rows), fetched_at.astimezone(UTC))
    result.listing_ids.update(closed)
    result.counts["offers_closed"] += len(closed)
    return result


def ingest_payload(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
    """Parse one raw tjek payload and upsert normalized rows.

    Raises:
        SourceSchemaError: if the body does not match the endpoint's model.
        ValueError: for an endpoint this ingester does not know.
    """
    if payload.endpoint == ENDPOINT_OFFERS:
        return ingest_offers(
            conn,
            _validate(OFFER_PAGE, payload),
            dealer_chains=_dealer_chains(conn),
            raw_object_id=payload.raw_object_id,
            fetched_at=payload.fetched_at,
        )
    if payload.endpoint == ENDPOINT_STORES:
        stores = _validate(STORE_PAGE, payload)
        return ingest_stores(conn, stores, dealer_chains=_dealer_chains(conn))
    if payload.endpoint == ENDPOINT_CATALOGS:
        catalogs = _validate(CATALOG_LIST, payload)
        return IngestResult(counts=Counter({"catalogs": len(catalogs)}))
    if payload.endpoint == ENDPOINT_DEALERS:
        return IngestResult()
    raise ValueError(f"tjek: unknown endpoint {payload.endpoint!r}")
