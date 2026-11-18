"""Deal computation (architecture §6; owned by the deals module).

:func:`recompute_deals` maintains the ``deal`` table: one row per *Netto variant*, i.e. per
healthy ``classification`` row (current matcher release) of a current or upcoming Netto offer
listing (``source='tjek'``, ``chain_id='netto'``, ``kind='offer'``, ``valid_to`` null or in the
future - the same rows ``api.current_netto_deals`` shows). Each row holds:

* ``netto_unit_price_worst`` = ``unit_price_max`` (fallback ``unit_price_min``) and
  ``netto_unit_price_best`` = ``unit_price_min`` (fallback ``unit_price_max``);
* ``price_applies`` - the offer's unit price applies to this variant (see *Price applies*);
* ``references`` - **all** same-class reference prices, as a JSON array of
  ``{kind, chain_id, listing_id, title, unit_price, unit, valid_from, valid_to}`` sorted by
  ``unit_price``. Only exact variants with a known unit get references; others store ``[]``.

Same class
    A reference is the *same product* only when its classification (current release) has the
    identical ``class_key`` and ``is_exact`` - i.e. ``comparability(a, b) == "same"``: same type,
    every key attribute known and equal, same processing state. Units must match
    (``listing.unit`` / ``product.net_unit`` equals the Netto listing's unit).

Price applies
    A listing's unit price applies to one of its variants when the offer is homogeneous
    (``same_class_variants >= offer_variants``) or the unit-price spread is small
    (``unit_price_max <= 1.25 * unit_price_min``), or the price range is unknown. This rejects
    "Mørbrad, skank eller stegeben" style offers whose cheapest kilo price belongs to another
    product. The same rule decides ``deal.price_applies`` and which references are usable.

Reference kinds (references are always quoted at their *best*, i.e. lowest, unit price)
    ``offer``
        Current or upcoming competitor offers: ``source='tjek'``, ``kind='offer'``, chain other
        than Netto, ``valid_to`` null or in the future, price applies. One per source offer
        (latest version when Tjek re-published it with a new price).
    ``regular``
        Rema 1000 shelf prices: ``source='rema'``, ``kind='regular'``, valid now. Only the
        latest price per Rema product.
    ``history``
        Other Netto offers of the class that started no later than this offer (any validity,
        a different Tjek offer id, price applies), one per listing.
    ``ean_reference``
        A Netto Tjek offer carries no EAN, so EAN shelf prices are tied to it through the class:
        an *exact, homogeneous* listing of the same class that has an EAN (``product_id``, in
        practice a Salling food-waste clearance) contributes the latest
        ``product_reference_price`` per chain of that product, observed within
        :data:`EAN_REFERENCE_MAX_AGE`, converted to a unit price as
        ``price / product.net_quantity``. Skipped when the product's net quantity or unit is
        unknown or the unit differs. ``valid_from`` / ``valid_to`` are the first / last time that
        shelf price was observed; ``title`` is the product name.

Incremental scope
    With ``listing_ids``, the recomputed variants are: Netto variants of those listings, Netto
    variants sharing a ``class_key`` with any of those listings (a changed competitor, Rema,
    history or EAN listing), and Netto variants whose stored ``offer``/``regular`` references
    have expired since (so expired competitor prices disappear on the next run of any job).
    ``listing_ids=None`` recomputes every Netto variant. A ``product_reference_price`` change
    without a changed listing is picked up by the next full recompute.

Staleness
    Every call deletes deal rows that no longer describe a current Netto variant: rows of
    other matcher releases, of expired listings, and of variants that are no longer healthy.

Efficiency (Neon free tier)
    Everything is three set-based statements: the release lookup, one ``DELETE`` and one
    ``INSERT ... SELECT ... ON CONFLICT``. References are found through the
    ``classification (matcher_version, class_key)`` index and the ``listing`` primary key.
    Unchanged rows are not rewritten (``IS DISTINCT FROM`` guard), so ``computed_at`` is the
    time the row last changed and the return value counts real changes.

Runs inside the caller's transaction (never commits).
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import timedelta
from decimal import Decimal
from typing import Final
from uuid import UUID

from sqlalchemy import Connection, bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.types import Interval, Numeric

from foodcatch.logging import get_logger

log = get_logger(__name__)

NETTO_CHAIN_ID: Final = "netto"
"""Chain whose offers are evaluated."""

PRICE_SPREAD_LIMIT: Final = Decimal("1.25")
"""An offer's unit price applies to a variant if ``unit_price_max <= limit * unit_price_min``."""

