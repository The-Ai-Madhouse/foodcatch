"""Matcher state columns on `listing` and a reviewer note on `review_item`.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-18

* `listing.classified_version` / `listing.classified_fingerprint` replace the
  `listing.extra["matcher"]` marker of `matching.persist`. Ingest upserts own `extra` and may
  replace it, which used to erase the marker (re-classifying listings on every run) and made
  ingest report unchanged listings as changed. Existing markers are moved into the columns.
* `review_item.note` stores the reviewer's note given to `foodcatch review resolve --note`.

No view changes: the `api` views list their columns explicitly. Fully reversible: the downgrade
writes the markers back into `listing.extra` before dropping the columns.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("listing", sa.Column("classified_version", sa.Text(), nullable=True))
    op.add_column("listing", sa.Column("classified_fingerprint", sa.Text(), nullable=True))
    op.add_column("review_item", sa.Column("note", sa.Text(), nullable=True))
    # `->` on a non-object marker yields NULL, so a malformed marker simply means "unclassified".
    op.execute(
        """
        UPDATE listing
        SET classified_version = extra -> 'matcher' ->> 'version',
            classified_fingerprint = extra -> 'matcher' ->> 'fingerprint',
            extra = extra - 'matcher'
        WHERE extra ? 'matcher'
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE listing
        SET extra = extra || jsonb_build_object(
                'matcher',
                jsonb_build_object(
                    'version', classified_version, 'fingerprint', classified_fingerprint))
        WHERE classified_version IS NOT NULL
        """
    )
    op.drop_column("review_item", "note")
    op.drop_column("listing", "classified_fingerprint")
    op.drop_column("listing", "classified_version")
