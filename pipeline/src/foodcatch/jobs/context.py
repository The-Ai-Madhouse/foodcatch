"""The :class:`JobContext` handed to every job body."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

import httpx
from sqlalchemy import Connection, Engine, insert
from structlog.typing import FilteringBoundLogger

from foodcatch.config import Settings
from foodcatch.db.tables import raw_object
from foodcatch.ingest import IngestResult, RawPayload, get_ingester
from foodcatch.jobs.registry import JobSpec
from foodcatch.sources import Fetched
from foodcatch.storage.raw import RawStore, raw_key

_SECRET_PARAM = re.compile(r"auth|token|secret|password|api[_-]?key", re.IGNORECASE)


@dataclass(slots=True)
class PipelineState:
    """State shared by the ingest step and the post-fetch hooks of one run.

    Attributes:
        listing_ids: listings inserted/changed in this run (hooks may add more).
        stats: counters persisted in ``fetch_run.stats``.
    """

    listing_ids: set[UUID] = field(default_factory=set[UUID])
    stats: Counter[str] = field(default_factory=Counter[str])


class JobContext:
    """Everything a job needs: settings, DB connection, HTTP client, raw store and stats.

    ``conn`` is a connection inside the run's main transaction; it is committed after the job
    body and the post-fetch hooks succeed and rolled back otherwise. Raw objects are recorded
    in a separate, immediately committed transaction so provenance survives failures.
    """

    def __init__(
        self,
        *,
        run_id: UUID,
        spec: JobSpec,
        started_at: datetime,
        settings: Settings,
        engine: Engine,
        conn: Connection,
        http: httpx.Client,
        raw_store: RawStore,
        log: FilteringBoundLogger,
        state: PipelineState | None = None,
    ) -> None:
        self.run_id = run_id
        self.spec = spec
        self.started_at = started_at
        self.settings = settings
        self.engine = engine
        self.conn = conn
        self.http = http
        self.raw_store = raw_store
        self.log = log
        self.state = state or PipelineState()
        self._seq = 0

    @property
    def job(self) -> str:
        """Name of the running job."""
        return self.spec.name

    @property
    def source(self) -> str:
        """Raw-store source name of the running job."""
        return self.spec.source

    @property
    def stats(self) -> Counter[str]:
        """Counters persisted in ``fetch_run.stats``."""
        return self.state.stats

    @property
    def listing_ids(self) -> set[UUID]:
        """Listings inserted/changed by this run."""
        return self.state.listing_ids

    def count(self, key: str, n: int = 1) -> None:
        """Increment the ``key`` counter by ``n``."""
        self.state.stats[key] += n

    def mark_listings(self, ids: Iterable[UUID]) -> None:
        """Register listings for classification and deal computation."""
        self.state.listing_ids.update(ids)

    def store_raw(self, endpoint: str, params: Mapping[str, Any], body: bytes) -> UUID:
        """Store ``body`` unchanged in the raw store and record a ``raw_object`` row.

        The object key follows architecture §4; the row is committed immediately.

        Args:
            endpoint: endpoint name (one path segment, e.g. ``food-waste``).
            params: request parameters (JSON-serializable, never secrets).
            body: the response body exactly as received.

        Returns:
            The new ``raw_object.id``.

        Raises:
            ValueError: if ``params`` contains a key that looks like a secret.
        """
        leaked = [k for k in params if _SECRET_PARAM.search(k)]
        if leaked:
            raise ValueError(f"refusing to record secret-looking params: {leaked}")
        key = raw_key(self.source, endpoint, self.started_at, self.run_id, self._seq)
        self._seq += 1
        info = self.raw_store.put(key, body)
        object_id = uuid4()
        with self.engine.begin() as raw_conn:
            raw_conn.execute(
                insert(raw_object).values(
                    id=object_id,
                    fetch_run_id=self.run_id,
                    source=self.source,
                    endpoint=endpoint,
                    params=dict(params),
                    storage_key=key,
                    sha256=info.sha256,
                    bytes=info.bytes,
                )
            )
        self.count("raw_objects")
        self.count("raw_bytes", info.bytes)
        return object_id

    def record_ingest(self, result: IngestResult) -> None:
        """Merge an :class:`IngestResult` into the run's stats and listing set."""
        self.count("records", result.records)
        self.state.stats.update(result.counts)
        self.state.listing_ids |= result.listing_ids

    def ingest(self, fetched: Fetched[Any]) -> IngestResult:
        """Store a fetched response raw, then ingest it with the job source's ingester.

        This is the canonical path for jobs: it guarantees that ``foodcatch reprocess`` replays
        exactly what happened live.
        """
        object_id = self.store_raw(fetched.endpoint, fetched.params, fetched.body)
        payload = RawPayload(
            raw_object_id=object_id,
            source=self.source,
            endpoint=fetched.endpoint,
            params=fetched.params,
            body=fetched.body,
            fetched_at=self.started_at,
        )
        result = get_ingester(self.source)(self.conn, payload, settings=self.settings)
        self.record_ingest(result)
        return result
