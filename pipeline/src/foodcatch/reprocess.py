"""Replay raw objects through ingest, classify and deals (``foodcatch reprocess``).

Architecture §4: "replays steps 4-6 from the raw store". Objects are processed in fetch order,
so later observations win exactly as they did live. The body's sha256 is verified against the
``raw_object`` row before ingesting.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime

from sqlalchemy import Engine, select

from foodcatch.config import Settings
from foodcatch.db.tables import raw_object
from foodcatch.ingest import IngestResult, RawPayload, get_ingester
from foodcatch.jobs.context import PipelineState
from foodcatch.jobs.hooks import POST_FETCH_HOOKS, PostFetchHook, run_post_fetch_hooks
from foodcatch.logging import get_logger
from foodcatch.storage.raw import RawStore, RawStoreError

log = get_logger(__name__)


class RawIntegrityError(RawStoreError):
    """A stored body does not match the sha256 recorded in ``raw_object``."""


@dataclass(frozen=True, slots=True)
class ReprocessResult:
    """Summary of a reprocess run."""

    objects: int
    records: int
    listings: int
    stats: dict[str, int]


def reprocess(
    engine: Engine,
    raw_store: RawStore,
    settings: Settings,
    *,
    source: str,
    since: date | None = None,
    until: date | None = None,
    hooks: Sequence[PostFetchHook] = POST_FETCH_HOOKS,
) -> ReprocessResult:
    """Re-ingest raw objects of ``source`` fetched in ``[since, until)`` (UTC days).

    Everything runs in one transaction; split long replays into consecutive ranges with
    ``until`` (exclusive) so each range commits on its own.

    Raises:
        UnknownSourceError: if ``source`` has no ingest module.
        RawIntegrityError: if a stored body does not match its recorded sha256.
    """
    ingester = get_ingester(source)
    query = select(raw_object).where(raw_object.c.source == source)
    if since is not None:
        since_ts = datetime(since.year, since.month, since.day, tzinfo=UTC)
        query = query.where(raw_object.c.fetched_at >= since_ts)
    if until is not None:
        until_ts = datetime(until.year, until.month, until.day, tzinfo=UTC)
        query = query.where(raw_object.c.fetched_at < until_ts)
    query = query.order_by(raw_object.c.fetched_at, raw_object.c.storage_key)

    state = PipelineState()
    total = IngestResult()
    objects = 0
    with engine.begin() as conn:
        for row in conn.execute(query).all():
            body = raw_store.get(row.storage_key)
            if hashlib.sha256(body).hexdigest() != row.sha256:
                raise RawIntegrityError(f"sha256 mismatch for {row.storage_key}")
            payload = RawPayload(
                raw_object_id=row.id,
                source=row.source,
                endpoint=row.endpoint,
                params=row.params,
                body=body,
                fetched_at=row.fetched_at,
            )
            total.merge(ingester(conn, payload, settings=settings))
            objects += 1
        state.listing_ids |= total.listing_ids
        state.stats.update(total.counts)
        state.stats["records"] += total.records
        run_post_fetch_hooks(conn, state, hooks)
    log.info("reprocess.done", source=source, objects=objects, records=total.records)
    return ReprocessResult(
        objects=objects,
        records=total.records,
        listings=len(state.listing_ids),
        stats=dict(state.stats),
    )