EAN_REFERENCE_MAX_AGE: Final = timedelta(days=60)
"""EAN shelf prices last observed longer ago than this are not used as references."""


def _price_applies(variant: str, listing: str) -> str:
    """SQL predicate: the unit price of ``listing`` applies to its classified ``variant``."""
    return (
        f"({variant}.same_class_variants >= {variant}.offer_variants"
        f" OR {listing}.unit_price_min IS NULL OR {listing}.unit_price_max IS NULL"
        f" OR {listing}.unit_price_max <= :spread_limit * {listing}.unit_price_min)"
    )


def _current(listing: str) -> str:
    """SQL predicate: ``listing`` is current or upcoming."""
    return f"({listing}.valid_to IS NULL OR {listing}.valid_to >= now())"


def _netto_offer(listing: str) -> str:
    """SQL predicate: ``listing`` is a Netto offer from Tjek."""
    return f"{listing}.source = 'tjek' AND {listing}.kind = 'offer' AND {listing}.chain_id = :netto"


_SCOPE_ALL = "true"
_SCOPE_LISTINGS = """(
        l.id = ANY(:ids)
        OR c.class_key IN (
            SELECT a.class_key FROM classification a
            WHERE a.matcher_version = :version AND a.listing_id = ANY(:ids))
        OR EXISTS (
            SELECT 1 FROM deal d, jsonb_array_elements(d."references") r
            WHERE d.listing_id = c.listing_id
              AND d.variant_index = c.variant_index
              AND d.matcher_version = :version
              AND r ->> 'kind' IN ('offer', 'regular')
              AND (r ->> 'valid_to')::timestamptz < now())
    )"""

# Same-class candidates of a target variant ``t``: classification ``rc`` + listing ``rl``.
_SAME_CLASS_JOIN = """
        FROM target t
        JOIN classification rc
          ON rc.matcher_version = :version AND rc.class_key = t.class_key AND rc.is_exact
        JOIN listing rl ON rl.id = rc.listing_id AND rl.id <> t.listing_id
        WHERE t.is_exact AND t.unit IS NOT NULL"""

_LISTING_REF_COLUMNS = (
    "t.listing_id, t.variant_index, {kind} AS kind, rl.chain_id, rl.id AS ref_listing_id,"
    " rl.title, rl.unit_price_min AS unit_price, rl.unit, rl.valid_from, rl.valid_to"
)


def _listing_refs(kind: str, where: str, distinct_on: str, order_by: str) -> str:
    """One reference branch over same-class listings (``offer``/``regular``/``history``)."""
    return f"""(
        SELECT DISTINCT ON (t.listing_id, t.variant_index, {distinct_on})
               {_LISTING_REF_COLUMNS.format(kind=f"'{kind}'")}
        {_SAME_CLASS_JOIN}
          AND rl.unit = t.unit
          AND rl.unit_price_min IS NOT NULL
          AND {_price_applies("rc", "rl")}
          AND {where}
        ORDER BY t.listing_id, t.variant_index, {distinct_on}, {order_by}
    )"""


