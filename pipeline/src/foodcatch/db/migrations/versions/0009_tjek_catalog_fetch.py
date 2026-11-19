"""Per-catalog fetch state of the `tjek-offers` job.

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-19

* `tjek_catalog_fetch` - one row per Tjek catalog whose offers were fetched in full: the catalog
  fingerprint (hash of the catalog-list fields that change with the content) and when the offers
  were last fetched. `tjek-offers` skips the offer pages of a catalog whose fingerprint is
  unchanged and whose last full fetch is younger than `TJEK_FULL_REFRESH_DAYS`. Scheduling
  state only (like `store.food_waste_checked_at`): not written by ingest, not replayed by
  `foodcatch reprocess`, safe to empty (the next run then fetches every catalog). Expand-only:
  the previous code keeps working against the new schema.

No view changes.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tjek_catalog_fetch",
        sa.Column("catalog_id", sa.Text(), nullable=False),
        sa.Column("chain_id", sa.Text(), nullable=False),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        sa.Column("offer_count", sa.Integer(), nullable=True),
        sa.Column("offers_fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["chain_id"], ["chain.id"], name=op.f("fk_tjek_catalog_fetch_chain_id_chain")
        ),
        sa.PrimaryKeyConstraint("catalog_id", name=op.f("pk_tjek_catalog_fetch")),
    )


def downgrade() -> None:
    op.drop_table("tjek_catalog_fetch")
