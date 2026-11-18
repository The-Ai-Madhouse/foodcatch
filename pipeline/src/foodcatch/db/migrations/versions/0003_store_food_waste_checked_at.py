"""Rotation state of the geo-tiled Salling food-waste job on `store`.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-18

* `store.food_waste_checked_at` - when a `salling-food-waste` run last covered the store with a
  geo query (ADR 0005). Stores outside the food-waste region are covered in rotation, least
  recently checked first. Nullable (never checked); expand-only, so the previous code keeps
  working against the new schema.

No view changes: the `api` views list their columns explicitly.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "store",
        sa.Column("food_waste_checked_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("store", "food_waste_checked_at")
