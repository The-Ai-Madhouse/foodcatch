"""Rebuild missing ``raw_object`` rows from the raw store (``foodcatch raw reindex``).

``foodcatch reprocess`` replays objects listed in ``raw_object``. After a database restore (or a
total loss) the raw store in B2 may hold objects whose rows are gone; this module lists the store,
parses each key (architecture §4: ``{source}/{endpoint}/{YYYY}/{MM}/{DD}/{fetch_run_id}/
{seq:05d}.json.gz``) and inserts a row for every object that has none:

* ``sha256`` and ``bytes`` are recomputed from the stored body;
* ``fetched_at`` is the time the object was written (file mtime / S3 ``LastModified``), which is
  within seconds of the original fetch and keeps the replay order of ``reprocess``;
* ``params`` is ``{"reindexed": true}`` - the original request parameters are not recoverable
  (no ingest module depends on them: Open Food Facts falls back to the EAN in the body);
* a ``fetch_run`` the rows can reference is created when its id is unknown: job
  :data:`REINDEX_JOB`, status ``succeeded``, started/finished at the first/last object time.

Objects are processed one fetch run at a time, each in its own transaction, so an interrupted
reindex keeps its progress; re-running it is a no-op for objects already indexed.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from datetime import date
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Engine, insert, select

from foodcatch.db.tables import fetch_run, raw_object
from foodcatch.logging import get_logger
from foodcatch.storage.raw import RawStore, StoredObject, describe

log = get_logger(__name__)

REINDEX_JOB = "raw-reindex"
"""``fetch_run.job`` of placeholder runs created for objects of unknown runs."""

KEY_PATTERN = re.compile(
    r"^(?P<source>[^/]+)/(?P<endpoint>[^/]+)/(?P<year>\d{4})/(?P<month>\d{2})/(?P<day>\d{2})/"
    r"(?P<run>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/"
    r"(?P<seq>\d{5})\.json\.gz$"
)
_LOOKUP_CHUNK = 1000


@dataclass(frozen=True, slots=True)
class ParsedKey:
    """The parts of a canonical raw-store key."""

    key: str
    source: str
    endpoint: str
    day: date
    run_id: UUID
    seq: int


def parse_key(key: str) -> ParsedKey | None:
    """Parse a canonical raw-store key; ``None`` if ``key`` does not follow the layout."""
    match = KEY_PATTERN.match(key)
    if match is None:
        return None
    try:
        day = date(int(match["year"]), int(match["month"]), int(match["day"]))
    except ValueError:
        return None
    return ParsedKey(
        key=key,
        source=match["source"],
        endpoint=match["endpoint"],
        day=day,
        run_id=UUID(match["run"]),
        seq=int(match["seq"]),
    )


@dataclass(frozen=True, slots=True)
class ReindexResult:
    """Summary of a reindex."""

    scanned: int
    indexed: int
    already_indexed: int
    skipped: int
    runs_created: int


def _in_range(day: date, since: date | None, until: date | None) -> bool:
    return (since is None or day >= since) and (until is None or day < until)


def _existing_keys(engine: Engine, keys: Sequence[str]) -> set[str]:
    found: set[str] = set()
    with engine.connect() as conn:
        for start in range(0, len(keys), _LOOKUP_CHUNK):
            chunk = list(keys[start : start + _LOOKUP_CHUNK])
            found.update(
                conn.execute(
                    select(raw_object.c.storage_key).where(raw_object.c.storage_key.in_(chunk))
                ).scalars()
            )
    return found


def _index_run(
    engine: Engine,
    raw_store: RawStore,
    run_id: UUID,
    objects: Sequence[tuple[ParsedKey, StoredObject]],
) -> bool:
    """Insert the rows of one run's objects; returns whether a placeholder run was created."""
    times = [stored.modified_at for _, stored in objects]
    rows: list[dict[str, Any]] = []
    for parsed, stored in objects:
        info = describe(raw_store.get(parsed.key))
        rows.append(
            {
                "id": uuid4(),
                "fetch_run_id": run_id,
                "source": parsed.source,
                "endpoint": parsed.endpoint,
                "params": {"reindexed": True},
                "storage_key": parsed.key,
                "sha256": info.sha256,
                "bytes": info.bytes,
                "fetched_at": stored.modified_at,
            }
        )
    with engine.begin() as conn:
        known = conn.execute(select(fetch_run.c.id).where(fetch_run.c.id == run_id)).first()
        if known is None:
            conn.execute(
                insert(fetch_run).values(
                    id=run_id,
                    job=REINDEX_JOB,
                    source=objects[0][0].source,
                    status="succeeded",
                    started_at=min(times),
                    finished_at=max(times),
                    stats={"reindexed_objects": len(rows)},
                )
            )
        conn.execute(insert(raw_object), rows)
    return known is None


def reindex(
    engine: Engine,
    raw_store: RawStore,
    *,
    sources: Iterable[str],
    since: date | None = None,
    until: date | None = None,
    dry_run: bool = False,
) -> ReindexResult:
    """Insert ``raw_object`` rows for stored objects of ``sources`` that have none.

    Args:
        since: only keys dated on/after this day (the date in the key, UTC).
        until: only keys dated before this day (exclusive).
        dry_run: count what would be indexed without writing anything.
    """
    scanned = skipped = 0
    candidates: list[tuple[ParsedKey, StoredObject]] = []
    for source in sources:
        for stored in raw_store.iter_objects(f"{source}/"):
            scanned += 1
            parsed = parse_key(stored.key)
            if parsed is None or parsed.source != source:
                skipped += 1
                log.warning("raw.reindex.unparseable_key", key=stored.key)
                continue
            if _in_range(parsed.day, since, until):
                candidates.append((parsed, stored))

    existing = _existing_keys(engine, [parsed.key for parsed, _ in candidates])
    missing = [(p, s) for p, s in candidates if p.key not in existing]
    by_run: dict[UUID, list[tuple[ParsedKey, StoredObject]]] = defaultdict(list)
    for parsed, stored in missing:
        by_run[parsed.run_id].append((parsed, stored))

    runs_created = 0
    if not dry_run:
        for run_id, objects in by_run.items():
            objects.sort(key=lambda item: (item[1].modified_at, item[0].key))
            runs_created += _index_run(engine, raw_store, run_id, objects)
    result = ReindexResult(
        scanned=scanned,
        indexed=len(missing),
        already_indexed=len(candidates) - len(missing),
        skipped=skipped,
        runs_created=runs_created,
    )
    log.info("raw.reindex.done", dry_run=dry_run, **asdict(result))
    return result
