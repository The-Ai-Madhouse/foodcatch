"""Expose `listing.member_only` in `api.current_netto_deals` and `api.class_price_history`.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-18

Tjek offers whose text marks a member price (e.g. Netto+, Coop members) are stored with
`listing.member_only = true`. The web shows them with a "Medlemspris" badge, and a member-only
Netto price may only be a "Godt køb" when it is shown as such (architecture §6). Deal
references carry the flag in their JSON (`member_only`), written by `deals/compute.py`.

The column is appended to both views, so existing readers are unaffected. Reversible: the
downgrade restores the definitions of migrations 0004 and 0005 (dropping and recreating the
views, which loses no data).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

WEB_ROLE = "web_readonly"

_CURRENT_NETTO_DEALS = """
    SELECT l.id AS listing_id, c.variant_index, l.title, l.description, l.price, l.unit,
           l.unit_price_min, l.unit_price_max, l.valid_from, l.valid_to,
           c.type_id, c.type_label, c.group_name, c.class_key, c.class_label, c.attrs,
           c.is_exact, c.notes,
           d.price_applies, d.netto_unit_price_worst, d.netto_unit_price_best,
           COALESCE(d."references", '[]'::jsonb) AS "references"{member_only}
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

_CLASS_PRICE_HISTORY = """
    SELECT c.class_key, c.class_label, l.kind, l.chain_id, ch.name AS chain_name,
           l.id AS listing_id, l.title, l.unit, l.unit_price_min, l.unit_price_max,
           l.valid_from, l.valid_to,
           (c.same_class_variants >= c.offer_variants
            OR l.unit_price_min IS NULL OR l.unit_price_max IS NULL
            OR l.unit_price_max <= 1.25 * l.unit_price_min) AS price_applies{member_only}
    FROM public.listing l
    JOIN public.chain ch ON ch.id = l.chain_id
    JOIN public.classification c ON c.listing_id = l.id
    JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
"""

_VIEWS = {"current_netto_deals": _CURRENT_NETTO_DEALS, "class_price_history": _CLASS_PRICE_HISTORY}


def upgrade() -> None:
    for name, query in _VIEWS.items():
        sql = query.format(member_only=",\n           l.member_only")
        op.execute(f"CREATE OR REPLACE VIEW api.{name} AS {sql}")


def downgrade() -> None:
    for name, query in _VIEWS.items():
        op.execute(f"DROP VIEW api.{name}")
        op.execute(f"CREATE VIEW api.{name} AS {query.format(member_only='')}")
        op.execute(f"GRANT SELECT ON api.{name} TO {WEB_ROLE}")
