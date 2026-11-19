"""All-chain deals, per-product price history and food-waste sources/references.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-19

* `listing.kind`: Lidl leaflet items marked "Fast lav pris" become `regular` (Lidl's shelf
  prices; `ingest.tjek.is_fixed_low_price` applies the same rule to new data).
* `listing.product_key`: a stored generated column naming the individual item whose prices
  can be followed over time (`db/product_key.py`), plus an index.
* No `deal` column changes: deals now exist for the offers of every chain (architecture §6);
  `deal.netto_unit_price_worst/best` hold the target offer's prices whatever its chain and are
  exposed as `target_unit_price_worst/best` (a column rename would break the code on `main`
  during the deploy, runbook §5).
* New views `api.current_deals` (all chains), `api.product_price_history` and `api.products`.
* `api.current_netto_deals` becomes the Netto part of `api.current_deals` (same columns, plus
  `product_key`); `api.food_waste_near` gets source ("Kilde") fields and competitor references
  (`food_waste_references`, `beats_competitors`); `api.class_price_history` gets `product_key`.

Columns are only appended to existing views. Reversible: the downgrade drops the new views,
restores the 0007 definitions, drops `product_key` and turns the `regular` Tjek listings back
into offers (no data is lost; deal rows of other chains stay until the next recompute, which the
0007 code limits to Netto again).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

WEB_ROLE = "web_readonly"

# Frozen copy of `foodcatch.db.product_key.PRODUCT_KEY_SQL` (a test keeps them equal).
_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅÄÖÜÉÈÊËÁÀÂÍÌÎÏÓÒÔÚÙÛÑÇ"
_LOWER = "abcdefghijklmnopqrstuvwxyzæøåäöüéèêëáàâíìîïóòôúùûñç"
_KEPT = "0-9a-zæøåäöüéèêëáàâíìîïóòôúùûñç"
_NORMALIZED_TITLE = (
    f"btrim(regexp_replace(translate(title, '{_UPPER}', '{_LOWER}'), '[^{_KEPT}]+', ' ', 'g'), ' ')"
)
PRODUCT_KEY_SQL = (
    "CASE"
    " WHEN source = 'rema' THEN 'rema:' || source_item_id"
    " WHEN source = 'salling_food_waste' AND product_id IS NOT NULL"
    " AND (extra ->> 'product_code') IS NOT NULL THEN 'ean:' || (extra ->> 'product_code')"
    " WHEN source = 'salling_food_waste'"
    f" THEN 'clearance:' || chain_id || ':' || {_NORMALIZED_TITLE}"
    f" ELSE 'offer:' || chain_id || ':' || {_NORMALIZED_TITLE}"
    " END"
)

# Mirror of `ingest.tjek.is_fixed_low_price` (Python `\b` = PostgreSQL `\m`/`\M`).
FIXED_LOW_PRICE_SQL = (
    "source = 'tjek' AND chain_id = 'lidl'"
    " AND (title || ' ' || COALESCE(description, '')) ~* '\\mfast\\s+lav\\s+pris\\M'"
)

# Mirror of `deals.compute.PIECE_TYPE_IDS` (types compared per piece; a test keeps them equal).
PIECE_TYPE_IDS = ("æg",)

_LATEST_VERSION = """NOT EXISTS (
              SELECT 1 FROM public.listing nv
              WHERE nv.source = {l}.source
                AND nv.source_item_id = {l}.source_item_id
                AND nv.id <> {l}.id
                AND (nv.last_seen_at, nv.valid_from) > ({l}.last_seen_at, {l}.valid_from))"""

_PRICE_APPLIES = """({c}.same_class_variants >= {c}.offer_variants
            OR {l}.unit_price_min IS NULL OR {l}.unit_price_max IS NULL
            OR {l}.unit_price_max <= 1.25 * {l}.unit_price_min)"""


def _iso_utc(column: str) -> str:
    return f"""to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')"""


