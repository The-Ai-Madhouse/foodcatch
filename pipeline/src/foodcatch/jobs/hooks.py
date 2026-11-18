"""Post-fetch pipeline hooks (architecture §4 steps 5-6).

After a job body has ingested its payloads, :func:`run_post_fetch_hooks` calls each hook in
:data:`POST_FETCH_HOOKS` with the run's connection and :class:`PipelineState`:

1. :func:`classify_new_listings` - ``matching.persist.classify_pending`` for the listings the
   run touched (and any other listing still lacking a classification for the matcher version);
   classified listing ids are added to ``state.listing_ids``.
2. :func:`compute_deals` - ``deals.compute.recompute_deals`` for those listings.

The hooks only delegate; the matching and deals modules own the logic. ``foodcatch reprocess``
runs the same hooks after replaying raw objects.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from sqlalchemy import Connection

from foodcatch.deals.compute import recompute_deals
from foodcatch.jobs.context import PipelineState
from foodcatch.matching import MATCHER_VERSION
from foodcatch.matching.persist import classify_pending

type PostFetchHook = Callable[[Connection, PipelineState], None]


def classify_new_listings(conn: Connection, state: PipelineState) -> None:
    """Classify pending listings with the current ``MATCHER_VERSION``."""
    classified = classify_pending(conn, version=MATCHER_VERSION, listing_ids=state.listing_ids)
    state.stats["classified"] += len(classified)
    state.listing_ids.update(classified)


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
