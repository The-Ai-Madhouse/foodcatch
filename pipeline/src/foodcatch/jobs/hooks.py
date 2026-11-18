"""Post-fetch pipeline hooks (architecture §4 steps 5-6).

After a job body has ingested its payloads, :func:`run_post_fetch_hooks` calls each hook in
:data:`POST_FETCH_HOOKS` with the run's connection and :class:`PipelineState`:

1. :func:`classify_new_listings` - ``matching.persist.classify_pending`` with the code's
   ``MATCHER_VERSION`` for the listings the run inserted or changed, plus every listing not yet
   processed with that version. It returns the ids of listings whose ``classification`` rows
   changed (written, replaced or removed); they are added to ``state.listing_ids``. If
   ``MATCHER_VERSION`` is not the current ``matcher_release`` (the first run after a matcher
   upgrade), that call has just classified every listing with it, so the release is made
   current and old classifications are pruned - exactly what ``foodcatch reclassify`` would do.
   Without this, new listings would only be classified with a version the views and deals do
   not read until someone ran ``reclassify`` by hand.
2. :func:`compute_deals` - ``deals.compute.recompute_deals`` for ``state.listing_ids``: the
   listings ingest changed (a competitor price change needs new deals even when its
   classification is unchanged) and those whose classification changed. ``deals.compute``
   widens that to every Netto variant of the affected classes, so no ``Match`` objects need to
   be rebuilt here: deal references are same-class rows, i.e. equal ``class_key`` and
   ``is_exact``, which is ``matching.comparability(a, b) == "same"`` for matches rebuilt with
   ``taxonomy.get_type(type_id).key_attrs`` (pinned by ``tests/jobs/test_hooks.py``).

The hooks only delegate; the matching and deals modules own the logic. ``foodcatch reprocess``
runs the same hooks after replaying raw objects.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from sqlalchemy import Connection

from foodcatch.deals.compute import recompute_deals
from foodcatch.jobs.context import PipelineState
from foodcatch.logging import get_logger
from foodcatch.matching import MATCHER_VERSION
from foodcatch.matching.persist import (
    classify_pending,
    current_release,
    prune_classifications,
    set_current_release,
)

type PostFetchHook = Callable[[Connection, PipelineState], None]

log = get_logger(__name__)


def classify_new_listings(conn: Connection, state: PipelineState) -> None:
    """Classify pending listings with ``MATCHER_VERSION``; make it current after an upgrade."""
    changed = classify_pending(conn, version=MATCHER_VERSION, listing_ids=state.listing_ids)
    state.stats["classification_changed"] += len(changed)
    state.listing_ids.update(changed)
    previous = current_release(conn)
    if previous != MATCHER_VERSION:
        set_current_release(conn, MATCHER_VERSION)
        pruned = prune_classifications(conn)
        state.stats["matcher_promoted"] += 1
        log.warning(
            "matcher.promoted", version=MATCHER_VERSION, previous=previous, pruned_rows=pruned
        )


def compute_deals(conn: Connection, state: PipelineState) -> None:
    """Recompute deals affected by the run's listings (skipped when nothing changed)."""
    if not state.listing_ids:
        return
    state.stats["deals"] += recompute_deals(conn, listing_ids=state.listing_ids)


POST_FETCH_HOOKS: tuple[PostFetchHook, ...] = (classify_new_listings, compute_deals)


def run_post_fetch_hooks(
    conn: Connection, state: PipelineState, hooks: Sequence[PostFetchHook] = POST_FETCH_HOOKS
) -> None:
    """Run ``hooks`` in order inside the caller's transaction."""
    for hook in hooks:
        hook(conn, state)
