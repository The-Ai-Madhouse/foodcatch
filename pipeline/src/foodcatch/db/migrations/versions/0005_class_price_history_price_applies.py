"""`api.class_price_history.price_applies`: whether a row's unit price is this product's.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-18

The price history of a class listed every classified listing, including multi-product offers
("Dansk hel kylling eller hakket kyllingekød") whose kilo price range mostly belongs to another
product. The new column `price_applies` uses the rule of `deals/compute.py` (architecture §6):
the offer is homogeneous (`same_class_variants >= offer_variants`), its unit-price range is
unknown, or its spread is at most 25 %. The web leaves rows where it is false out of the chart
and marks them in the table.

The column is appended, so existing readers are unaffected. Reversible: the downgrade restores
the definition of migration 0001 (dropping and recreating the view, which loses no data).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

WEB_ROLE = "web_readonly"
PRICE_SPREAD_LIMIT = "1.25"  # deals.compute.PRICE_SPREAD_LIMIT at the time of writing

_COLUMNS = """
    SELECT c.class_key, c.class_label, l.kind, l.chain_id, ch.name AS chain_name,
           l.id AS listing_id, l.title, l.unit, l.unit_price_min, l.unit_price_max,
           l.valid_from, l.valid_to"""
_PRICE_APPLIES = f""",
           (c.same_class_variants >= c.offer_variants
            OR l.unit_price_min IS NULL OR l.unit_price_max IS NULL
            OR l.unit_price_max <= {PRICE_SPREAD_LIMIT} * l.unit_price_min) AS price_applies"""
_FROM = """
    FROM public.listing l
    JOIN public.chain ch ON ch.id = l.chain_id
    JOIN public.classification c ON c.listing_id = l.id
    JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
"""


def upgrade() -> None:
    op.execute(
        f"CREATE OR REPLACE VIEW api.class_price_history AS {_COLUMNS}{_PRICE_APPLIES}{_FROM}"
    )


def downgrade() -> None:
    op.execute("DROP VIEW api.class_price_history")
    op.execute(f"CREATE VIEW api.class_price_history AS {_COLUMNS}{_FROM}")
    op.execute(f"GRANT SELECT ON api.class_price_history TO {WEB_ROLE}")
