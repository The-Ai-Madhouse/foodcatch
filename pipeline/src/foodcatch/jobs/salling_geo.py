"""Geo tiling for the ``salling-food-waste`` job (pure logic, no I/O; ADR 0005).

Salling's ``GET /v1/food-waste/?geo=lat,lon`` answers with the ~16-19 stores nearest to the
point (also those without clearances). :class:`GeoTiler` decides where to query so that a run
covers as many known stores as possible with few requests:

1. **Region first.** Stores within ``REGION_RADIUS_KM`` of a ``REGION_CENTERS`` entry (their
   clearances become listings) are covered before anything else.
2. **Then the rest of the country in rotation.** Outside the region only reference prices are
   collected, so it is covered over several runs: the stores checked least recently (never
   checked first) come first. The check time is persisted per store by the job
   (``store.food_waste_checked_at``).

Queries are sent at the coordinates of an uncovered known store. The tiler predicts each
candidate's answer as its :data:`PREDICTED_STORES_PER_CALL` nearest known stores and covers
greedily, most constrained first: the store still wanted by the current phase that the fewest
candidates would reach is handled first, by the candidate reaching the most wanted stores
(then the nearest one; ties north to south). Plain "largest predicted gain" greedy leaves
isolated stores for the end and needed a few more queries for the default region in a
simulation on the real store list.

After a response, every returned store is covered. A known store that is *not* returned but lies
closer to the query point than the farthest returned store of its brand (with a
:data:`INFERENCE_TOLERANCE` margin) is covered as well: the API lists the nearest stores, so such
a store is unknown to the food-waste service, and querying it again would only repeat the same
answer. A target whose request failed is retried once later in the run.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime

from foodcatch.geo import haversine_km

PREDICTED_STORES_PER_CALL = 16
"""Stores a geo query is expected to return (Salling returned 16-19 in November 2026)."""
INFERENCE_TOLERANCE = 0.95
"""Fraction of the farthest returned distance within which absent stores count as covered."""
MAX_ATTEMPTS_PER_TARGET = 2
"""A target whose request failed is tried at most this often per run."""


@dataclass(frozen=True, slots=True)
class TargetStore:
    """A known Salling store the job wants to cover.

    Attributes:
        id: Salling store id (``store.source_store_id``).
        brand: Salling brand (``netto``, ``foetex``, ``bilka``).
        lat: latitude.
        lon: longitude.
        in_region: whether the store lies in the food-waste region (listings are kept).
        checked_at: when a run last covered it (``None``: never).
    """

    id: str
    brand: str
    lat: float
    lon: float
    in_region: bool
    checked_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ReturnedStore:
    """A store contained in a geo response (only what tiling needs)."""

    id: str
    brand: str
    lat: float | None
    lon: float | None


@dataclass(frozen=True, slots=True)
class Coverage:
    """What one geo response covered.

    Attributes:
        returned: known stores contained in the response that were not covered yet.
        inferred: known stores covered because they are absent from the response although
            closer than the farthest returned store of their brand.
    """

    returned: frozenset[str] = frozenset()
    inferred: frozenset[str] = frozenset()

    @property
    def stores(self) -> frozenset[str]:
        """All stores newly covered."""
        return self.returned | self.inferred


def _staleness(item: TargetStore) -> tuple[bool, float]:
    """Sort key: never checked first, then the oldest check."""
    if item.checked_at is None:
        return (False, 0.0)
    return (True, item.checked_at.timestamp())


def _north_to_south(item: TargetStore) -> tuple[float, float, str]:
    return (-item.lat, item.lon, item.id)


@dataclass
class GeoTiler:
    """Plans the geo queries of one run (see the module docstring).

    Use :meth:`next_target` to get the store to query at, then report the outcome with
    :meth:`mark_covered` (a response) or :meth:`mark_failed` (an error).
    """

    stores: Sequence[TargetStore]
    predicted_per_call: int = PREDICTED_STORES_PER_CALL
    covered: set[str] = field(default_factory=set[str], init=False)
    _by_id: dict[str, TargetStore] = field(default_factory=dict[str, TargetStore], init=False)
    _attempts: dict[str, int] = field(default_factory=dict[str, int], init=False)
    _nearest: dict[str, tuple[str, ...]] = field(
        default_factory=dict[str, tuple[str, ...]], init=False
    )

    def __post_init__(self) -> None:
        self._by_id = {item.id: item for item in self.stores}

    # ------------------------------------------------------------------ progress

    @property
    def region_ids(self) -> frozenset[str]:
        """Ids of the region stores."""
        return frozenset(item.id for item in self.stores if item.in_region)

    @property
    def region_total(self) -> int:
        """Number of region stores."""
        return len(self.region_ids)

    @property
    def region_covered(self) -> int:
        """Number of region stores covered so far."""
        return len(self.region_ids & self.covered)

    @property
    def region_complete(self) -> bool:
        """Whether every region store is covered."""
        return self.region_ids <= self.covered

    @property
    def national_total(self) -> int:
        """Number of stores outside the region."""
        return len(self.stores) - self.region_total

    @property
    def national_covered(self) -> int:
        """Number of stores outside the region covered so far."""
        return len(self.covered & self._by_id.keys()) - self.region_covered

    def remaining(self) -> int:
        """Known stores not covered yet."""
        return len(self._by_id.keys() - self.covered)

    # ------------------------------------------------------------------ planning

    def _open(self, item: TargetStore) -> bool:
        return (
            item.id not in self.covered and self._attempts.get(item.id, 0) < MAX_ATTEMPTS_PER_TARGET
        )

    def predicted(self, item: TargetStore) -> tuple[str, ...]:
        """The known stores a query at ``item`` is expected to return (nearest first)."""
        cached = self._nearest.get(item.id)
        if cached is None:
            by_distance = sorted(
                self.stores,
                key=lambda other: (
                    haversine_km(item.lat, item.lon, other.lat, other.lon),
                    other.id,
                ),
            )
            cached = tuple(other.id for other in by_distance[: self.predicted_per_call])
            self._nearest[item.id] = cached
        return cached

    def _best(
        self, candidates: Iterable[TargetStore], wanted: Callable[[TargetStore], bool]
    ) -> TargetStore | None:
        """Most-constrained-first greedy cover.

        The wanted store that the fewest candidates would cover is handled first (so isolated
        stores do not pile up at the end), by the candidate covering the most wanted stores;
        among those the one closest to it. Remaining ties go north to south, which makes the
        choice deterministic.
        """
        ordered = sorted(candidates, key=_north_to_south)
        covers: dict[str, list[TargetStore]] = {}
        score: dict[str, int] = {}
        for item in ordered:
            reach = [
                other_id
                for other_id in self.predicted(item)
                if other_id not in self.covered and wanted(self._by_id[other_id])
            ]
            score[item.id] = len(reach)
            for other_id in reach:
                covers.setdefault(other_id, []).append(item)
        if not covers:
            return None
        hardest = self._by_id[
            min(
                covers,
                key=lambda store_id: (
                    len(covers[store_id]),
                    _north_to_south(self._by_id[store_id]),
                ),
            )
        ]
        # min() keeps the first of equal keys, i.e. the north-to-south order.
        return min(
            covers[hardest.id],
            key=lambda item: (
                -score[item.id],
                haversine_km(hardest.lat, hardest.lon, item.lat, item.lon),
            ),
        )

    def next_target(self) -> TargetStore | None:
        """The store to query at next, or ``None`` when every store is covered (or given up).

        While a region store is open, the query must cover region stores; afterwards it must
        cover the stalest open stores outside the region. Any open store may serve as the query
        point (e.g. a store just outside the region that reaches the region's last stores); every
        store wanted by a phase predicts itself, so the phase always progresses.
        """
        open_stores = [item for item in self.stores if self._open(item)]
        if any(item.in_region for item in open_stores):
            return self._best(open_stores, lambda other: other.in_region)
        national = [item for item in open_stores if not item.in_region]
        if not national:
            return None
        stalest = min(_staleness(item) for item in national)
        return self._best(
            national, lambda other: not other.in_region and _staleness(other) == stalest
        )

    # ------------------------------------------------------------------ outcomes

    def mark_failed(self, target: TargetStore) -> None:
        """Record a failed request at ``target`` (it is retried up to the attempt limit)."""
        self._attempts[target.id] = self._attempts.get(target.id, 0) + 1

    def mark_covered(self, target: TargetStore, returned: Sequence[ReturnedStore]) -> Coverage:
        """Record the response of a query at ``target``; returns what it newly covered.

        The target itself always counts as covered (also when the answer is empty), so a store
        the food-waste service does not know is queried once per run at most.
        """
        self._attempts[target.id] = self._attempts.get(target.id, 0) + 1
        returned_ids = {item.id for item in returned}
        farthest: dict[str, float] = {}
        for item in returned:
            if item.lat is None or item.lon is None:
                continue
            distance = haversine_km(target.lat, target.lon, item.lat, item.lon)
            brand = item.brand.lower()
            farthest[brand] = max(distance, farthest.get(brand, 0.0))
        inferred: set[str] = set()
        for item in self.stores:
            if item.id in returned_ids or item.id in self.covered:
                continue
            limit = farthest.get(item.brand.lower())
            if limit is None:
                continue
            distance = haversine_km(target.lat, target.lon, item.lat, item.lon)
            if distance < limit * INFERENCE_TOLERANCE:
                inferred.add(item.id)
        newly_returned = (returned_ids & self._by_id.keys()) - self.covered
        if target.id not in self.covered and target.id not in returned_ids:
            inferred.add(target.id)
        coverage = Coverage(frozenset(newly_returned), frozenset(inferred))
        self.covered |= coverage.stores
        return coverage


__all__ = [
    "INFERENCE_TOLERANCE",
    "MAX_ATTEMPTS_PER_TARGET",
    "PREDICTED_STORES_PER_CALL",
    "Coverage",
    "GeoTiler",
    "ReturnedStore",
    "TargetStore",
]