# Deal targets (deals/compute.py `_target`): current or upcoming offers of every chain, the
# latest version of a Tjek offer id, and Rema catalogue campaigns that are not in the leaflet.
_CURRENT_DEALS = f"""
    SELECT l.id AS listing_id, c.variant_index, l.chain_id, ch.name AS chain_name,
           l.title, l.description, l.price, l.unit, l.unit_price_min, l.unit_price_max,
           l.valid_from, l.valid_to,
           c.type_id, c.type_label, c.group_name, c.class_key, c.class_label, c.attrs,
           c.is_exact, c.notes,
           d.price_applies, d.netto_unit_price_worst AS target_unit_price_worst,
           d.netto_unit_price_best AS target_unit_price_best,
           COALESCE(d."references", '[]'::jsonb) AS "references",
           l.member_only, l.source, l.source_item_id, l.catalog_id, l.size_min, l.size_max,
           l.max_per_customer, l.product_key
    FROM public.listing l
    JOIN public.chain ch ON ch.id = l.chain_id
    JOIN public.classification c ON c.listing_id = l.id
    JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
    LEFT JOIN public.deal d
           ON d.listing_id = c.listing_id
          AND d.variant_index = c.variant_index
          AND d.matcher_version = c.matcher_version
    WHERE l.kind = 'offer'
      AND c.is_healthy
      AND (l.valid_to IS NULL OR l.valid_to >= now())
      AND ((l.source = 'tjek' AND {_LATEST_VERSION.format(l="l")})
           OR (l.source = 'rema' AND NOT EXISTS (
              SELECT 1 FROM public.listing tl
              JOIN public.classification tc
                ON tc.listing_id = tl.id
               AND tc.matcher_version = c.matcher_version
               AND tc.class_key = c.class_key
              WHERE tl.source = 'tjek' AND tl.kind = 'offer'
                AND tl.chain_id = l.chain_id
                AND tl.price = l.price
                AND tl.valid_from < COALESCE(l.valid_to, 'infinity')
                AND l.valid_from < COALESCE(tl.valid_to, 'infinity')
                AND {_LATEST_VERSION.format(l="tl")})))
"""

_CURRENT_NETTO_DEALS = """
    SELECT listing_id, variant_index, title, description, price, unit, unit_price_min,
           unit_price_max, valid_from, valid_to, type_id, type_label, group_name, class_key,
           class_label, attrs, is_exact, notes, price_applies,
           target_unit_price_worst AS netto_unit_price_worst,
           target_unit_price_best AS netto_unit_price_best,
           "references", member_only, source, source_item_id, catalog_id, size_min, size_max,
           max_per_customer, product_key
    FROM api.current_deals
    WHERE chain_id = 'netto'
"""

# Definition of migration 0007 (restored by the downgrade).
_CURRENT_NETTO_DEALS_0007 = """
    SELECT l.id AS listing_id, c.variant_index, l.title, l.description, l.price, l.unit,
           l.unit_price_min, l.unit_price_max, l.valid_from, l.valid_to,
           c.type_id, c.type_label, c.group_name, c.class_key, c.class_label, c.attrs,
           c.is_exact, c.notes,
           d.price_applies, d.netto_unit_price_worst, d.netto_unit_price_best,
           COALESCE(d."references", '[]'::jsonb) AS "references",
           l.member_only,
           l.source,
           l.source_item_id,
           l.catalog_id,
           l.size_min,
           l.size_max,
           l.max_per_customer
    FROM public.listing l
    JOIN public.classification c ON c.listing_id = l.id
    JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
    LEFT JOIN public.deal d
           ON d.listing_id = c.listing_id
          AND d.variant_index = c.variant_index
          AND d.matcher_version = c.matcher_version
    WHERE l.chain_id = 'netto'
      AND l.kind = 'offer'
      AND c.is_healthy
      AND (l.valid_to IS NULL OR l.valid_to >= now())
      AND NOT EXISTS (
          SELECT 1 FROM public.listing nv
          WHERE nv.source = l.source
            AND nv.source_item_id = l.source_item_id
            AND nv.id <> l.id
            AND (nv.last_seen_at, nv.valid_from) > (l.last_seen_at, l.valid_from))
"""