_OFFER_REFS = _listing_refs(
    "offer",
    f"rl.source = 'tjek' AND rl.kind = 'offer' AND rl.chain_id <> :netto AND {_current('rl')}",
    distinct_on="rl.source_item_id",
    order_by="rl.last_seen_at DESC, rl.valid_from DESC",
)
_REGULAR_REFS = _listing_refs(
    "regular",
    f"rl.source = 'rema' AND rl.kind = 'regular' AND rl.valid_from <= now() AND {_current('rl')}",
    distinct_on="rl.source_item_id",
    order_by="rl.valid_from DESC, rl.last_seen_at DESC",
)
_HISTORY_REFS = _listing_refs(
    "history",
    f"{_netto_offer('rl')} AND rl.source_item_id <> t.source_item_id"
    " AND rl.valid_from <= t.valid_from",
    distinct_on="rl.id",
    order_by="rl.last_seen_at DESC",
)
_EAN_REFS = """(
        SELECT DISTINCT ON (t.listing_id, t.variant_index, p.id, prp.chain_id)
               t.listing_id, t.variant_index, 'ean_reference' AS kind, prp.chain_id,
               rl.id AS ref_listing_id, COALESCE(p.name, rl.title) AS title,
               round(prp.price / p.net_quantity, 4) AS unit_price, p.net_unit AS unit,
               prp.first_seen_at AS valid_from, prp.last_seen_at AS valid_to
        FROM target t
        JOIN classification rc
          ON rc.matcher_version = :version AND rc.class_key = t.class_key AND rc.is_exact
         AND rc.same_class_variants >= rc.offer_variants
        JOIN listing rl
          ON rl.id = rc.listing_id AND rl.id <> t.listing_id AND rl.product_id IS NOT NULL
        JOIN product p
          ON p.id = rl.product_id AND p.net_quantity > 0 AND p.net_unit = t.unit
        JOIN product_reference_price prp
          ON prp.product_id = p.id AND prp.last_seen_at >= now() - :ean_max_age
        WHERE t.is_exact
        ORDER BY t.listing_id, t.variant_index, p.id, prp.chain_id,
                 prp.last_seen_at DESC, rl.last_seen_at DESC, rl.id
    )"""

_UPSERT_SQL = """
WITH target AS MATERIALIZED (
    SELECT c.listing_id, c.variant_index, c.class_key, c.is_exact,
           l.unit, l.valid_from, l.source_item_id, l.unit_price_min, l.unit_price_max,
           {price_applies} AS price_applies
    FROM classification c
    JOIN listing l ON l.id = c.listing_id
    WHERE c.matcher_version = :version
      AND c.is_healthy
      AND {netto_offer}
      AND {current}
      AND {scope}
),
refs AS (
    {offer_refs}
    UNION ALL
    {regular_refs}
    UNION ALL
    {history_refs}
    UNION ALL
    {ean_refs}
),
ref_arrays AS (
    SELECT r.listing_id, r.variant_index,
           jsonb_agg(
               jsonb_build_object(
                   'kind', r.kind, 'chain_id', r.chain_id, 'listing_id', r.ref_listing_id,
                   'title', r.title, 'unit_price', r.unit_price, 'unit', r.unit,
                   'valid_from', {valid_from}, 'valid_to', {valid_to})
               ORDER BY r.unit_price, r.kind, r.chain_id, r.ref_listing_id
           ) AS refs
    FROM refs r
    GROUP BY r.listing_id, r.variant_index
)
INSERT INTO deal AS d (listing_id, variant_index, matcher_version, class_key,
                       netto_unit_price_worst, netto_unit_price_best, price_applies,
                       "references", computed_at)
SELECT t.listing_id, t.variant_index, :version, t.class_key,
       COALESCE(t.unit_price_max, t.unit_price_min),
       COALESCE(t.unit_price_min, t.unit_price_max),
       t.price_applies,
       COALESCE(ra.refs, '[]'::jsonb),
       now()
FROM target t
LEFT JOIN ref_arrays ra ON ra.listing_id = t.listing_id AND ra.variant_index = t.variant_index
ON CONFLICT (listing_id, variant_index, matcher_version) DO UPDATE
SET class_key = EXCLUDED.class_key,
    netto_unit_price_worst = EXCLUDED.netto_unit_price_worst,
    netto_unit_price_best = EXCLUDED.netto_unit_price_best,
    price_applies = EXCLUDED.price_applies,
    "references" = EXCLUDED."references",
    computed_at = EXCLUDED.computed_at
WHERE (d.class_key, d.netto_unit_price_worst, d.netto_unit_price_best, d.price_applies,
       d."references")
      IS DISTINCT FROM
      (EXCLUDED.class_key, EXCLUDED.netto_unit_price_worst, EXCLUDED.netto_unit_price_best,
       EXCLUDED.price_applies, EXCLUDED."references")
"""

