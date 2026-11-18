"""`api.current_netto_deals`: only the latest version of each Tjek offer id.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-18

Tjek re-publishes an offer id with a corrected price or start date, which the listing natural
key `(source, source_item_id, valid_from, price)` stores as a second listing. The Tjek ingest
now closes the earlier version; this view guard hides versions stored before that rule (and
matches the guard in `deals/compute.py`): a row is shown only when no listing of the same
`(source, source_item_id)` has a higher `(last_seen_at, valid_from)`.

Same columns as before, so the web contract is unchanged. Reversible: the downgrade restores
the definition of migration 0001.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SELECT = """
    SELECT l.id AS listing_id, c.variant_index, l.title, l.description, l.price, l.unit,
           l.unit_price_min, l.unit_price_max, l.valid_from, l.valid_to,
           c.type_id, c.type_label, c.group_name, c.class_key, c.class_label, c.attrs,
           c.is_exact, c.notes,
           d.price_applies, d.netto_unit_price_worst, d.netto_unit_price_best,
           COALESCE(d."references", '[]'::jsonb) AS "references"
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
"""

_LATEST_VERSION = """
      AND NOT EXISTS (
          SELECT 1 FROM public.listing nv
          WHERE nv.source = l.source
            AND nv.source_item_id = l.source_item_id
            AND nv.id <> l.id
            AND (nv.last_seen_at, nv.valid_from) > (l.last_seen_at, l.valid_from))
"""


def upgrade() -> None:
    op.execute(f"CREATE OR REPLACE VIEW api.current_netto_deals AS {_SELECT}{_LATEST_VERSION}")


def downgrade() -> None:
    op.execute(f"CREATE OR REPLACE VIEW api.current_netto_deals AS {_SELECT}")