# 0007's food_waste_near with placeholders for appended columns and joins.
_FOOD_WASTE_NEAR = """
    SELECT DISTINCT ON (l.id)
           l.id AS listing_id, l.store_id, l.chain_id, s.name AS store_name, s.street,
           s.zip, s.city, s.lat, s.lon, l.title, p.ean, l.price, l.reference_price,
           CASE WHEN l.reference_price > 0
                THEN round((1 - l.price / l.reference_price) * 100, 1)
           END AS discount_pct,
           l.unit, l.unit_price_min AS unit_price, l.valid_to,
           CASE WHEN jsonb_typeof(l.extra -> 'stock') = 'number'
                THEN (l.extra ->> 'stock')::numeric
           END AS stock,
           l.extra ->> 'stock_unit' AS stock_unit,
           c.type_label, c.class_label, c.is_exact,
           l.size_min AS size,
           CASE WHEN l.extra ->> 'image' LIKE 'https://digitalassets.sallinggroup.com/%'
                 AND l.extra ->> 'image' NOT LIKE '%/image'
                THEN l.extra ->> 'image'
           END AS image_url,
           p.quantity_text AS product_quantity_text,
           p.net_quantity AS product_net_quantity,
           p.net_unit AS product_net_unit,
           l.last_seen_at{appended}
    FROM public.listing l
    JOIN public.store s ON s.id = l.store_id
    LEFT JOIN public.product p ON p.id = l.product_id
    JOIN public.classification c
         JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
      ON c.listing_id = l.id{joins}
    WHERE l.source = 'salling_food_waste'
      AND l.kind = 'clearance'
      AND c.is_healthy
      AND (l.valid_to IS NULL OR l.valid_to >= now())
      AND l.last_seen_at >= COALESCE(
            (SELECT max(r.started_at) FROM public.fetch_run r
              WHERE r.job = 'salling-food-waste'
                AND r.status IN ('succeeded', 'degraded')),
            '-infinity'::timestamptz)
    ORDER BY l.id, c.variant_index
"""

_PIECE_TYPES = ", ".join(f"'{t}'" for t in PIECE_TYPE_IDS)

# Same-class references of a clearance (architecture §6 rules): other chains' current or
# upcoming offers (Tjek, latest version; Rema catalogue campaigns) and regular shelf prices
# (Rema, Lidl "Fast lav pris"), exact, same unit, price applies; one per source item.
_FOOD_WASTE_JOINS = f"""
    JOIN public.raw_object ro ON ro.id = l.raw_object_id
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(
                   jsonb_build_object(
                       'kind', r.kind, 'chain_id', r.chain_id, 'listing_id', r.id,
                       'title', r.title, 'unit_price', r.unit_price_min, 'unit', r.unit,
                       'valid_from', {_iso_utc("r.valid_from")},
                       'valid_to', {_iso_utc("r.valid_to")},
                       'member_only', r.member_only)
                   ORDER BY r.unit_price_min, r.kind, r.chain_id, r.id) AS refs,
               min(r.unit_price_min) AS cheapest
        FROM (
            SELECT DISTINCT ON (rl.source, rl.source_item_id, rl.kind)
                   rl.id, rl.kind, rl.chain_id, rl.title, rl.unit_price_min, rl.unit,
                   rl.valid_from, rl.valid_to, rl.member_only
            FROM public.classification rc
            JOIN public.listing rl ON rl.id = rc.listing_id
            WHERE c.is_exact
              AND l.unit_price_min IS NOT NULL
              AND (l.unit <> 'stk' OR c.type_id IN ({_PIECE_TYPES}))
              AND rc.matcher_version = c.matcher_version
              AND rc.class_key = c.class_key
              AND rc.is_exact
              AND rl.chain_id <> l.chain_id
              AND rl.unit = l.unit
              AND rl.unit_price_min IS NOT NULL
              AND (rl.valid_to IS NULL OR rl.valid_to >= now())
              AND {_PRICE_APPLIES.format(c="rc", l="rl")}
              AND ((rl.kind = 'offer' AND rl.source IN ('tjek', 'rema'))
                   OR (rl.kind = 'regular' AND rl.source = 'tjek')
                   OR (rl.kind = 'regular' AND rl.source = 'rema' AND rl.valid_from <= now()))
              AND (rl.source <> 'tjek' OR {_LATEST_VERSION.format(l="rl")})
            ORDER BY rl.source, rl.source_item_id, rl.kind, (rl.valid_from <= now()) DESC,
                     rl.valid_from DESC, rl.last_seen_at DESC
        ) r
    ) fr ON true"""