_DELETE_STALE_SQL = f"""
DELETE FROM deal d
WHERE d.matcher_version <> :version
   OR NOT EXISTS (
       SELECT 1
       FROM classification c
       JOIN listing l ON l.id = c.listing_id
       WHERE c.listing_id = d.listing_id
         AND c.matcher_version = d.matcher_version
         AND c.variant_index = d.variant_index
         AND c.is_healthy
         AND {_netto_offer("l")}
         AND {_current("l")})
"""


def _iso_utc(timestamp: str) -> str:
    """SQL: ``timestamp`` as an ISO 8601 UTC string (``2026-11-18T23:00:00Z``).

    Independent of the session time zone, so stored references compare equal across runs.
    """
    return f"""to_char({timestamp} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')"""


def _upsert_sql(*, scoped: bool) -> str:
    return _UPSERT_SQL.format(
        price_applies=_price_applies("c", "l"),
        netto_offer=_netto_offer("l"),
        current=_current("l"),
        scope=_SCOPE_LISTINGS if scoped else _SCOPE_ALL,
        offer_refs=_OFFER_REFS,
        regular_refs=_REGULAR_REFS,
        history_refs=_HISTORY_REFS,
        ean_refs=_EAN_REFS,
        valid_from=_iso_utc("r.valid_from"),
        valid_to=_iso_utc("r.valid_to"),
    )


_PARAM_TYPES = (
    bindparam("spread_limit", type_=Numeric()),
    bindparam("ean_max_age", type_=Interval()),
)
_UPSERT_ALL = text(_upsert_sql(scoped=False)).bindparams(*_PARAM_TYPES)
_UPSERT_SCOPED = text(_upsert_sql(scoped=True)).bindparams(
    *_PARAM_TYPES, bindparam("ids", type_=ARRAY(PG_UUID(as_uuid=True)))
)
_DELETE_STALE = text(_DELETE_STALE_SQL)
_CURRENT_VERSION = text("SELECT version FROM matcher_release WHERE is_current")


def current_matcher_version(conn: Connection) -> str | None:
    """The version of the current ``matcher_release`` (``None`` if none is current)."""
    return conn.execute(_CURRENT_VERSION).scalar_one_or_none()


def recompute_deals(conn: Connection, *, listing_ids: Collection[UUID] | None = None) -> int:
    """Recompute deals affected by ``listing_ids`` (``None`` = all); returns rows written.

    Deletes stale deal rows, then inserts or updates the deal rows of the affected Netto
    variants under the current matcher release (see the module docstring for the rules).
    The return value counts inserted or changed rows; unchanged rows are not rewritten.
    """
    version = current_matcher_version(conn)
    if version is None:
        log.warning("deals.no_current_matcher_release")
        return 0
    deleted = conn.execute(_DELETE_STALE, {"version": version, "netto": NETTO_CHAIN_ID}).rowcount
    params: dict[str, object] = {
        "version": version,
        "netto": NETTO_CHAIN_ID,
        "spread_limit": PRICE_SPREAD_LIMIT,
        "ean_max_age": EAN_REFERENCE_MAX_AGE,
    }
    if listing_ids is None:
        statement = _UPSERT_ALL
    else:
        if not listing_ids:
            log.info("deals.recomputed", written=0, deleted=deleted, scoped=True)
            return 0
        statement = _UPSERT_SCOPED
        params["ids"] = list(listing_ids)
    written = conn.execute(statement, params).rowcount
    log.info("deals.recomputed", written=written, deleted=deleted, scoped=listing_ids is not None)
    return written
