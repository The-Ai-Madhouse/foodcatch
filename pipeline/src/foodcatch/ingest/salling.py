"""Salling payloads -> ``store`` (source ``salling``), ``product``, ``product_reference_price``
and food-waste ``listing`` rows (owned by the Salling module).

Dispatch on ``payload.endpoint``:

* ``stores`` - upsert ``store`` on ``(source, source_store_id)``; chain via
  ``chain.salling_brand``; coordinates are ``[lon, lat]``; hours/attributes are not kept.
  Stores outside Denmark or of an unmapped brand are skipped (counted).
* ``food-waste`` - the response's ``store`` is upserted as above. Then, for **all** stores:

  - ``product`` is upserted on ``ean`` = ``product.ean`` (never ``offer.ean``, which is the
    clearance-label code) with ``name`` = the abbreviated description and ``source_category`` =
    the Danish category path. Only real GTINs become products: short in-store codes and
    restricted-circulation numbers (variable-weight goods such as ``"250913"``) are not
    globally unique, so those clearances get no ``product_id`` (the code is kept in
    ``listing.extra.product_code``).
  - ``product_reference_price`` records ``originalPrice`` per (product, chain), see
    :func:`record_reference_prices`. Variable-weight clearances (``stockUnit = kg``) are
    skipped: their original price is the price of one particular package, not a shelf price.

  Only for stores within ``settings.region_radius_km`` of ``settings.region_centers``
  (:func:`foodcatch.geo.in_region`) ``listing`` rows are upserted: source
  ``salling_food_waste``, kind ``clearance``, ``store_id`` and ``product_id`` set, ``price`` =
  newPrice, ``reference_price`` = originalPrice, ``valid_from``/``valid_to`` =
  startTime/endTime, ``unit``/sizes/unit prices from the net size stated in the name (see
  :func:`parse_net_size`; null when the name states none) and ``extra`` =
  ``{stock, stock_unit, percent_discount, offer_ean, product_code, image, category}``.
  The natural key is ``(source, source_item_id, valid_from, price)`` with
  ``source_item_id = "<store id>:<offer ean>"``.

Entry point: :func:`ingest_payload` (see :mod:`foodcatch.ingest` for the rules).
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import Connection, bindparam, func, select, update
from sqlalchemy.dialects.postgresql import insert

from foodcatch.config import Settings
from foodcatch.db.tables import (
    chain,
    fetch_run,
    listing,
    product,
    product_reference_price,
    raw_object,
    store,
)
from foodcatch.geo import in_region
from foodcatch.ingest import IngestResult, RawPayload
from foodcatch.sources import SourceSchemaError
from foodcatch.sources.salling import (
    ENDPOINT_FOOD_WASTE,
    ENDPOINT_STORES,
    Clearance,
    FoodWasteResponse,
    SallingStore,
)

STORE_SOURCE = "salling"
LISTING_SOURCE = "salling_food_waste"
LISTING_KIND = "clearance"
COUNTRY = "DK"
VARIABLE_WEIGHT_STOCK_UNIT = "kg"
CENT = Decimal("0.01")
UNIT_PRICE_QUANTUM = Decimal("0.0001")

type NetUnit = Literal["kg", "l", "stk"]

_STORES = TypeAdapter(list[SallingStore])
_FOOD_WASTE = TypeAdapter(FoodWasteResponse)


class UnknownEndpointError(ValueError):
    """A salling raw payload has an endpoint this module does not ingest."""


# --------------------------------------------------------------------------- pure helpers


@dataclass(frozen=True, slots=True)
class NetSize:
    """Net size of a product in one of the canonical units (``kg``, ``l``, ``stk``)."""

    unit: NetUnit
    quantity: Decimal


# value unit -> (canonical unit, factor to it)
_UNIT_FACTORS: Mapping[str, tuple[NetUnit, Decimal]] = {
    "KG": ("kg", Decimal(1)),
    "G": ("kg", Decimal("0.001")),
    "GR": ("kg", Decimal("0.001")),
    "L": ("l", Decimal(1)),
    "LTR": ("l", Decimal(1)),
    "DL": ("l", Decimal("0.1")),
    "CL": ("l", Decimal("0.01")),
    "ML": ("l", Decimal("0.001")),
    "STK": ("stk", Decimal(1)),
}
_SIZE_PATTERN = re.compile(
    r"(?<![\w.,])"  # not glued to a preceding word or number ("A38", "0,4%")
    r"(?:(?P<count>\d+)\s*X\s*)?"  # optional multipack "4X"
    r"(?P<value>\d+(?:[.,]\d+)?)\s*"
    r"(?P<unit>KG|GR|G|LTR|L|DL|CL|ML|STK)"
    r"(?!\w)",
    re.IGNORECASE,
)


def _plain(value: Decimal) -> Decimal:
    """``value`` without trailing zeros and without exponent notation (``10``, not ``1E+1``)."""
    normalized = value.normalize()
    return normalized.quantize(Decimal(1)) if normalized == normalized.to_integral() else normalized


def parse_net_size(name: str) -> NetSize | None:
    """Net size stated in an abbreviated Salling product name.

    Examples: ``"A38 ØKO 1KG ARLA"`` -> 1 kg, ``"HYTTEOST 0,4% 450G"`` -> 0.45 kg,
    ``"GULD SKIVEOST 3X140G"`` -> 0.42 kg, ``"MÆLK 1,5L"`` -> 1.5 l. Returns ``None`` when the
    name states no size, a zero size, or several different sizes (ambiguous).
    """
    sizes: set[NetSize] = set()
    for match in _SIZE_PATTERN.finditer(name):
        unit, factor = _UNIT_FACTORS[match["unit"].upper()]
        quantity = Decimal(match["value"].replace(",", ".")) * factor
        if match["count"]:
            quantity *= int(match["count"])
        if quantity > 0:
            sizes.add(NetSize(unit, _plain(quantity)))
    if len(sizes) != 1:
        return None
    return sizes.pop()


_RESTRICTED_GTIN13_PREFIXES = ("02", "04", "2")
"""GS1 restricted-circulation number ranges (020-029, 040-049, 200-299) for GTIN-13."""
_RESTRICTED_GTIN8_PREFIXES = ("0", "2")


def is_gtin(code: str) -> bool:
    """Whether ``code`` is a globally unique GTIN-8/12/13/14 with a valid check digit.

    Restricted-circulation numbers (e.g. prefix ``2`` - in-store codes for variable-weight goods)
    and short in-store codes are not globally unique and return ``False``.
    """
    if not code.isdigit() or len(code) not in (8, 12, 13, 14):
        return False
    if len(code) == 8 and code.startswith(_RESTRICTED_GTIN8_PREFIXES):
        return False
    if len(code) in (12, 13) and code.zfill(13).startswith(_RESTRICTED_GTIN13_PREFIXES):
        return False
    body, check = code[:-1], int(code[-1])
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _json_number(value: Decimal | float | None) -> float | int | None:
    """A JSON-friendly number (``Decimal`` is not JSON serializable)."""
    if value is None or isinstance(value, int):
        return value
    number = float(value)
    return int(number) if number.is_integer() else number


# --------------------------------------------------------------------------- entry point


def ingest_payload(conn: Connection, payload: RawPayload, *, settings: Settings) -> IngestResult:
    """Parse one raw salling payload and upsert normalized rows.

    Raises:
        SourceSchemaError: if the body does not match the endpoint's model.
        UnknownEndpointError: for an endpoint other than ``stores`` / ``food-waste``.
    """
    try:
        if payload.endpoint == ENDPOINT_STORES:
            stores = _STORES.validate_json(payload.body)
            return ingest_stores(conn, stores)
        if payload.endpoint == ENDPOINT_FOOD_WASTE:
            response = _FOOD_WASTE.validate_json(payload.body)
            return ingest_food_waste(conn, payload, response, settings=settings)
    except ValidationError as exc:
        raise SourceSchemaError(
            f"salling/{payload.endpoint}: raw object {payload.raw_object_id} does not match the "
            f"expected schema ({exc.error_count()} error(s))"
        ) from exc
    raise UnknownEndpointError(f"salling: cannot ingest endpoint {payload.endpoint!r}")


# --------------------------------------------------------------------------- stores


def _chains_by_brand(conn: Connection) -> dict[str, str]:
    rows = conn.execute(
        select(chain.c.salling_brand, chain.c.id).where(chain.c.salling_brand.is_not(None))
    ).all()
    return {str(brand): str(chain_id) for brand, chain_id in rows}


def _store_row(item: SallingStore, chain_id: str) -> dict[str, Any]:
    return {
        "chain_id": chain_id,
        "source": STORE_SOURCE,
        "source_store_id": item.id,
        "name": item.name,
        "street": item.address.street,
        "zip": item.address.zip,
        "city": item.address.city,
        "lat": item.lat,
        "lon": item.lon,
    }


def upsert_stores(
    conn: Connection, stores: Iterable[SallingStore], counts: Counter[str]
) -> dict[str, UUID]:
    """Upsert Danish stores of known brands; returns ``{salling store id: store.id}``.

    Skipped stores are counted in ``counts`` (``stores_skipped_country`` /
    ``stores_skipped_brand``).
    """
    chains = _chains_by_brand(conn)
    rows: dict[str, dict[str, Any]] = {}
    for item in stores:
        country = (item.address.country or COUNTRY).upper()
        if country != COUNTRY:
            counts["stores_skipped_country"] += 1
            continue
        chain_id = chains.get(item.brand.lower())
        if chain_id is None:
            counts["stores_skipped_brand"] += 1
            continue
        rows[item.id] = _store_row(item, chain_id)
    if not rows:
        return {}
    stmt = insert(store).values(list(rows.values()))
    stmt = stmt.on_conflict_do_update(
        index_elements=[store.c.source, store.c.source_store_id],
        set_={
            "chain_id": stmt.excluded.chain_id,
            "name": stmt.excluded.name,
            "street": stmt.excluded.street,
            "zip": stmt.excluded.zip,
            "city": stmt.excluded.city,
            "lat": stmt.excluded.lat,
            "lon": stmt.excluded.lon,
            "last_seen_at": func.now(),
        },
    ).returning(store.c.source_store_id, store.c.id)
    ids: dict[str, UUID] = dict(conn.execute(stmt).all())
    counts["stores"] += len(ids)
    return ids


def ingest_stores(conn: Connection, stores: Sequence[SallingStore]) -> IngestResult:
    """Ingest one page of ``GET /v2/stores``; ``records`` is the number of stores upserted."""
    counts: Counter[str] = Counter()
    ids = upsert_stores(conn, stores, counts)
    return IngestResult(records=len(ids), counts=counts)


# --------------------------------------------------------------------------- food waste


def _observed_at(conn: Connection, payload: RawPayload) -> datetime:
    """Observation time of a payload: the start of the run that fetched it.

    Using the run start (not the per-object fetch time) makes all stores of one run share one
    observation time, live and when reprocessing.
    """
    started_at = conn.execute(
        select(fetch_run.c.started_at)
        .join(raw_object, raw_object.c.fetch_run_id == fetch_run.c.id)
        .where(raw_object.c.id == payload.raw_object_id)
    ).scalar_one_or_none()
    return started_at if started_at is not None else payload.fetched_at


def _valid(clearance: Clearance) -> bool:
    offer = clearance.offer
    return (
        offer.new_price >= 0
        and (offer.original_price is None or offer.original_price >= 0)
        and offer.end_time >= offer.start_time
        and bool(clearance.product.description.strip())
    )


def upsert_products(
    conn: Connection, clearances: Iterable[Clearance], counts: Counter[str]
) -> dict[str, UUID]:
    """Upsert a product per distinct GTIN; returns ``{ean: product.id}``.

    ``name`` follows Salling's latest description; ``source_category`` keeps the previous value
    when a payload lacks categories.
    """
    rows: dict[str, dict[str, Any]] = {}
    for clearance in clearances:
        item = clearance.product
        ean = item.ean.strip()
        if not is_gtin(ean):
            continue
        previous = rows.get(ean)
        category = item.category_path or (previous["source_category"] if previous else None)
        rows[ean] = {"ean": ean, "name": item.description.strip(), "source_category": category}
    if not rows:
        return {}
    stmt = insert(product).values(list(rows.values()))
    stmt = stmt.on_conflict_do_update(
        index_elements=[product.c.ean],
        set_={
            "name": stmt.excluded.name,
            "source_category": func.coalesce(
                stmt.excluded.source_category, product.c.source_category
            ),
            "last_seen_at": func.now(),
        },
    ).returning(product.c.ean, product.c.id)
    ids: dict[str, UUID] = dict(conn.execute(stmt).all())
    counts["products"] += len(ids)
    return ids


@dataclass(frozen=True, slots=True)
class _PriceRow:
    id: int
    price: Decimal
    last_seen_at: datetime


def record_reference_prices(
    conn: Connection,
    prices: Mapping[UUID, Decimal],
    *,
    chain_id: str,
    observed_at: datetime,
    counts: Counter[str],
) -> None:
    """Record observed shelf prices ``{product_id: price}`` of ``chain_id`` at ``observed_at``.

    A row is a price observed over ``[first_seen_at, last_seen_at]``. The *current* rows of a
    (product, chain) are those seen in the latest observation before ``observed_at`` (or at it).
    If one of them has the same price it is extended (``last_seen_at`` bumped and
    ``observations`` - the number of runs that saw the price - incremented once per
    observation time); otherwise the price changed and a new row starts at ``observed_at``.
    Several stores reporting different prices in the same run therefore yield several current
    rows instead of a new row on every run. Replaying the same payload changes nothing.
    """
    if not prices:
        return
    existing: dict[UUID, list[_PriceRow]] = {}
    rows = conn.execute(
        select(
            product_reference_price.c.product_id,
            product_reference_price.c.id,
            product_reference_price.c.price,
            product_reference_price.c.last_seen_at,
        ).where(
            product_reference_price.c.chain_id == chain_id,
            product_reference_price.c.product_id.in_(list(prices)),
        )
    ).all()
    for product_id, row_id, price, last_seen_at in rows:
        existing.setdefault(product_id, []).append(_PriceRow(row_id, price, last_seen_at))

    bumps: list[dict[str, Any]] = []
    inserts: list[dict[str, Any]] = []
    for product_id, price in prices.items():
        history = existing.get(product_id, [])
        earlier = [r.last_seen_at for r in history if r.last_seen_at < observed_at]
        previous = max(earlier) if earlier else None
        current = [
            r
            for r in history
            if r.price == price and (previous is None or r.last_seen_at >= previous)
        ]
        if current:
            latest = max(current, key=lambda r: r.last_seen_at)
            if latest.last_seen_at < observed_at:
                bumps.append({"row_id": latest.id, "seen": observed_at})
            else:
                counts["reference_prices_unchanged"] += 1
            continue
        inserts.append(
            {
                "product_id": product_id,
                "chain_id": chain_id,
                "price": price,
                "first_seen_at": observed_at,
                "last_seen_at": observed_at,
                "observations": 1,
            }
        )

    if bumps:
        conn.execute(
            update(product_reference_price)
            .where(product_reference_price.c.id == bindparam("row_id"))
            .values(
                last_seen_at=bindparam("seen"),
                observations=product_reference_price.c.observations + 1,
            ),
            bumps,
        )
        counts["reference_prices_extended"] += len(bumps)
    if inserts:
        inserted = conn.execute(
            insert(product_reference_price)
            .values(inserts)
            .on_conflict_do_nothing(constraint="uq_product_reference_price_observation")
            .returning(product_reference_price.c.id)
        ).all()
        counts["reference_prices_new"] += len(inserted)


def _reference_prices(
    clearances: Iterable[Clearance], product_ids: Mapping[str, UUID]
) -> dict[UUID, Decimal]:
    """Lowest original price per product among fixed-size clearances."""
    prices: dict[UUID, Decimal] = {}
    for clearance in clearances:
        offer = clearance.offer
        product_id = product_ids.get(clearance.product.ean.strip())
        if product_id is None or offer.original_price is None:
            continue
        if (offer.stock_unit or "").lower() == VARIABLE_WEIGHT_STOCK_UNIT:
            continue
        price = _money(offer.original_price)
        prices[product_id] = min(price, prices.get(product_id, price))
    return prices


def _listing_row(
    clearance: Clearance,
    *,
    store_id: UUID,
    salling_store_id: str,
    chain_id: str,
    product_id: UUID | None,
    raw_object_id: UUID,
) -> dict[str, Any]:
    offer, item = clearance.offer, clearance.product
    title = item.description.strip()
    price = _money(offer.new_price)
    size = parse_net_size(title)
    unit_price = (
        (price / size.quantity).quantize(UNIT_PRICE_QUANTUM, rounding=ROUND_HALF_UP)
        if size is not None
        else None
    )
    label = (offer.ean or "").strip() or item.ean.strip()
    return {
        "source": LISTING_SOURCE,
        "source_item_id": f"{salling_store_id}:{label}",
        "chain_id": chain_id,
        "store_id": store_id,
        "catalog_id": None,
        "kind": LISTING_KIND,
        "title": title,
        "description": "",
        "product_id": product_id,
        "price": price,
        "reference_price": (
            _money(offer.original_price) if offer.original_price is not None else None
        ),
        "unit": size.unit if size else None,
        "size_min": size.quantity if size else None,
        "size_max": size.quantity if size else None,
        "unit_price_min": unit_price,
        "unit_price_max": unit_price,
        "member_only": False,
        "max_per_customer": None,
        "valid_from": offer.start_time,
        "valid_to": offer.end_time,
        "raw_object_id": raw_object_id,
        "extra": {
            "stock": _json_number(offer.stock),
            "stock_unit": offer.stock_unit,
            "percent_discount": _json_number(offer.percent_discount),
            "offer_ean": offer.ean,
            "product_code": item.ean.strip(),
            "image": item.image,
            "category": item.category_path,
        },
    }


# Columns whose change makes a listing "changed" for classification and deals. Stock and
# provenance change on almost every run and are updated without reporting the listing.
_COMPARED_COLUMNS = (
    "chain_id",
    "store_id",
    "title",
    "description",
    "product_id",
    "reference_price",
    "unit",
    "size_min",
    "size_max",
    "unit_price_min",
    "unit_price_max",
    "valid_to",
)
_VOLATILE_EXTRA_KEYS = frozenset({"stock"})
_UPDATED_COLUMNS = (*_COMPARED_COLUMNS, "raw_object_id", "extra")

type _ListingKey = tuple[str, datetime, Decimal]


def _key(row: Mapping[str, Any]) -> _ListingKey:
    return (row["source_item_id"], row["valid_from"], row["price"])


def _fingerprint(row: Mapping[str, Any]) -> tuple[Any, ...]:
    extra: Mapping[str, Any] = row["extra"] or {}
    stable_extra = sorted((k, v) for k, v in extra.items() if k not in _VOLATILE_EXTRA_KEYS)
    return (*(row[c] for c in _COMPARED_COLUMNS), tuple(stable_extra))


def upsert_listings(
    conn: Connection, rows: Sequence[Mapping[str, Any]], counts: Counter[str]
) -> set[UUID]:
    """Upsert food-waste listings; returns the ids of inserted or changed listings."""
    by_key = {_key(row): row for row in rows}
    if not by_key:
        return set()
    item_ids = sorted({key[0] for key in by_key})
    names: tuple[str, ...] = ("source_item_id", "valid_from", "price", *_COMPARED_COLUMNS, "extra")
    existing: dict[_ListingKey, tuple[Any, ...]] = {}
    for values in conn.execute(
        select(*(listing.c[name] for name in names)).where(
            listing.c.source == LISTING_SOURCE, listing.c.source_item_id.in_(item_ids)
        )
    ):
        old: dict[str, Any] = dict(zip(names, values, strict=True))
        existing[_key(old)] = _fingerprint(old)
    stmt = insert(listing).values(list(by_key.values()))
    stmt = stmt.on_conflict_do_update(
        index_elements=[
            listing.c.source,
            listing.c.source_item_id,
            listing.c.valid_from,
            listing.c.price,
        ],
        set_={**{c: stmt.excluded[c] for c in _UPDATED_COLUMNS}, "last_seen_at": func.now()},
    ).returning(listing.c.id, listing.c.source_item_id, listing.c.valid_from, listing.c.price)
    touched: set[UUID] = set()
    for listing_id, item_id, valid_from, price in conn.execute(stmt).all():
        key: _ListingKey = (item_id, valid_from, price)
        before = existing.get(key)
        if before is None:
            counts["listings_new"] += 1
            touched.add(listing_id)
        elif before != _fingerprint(by_key[key]):
            counts["listings_changed"] += 1
            touched.add(listing_id)
        else:
            counts["listings_unchanged"] += 1
    return touched


def ingest_food_waste(
    conn: Connection, payload: RawPayload, response: FoodWasteResponse, *, settings: Settings
) -> IngestResult:
    """Ingest one ``GET /v1/food-waste/{storeId}`` response (see the module docstring).

    ``records`` is the number of valid clearances (all stores, in region or not).
    """
    counts: Counter[str] = Counter()
    store_ids = upsert_stores(conn, [response.store], counts)
    store_id = store_ids.get(response.store.id)
    if store_id is None:
        counts["clearances_skipped_store"] += len(response.clearances)
        return IngestResult(counts=counts)
    chain_id = _chains_by_brand(conn)[response.store.brand.lower()]

    clearances = [c for c in response.clearances if _valid(c)]
    counts["clearances"] += len(clearances)
    counts["clearances_invalid"] += len(response.clearances) - len(clearances)

    product_ids = upsert_products(conn, clearances, counts)
    record_reference_prices(
        conn,
        _reference_prices(clearances, product_ids),
        chain_id=chain_id,
        observed_at=_observed_at(conn, payload),
        counts=counts,
    )

    lat, lon = response.store.lat, response.store.lon
    if (
        lat is None
        or lon is None
        or not in_region(lat, lon, settings.region_centers, settings.region_radius_km)
    ):
        counts["clearances_outside_region"] += len(clearances)
        return IngestResult(records=len(clearances), counts=counts)

    rows = [
        _listing_row(
            clearance,
            store_id=store_id,
            salling_store_id=response.store.id,
            chain_id=chain_id,
            product_id=product_ids.get(clearance.product.ean.strip()),
            raw_object_id=payload.raw_object_id,
        )
        for clearance in clearances
    ]
    counts["clearances_in_region"] += len(rows)
    listing_ids = upsert_listings(conn, rows, counts)
    return IngestResult(records=len(clearances), listing_ids=listing_ids, counts=counts)
