"""Pack size in the product key of Tjek items.

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-20

`listing.product_key` of a Tjek leaflet item was `offer:<chain>:<normalized title>`, so products
sharing a heading were one item: "Faxe Kondi" at 10 kr (one bottle) and 75 kr (a crate) looked
like a 650 % price rise in its history. The key now ends in the pack size when it is known
(`offer:netto:faxe kondi:1.5l`, `offer:lidl:kyllingebryst:0.4-0.5kg`; `db/product_key.py`).
Rema, EAN and clearance keys are unchanged.

A generated column's expression cannot be changed in place before PostgreSQL 17, so the column
is dropped and added again (the table is rewritten once and every key recomputed). The views
that select it are dropped first and recreated from migration 0008's frozen definitions, which
are unchanged: the view columns and grants stay the same. Links to `/produkt/offer:…` pages of
the old form stop resolving (the web app runs locally only, ADR 0003).

Reversible: the downgrade restores 0008's key rule the same way.
"""

import importlib.util
from collections.abc import Sequence
from pathlib import Path
from types import ModuleType

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
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
_SIZE_SUFFIX = (
    "CASE WHEN unit IS NOT NULL AND size_min IS NOT NULL"
    " THEN ':' || trim_scale(size_min)::text"
    " || CASE WHEN size_max IS NOT NULL AND size_max <> size_min"
    " THEN '-' || trim_scale(size_max)::text ELSE '' END"
    " || unit ELSE '' END"
)
PRODUCT_KEY_SQL = (
    "CASE"
    " WHEN source = 'rema' THEN 'rema:' || source_item_id"
    " WHEN source = 'salling_food_waste' AND product_id IS NOT NULL"
    " AND (extra ->> 'product_code') IS NOT NULL THEN 'ean:' || (extra ->> 'product_code')"
    " WHEN source = 'salling_food_waste'"
    f" THEN 'clearance:' || chain_id || ':' || {_NORMALIZED_TITLE}"
    f" ELSE 'offer:' || chain_id || ':' || {_NORMALIZED_TITLE} || {_SIZE_SUFFIX}"
    " END"
)


def _migration_0008() -> ModuleType:
    """Migration 0008 (its view definitions and key rule are frozen, so they can be reused)."""
    path = Path(__file__).with_name("0008_all_chain_deals_and_product_history.py")
    spec = importlib.util.spec_from_file_location("foodcatch_migration_0008", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _views(m: ModuleType) -> list[tuple[str, str]]:
    """The api views selecting `listing.product_key`, as 0008 defines them (creation order)."""
    return [
        ("current_deals", m._CURRENT_DEALS),
        ("current_netto_deals", m._CURRENT_NETTO_DEALS),
        (
            "food_waste_near",
            m._FOOD_WASTE_NEAR.format(appended=m._FOOD_WASTE_APPENDED, joins=m._FOOD_WASTE_JOINS),
        ),
        (
            "class_price_history",
            m._CLASS_PRICE_HISTORY.format(appended=",\n           l.product_key"),
        ),
        ("product_price_history", m._PRODUCT_PRICE_HISTORY),
        ("products", m._PRODUCTS),
    ]


def _set_product_key(expression: str) -> None:
    views = _views(_migration_0008())
    for name, _ in reversed(views):
        op.execute(f"DROP VIEW api.{name}")
    op.execute("DROP INDEX public.ix_listing_product_key")
    op.execute("ALTER TABLE public.listing DROP COLUMN product_key")
    op.execute(
        f"ALTER TABLE public.listing ADD COLUMN product_key text"
        f" GENERATED ALWAYS AS ({expression}) STORED"
    )
    op.execute("CREATE INDEX ix_listing_product_key ON public.listing (product_key)")
    for name, query in views:
        op.execute(f"CREATE VIEW api.{name} AS {query}")
        op.execute(f"GRANT SELECT ON api.{name} TO {WEB_ROLE}")


def upgrade() -> None:
    _set_product_key(PRODUCT_KEY_SQL)


def downgrade() -> None:
    _set_product_key(_migration_0008().PRODUCT_KEY_SQL)
