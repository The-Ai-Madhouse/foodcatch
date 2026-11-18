"""Persisting recognition results (owned by the matching module).

Expected public functions (signatures are a contract; called by the job hooks and the CLI):

* :func:`classify_pending` - classify listings that have no ``classification`` rows for
  ``version`` (restricted to ``listing_ids`` when given). Writes one row per recognized variant
  (``variant_index`` 0..n-1, all :class:`~foodcatch.matching.Match` fields incl. ``class_label``
  and ``is_healthy = is_healthy_staple(m)``), applies ``classification_override`` rows (matched
  on source + normalized title), and enqueues ``review_item`` rows for doubtful cases
  (``unrecognized_staple_word``, ``unknown_key_attribute``, ``ambiguous_offer``). Inserts the
  ``matcher_release`` row for ``version`` if missing (not current). Listings that were
  re-ingested with a changed title/description must be re-classified. Listings with no
  recognized variant get no rows, so remember that they were processed (e.g. via
  ``listing.extra``) to avoid reclassifying them on every run.
* :func:`reclassify_all` - classify every listing with ``version``, mark ``version`` current in
  ``matcher_release`` and prune classifications of all but the two most recent versions.

Both run inside the caller's transaction (never commit).
"""

from __future__ import annotations

from collections.abc import Collection
from uuid import UUID

from sqlalchemy import Connection

from foodcatch.matching import MATCHER_VERSION


def classify_pending(
    conn: Connection, *, version: str, listing_ids: Collection[UUID] | None = None
) -> list[UUID]:
    """Classify pending listings; returns the ids of listings that got classification rows.

    Stub: classifies nothing until the matching module is implemented (a no-op hook).
    """
    del conn, version, listing_ids
    return []


def reclassify_all(conn: Connection, *, version: str = MATCHER_VERSION) -> int:
    """Re-classify all listings with ``version`` and make it current; returns listings processed."""
    raise NotImplementedError
