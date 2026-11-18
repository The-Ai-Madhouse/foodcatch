"""Expose source ids, pack sizes and food-waste images in the `api` views (docs/ui.md §8).

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-18

The redesigned web links every price to its source (eTilbudsavis offer and store pages, the
REMA 1000 product page), shows pack sizes next to prices and shows the Salling product image of
a food-waste item. Everything is read from columns that ingest already stores, so no ingest
change or backfill is needed:

* `api.stores` + `source, source_store_id` (deduplicating stores known to Salling and Tjek, and
  the eTilbudsavis store page).
* `api.current_netto_deals` + `source, source_item_id, catalog_id, size_min, size_max,
  max_per_customer`.
* `api.food_waste_near` + `size` (net size parsed from the Salling name), `image_url` (the
  Salling image; null for its placeholder `…/image` and for any other host),
  `product_quantity_text, product_net_quantity, product_net_unit` (Open Food Facts, which may
  describe another pack size) and `last_seen_at` (stock snapshot time).
* `api.class_price_history` + `source, source_item_id, catalog_id, store_id, price,
  description, size_min, size_max` (details of the comparison rows of a deal card).

Columns are appended (`CREATE OR REPLACE VIEW` keeps the existing ones and their grants), so
existing readers are unaffected. Reversible: the downgrade restores the definitions of
migrations 0001 (`stores`, `food_waste_near`) and 0006 (`current_netto_deals`,
`class_price_history`), dropping and recreating the views, which loses no data.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

WEB_ROLE = "web_readonly"

# Salling image CDN; the placeholder for products without a picture ends in "/image".
SALLING_IMAGE_PREFIX = "https://digitalassets.sallinggroup.com/"

_STORES = """
    SELECT s.id, s.chain_id, ch.name AS chain_name, s.name, s.street, s.zip, s.city,
           s.lat, s.lon{appended}
    FROM public.store s
    JOIN public.chain ch ON ch.id = s.chain_id
    WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL
"""

_CURRENT_NETTO_DEALS = """
    SELECT l.id AS listing_id, c.variant_index, l.title, l.description, l.price, l.unit,
           l.unit_price_min, l.unit_price_max, l.valid_from, l.valid_to,
           c.type_id, c.type_label, c.group_name, c.class_key, c.class_label, c.attrs,
           c.is_exact, c.notes,
           d.price_applies, d.netto_unit_price_worst, d.netto_unit_price_best,
           COALESCE(d."references", '[]'::jsonb) AS "references",
           l.member_only{appended}
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

# Clearances seen by the latest finished food-waste run (sold-out items disappear). The nested
# join is 0001's form, so the downgrade restores that definition exactly.
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
           c.type_label, c.class_label, c.is_exact{appended}
    FROM public.listing l
    JOIN public.store s ON s.id = l.store_id
    LEFT JOIN public.product p ON p.id = l.product_id
    JOIN public.classification c
         JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
      ON c.listing_id = l.id
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

_CLASS_PRICE_HISTORY = """
    SELECT c.class_key, c.class_label, l.kind, l.chain_id, ch.name AS chain_name,
           l.id AS listing_id, l.title, l.unit, l.unit_price_min, l.unit_price_max,
           l.valid_from, l.valid_to,
           (c.same_class_variants >= c.offer_variants
            OR l.unit_price_min IS NULL OR l.unit_price_max IS NULL
            OR l.unit_price_max <= 1.25 * l.unit_price_min) AS price_applies,
           l.member_only{appended}
    FROM public.listing l
    JOIN public.chain ch ON ch.id = l.chain_id
    JOIN public.classification c ON c.listing_id = l.id
    JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
"""

# (view, definition, columns appended by this migration)
_VIEWS: list[tuple[str, str, list[str]]] = [
    ("stores", _STORES, ["s.source", "s.source_store_id"]),
    (
        "current_netto_deals",
        _CURRENT_NETTO_DEALS,
        [
            "l.source",
            "l.source_item_id",
            "l.catalog_id",
            "l.size_min",
            "l.size_max",
            "l.max_per_customer",
        ],
    ),
    (
        "food_waste_near",
        _FOOD_WASTE_NEAR,
        [
            "l.size_min AS size",
            f"""CASE WHEN l.extra ->> 'image' LIKE '{SALLING_IMAGE_PREFIX}%'
                 AND l.extra ->> 'image' NOT LIKE '%/image'
                THEN l.extra ->> 'image'
           END AS image_url""",
            "p.quantity_text AS product_quantity_text",
            "p.net_quantity AS product_net_quantity",
            "p.net_unit AS product_net_unit",
            "l.last_seen_at",
        ],
    ),
    (
        "class_price_history",
        _CLASS_PRICE_HISTORY,
        [
            "l.source",
            "l.source_item_id",
            "l.catalog_id",
            "l.store_id",
            "l.price",
            "l.description",
            "l.size_min",
            "l.size_max",
        ],
    ),
]


def upgrade() -> None:
    for name, query, columns in _VIEWS:
        appended = "".join(f",\n           {column}" for column in columns)
        op.execute(f"CREATE OR REPLACE VIEW api.{name} AS {query.format(appended=appended)}")


def downgrade() -> None:
    for name, query, _ in _VIEWS:
        op.execute(f"DROP VIEW api.{name}")
        op.execute(f"CREATE VIEW api.{name} AS {query.format(appended='')}")
        op.execute(f"GRANT SELECT ON api.{name} TO {WEB_ROLE}")