_FOOD_WASTE_APPENDED = f""",
           l.product_key, l.source_item_id, s.source_store_id AS salling_store_id,
           ro.fetched_at AS source_fetched_at,
           CASE WHEN jsonb_typeof(l.extra -> 'percent_discount') = 'number'
                THEN (l.extra ->> 'percent_discount')::numeric
           END AS salling_percent_discount,
           l.extra ->> 'offer_ean' AS offer_ean,
           l.extra ->> 'product_code' AS product_code,
           c.class_key,
           COALESCE(fr.refs, '[]'::jsonb) AS food_waste_references,
           CASE WHEN fr.cheapest IS NOT NULL AND {_PRICE_APPLIES.format(c="c", l="l")}
                THEN round(COALESCE(l.unit_price_max, l.unit_price_min), 2)
                     <= round(fr.cheapest, 2)
           END AS beats_competitors"""

# 0007's class_price_history with a placeholder for appended columns.
_CLASS_PRICE_HISTORY = """
    SELECT c.class_key, c.class_label, l.kind, l.chain_id, ch.name AS chain_name,
           l.id AS listing_id, l.title, l.unit, l.unit_price_min, l.unit_price_max,
           l.valid_from, l.valid_to,
           (c.same_class_variants >= c.offer_variants
            OR l.unit_price_min IS NULL OR l.unit_price_max IS NULL
            OR l.unit_price_max <= 1.25 * l.unit_price_min) AS price_applies,
           l.member_only,
           l.source,
           l.source_item_id,
           l.catalog_id,
           l.store_id,
           l.price,
           l.description,
           l.size_min,
           l.size_max{appended}
    FROM public.listing l
    JOIN public.chain ch ON ch.id = l.chain_id
    JOIN public.classification c ON c.listing_id = l.id
    JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
"""

# Every listing under its product key, plus the EAN shelf prices Salling reported
# (`product_reference_price`, kind `reference`: a pack price observed from `valid_from` to
# `valid_to`; no unit price because Open Food Facts' size may describe another pack).
_PRODUCT_PRICE_HISTORY = """
    SELECT l.product_key, COALESCE(p.name, l.title) AS product_label, l.chain_id, l.kind,
           l.price, l.unit, l.unit_price_min, l.unit_price_max, l.size_min, l.size_max,
           l.valid_from, l.valid_to, l.source, l.source_item_id, l.catalog_id, l.store_id,
           l.member_only, l.id AS listing_id, l.title
    FROM public.listing l
    LEFT JOIN public.product p ON p.id = l.product_id
    UNION ALL
    SELECT 'ean:' || p.ean, p.name, prp.chain_id, 'reference',
           prp.price, NULL, NULL, NULL, NULL, NULL,
           prp.first_seen_at, prp.last_seen_at, 'salling_food_waste', NULL, NULL, NULL,
           false, NULL, p.name
    FROM public.product_reference_price prp
    JOIN public.product p ON p.id = prp.product_id
"""

# One row per product key: its latest listing (latest started first, then latest start).
_PRODUCTS = """
    SELECT DISTINCT ON (l.product_key)
           l.product_key, COALESCE(p.name, l.title) AS label, l.chain_id,
           ch.name AS chain_name, cl.class_key, cl.class_label, cl.is_exact, p.ean,
           l.id AS latest_listing_id, l.kind AS latest_kind, l.source AS latest_source,
           l.source_item_id AS latest_source_item_id, l.price AS latest_price,
           l.unit AS latest_unit, l.unit_price_min AS latest_unit_price_min,
           l.unit_price_max AS latest_unit_price_max, l.size_min AS latest_size_min,
           l.size_max AS latest_size_max, l.valid_from AS latest_valid_from,
           l.valid_to AS latest_valid_to, l.member_only AS latest_member_only
    FROM public.listing l
    JOIN public.chain ch ON ch.id = l.chain_id
    LEFT JOIN public.product p ON p.id = l.product_id
    LEFT JOIN LATERAL (
        SELECT c.class_key, c.class_label, c.is_exact
        FROM public.classification c
        JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
        WHERE c.listing_id = l.id
        ORDER BY c.variant_index
        LIMIT 1
    ) cl ON true
    ORDER BY l.product_key, (l.valid_from <= now()) DESC, l.valid_from DESC,
             l.last_seen_at DESC, l.id
"""

_NEW_VIEWS = ("current_deals", "product_price_history", "products")


def upgrade() -> None:
    op.execute(
        f"UPDATE public.listing SET kind = 'regular' WHERE kind = 'offer' AND {FIXED_LOW_PRICE_SQL}"
    )
    op.execute(
        f"ALTER TABLE public.listing ADD COLUMN product_key text"
        f" GENERATED ALWAYS AS ({PRODUCT_KEY_SQL}) STORED"
    )
    op.execute("CREATE INDEX ix_listing_product_key ON public.listing (product_key)")
    op.execute(f"CREATE VIEW api.current_deals AS {_CURRENT_DEALS}")
    op.execute(f"CREATE OR REPLACE VIEW api.current_netto_deals AS {_CURRENT_NETTO_DEALS}")
    op.execute(
        "CREATE OR REPLACE VIEW api.food_waste_near AS "
        + _FOOD_WASTE_NEAR.format(appended=_FOOD_WASTE_APPENDED, joins=_FOOD_WASTE_JOINS)
    )
    op.execute(
        "CREATE OR REPLACE VIEW api.class_price_history AS "
        + _CLASS_PRICE_HISTORY.format(appended=",\n           l.product_key")
    )
    op.execute(f"CREATE VIEW api.product_price_history AS {_PRODUCT_PRICE_HISTORY}")
    op.execute(f"CREATE VIEW api.products AS {_PRODUCTS}")
    for name in _NEW_VIEWS:
        op.execute(f"GRANT SELECT ON api.{name} TO {WEB_ROLE}")


def downgrade() -> None:
    for name in ("products", "product_price_history", "current_netto_deals", "current_deals"):
        op.execute(f"DROP VIEW api.{name}")
    restored = {
        "food_waste_near": _FOOD_WASTE_NEAR.format(appended="", joins=""),
        "class_price_history": _CLASS_PRICE_HISTORY.format(appended=""),
    }
    for name, query in restored.items():
        op.execute(f"DROP VIEW api.{name}")
        op.execute(f"CREATE VIEW api.{name} AS {query}")
        op.execute(f"GRANT SELECT ON api.{name} TO {WEB_ROLE}")
    op.execute(f"CREATE VIEW api.current_netto_deals AS {_CURRENT_NETTO_DEALS_0007}")
    op.execute(f"GRANT SELECT ON api.current_netto_deals TO {WEB_ROLE}")
    op.execute("DROP INDEX public.ix_listing_product_key")
    op.execute("ALTER TABLE public.listing DROP COLUMN product_key")
    op.execute(
        "UPDATE public.listing SET kind = 'offer' WHERE source = 'tjek' AND kind = 'regular'"
    )
