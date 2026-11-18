"""Geo tiling of the Salling food-waste job (pure logic)."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import UTC, datetime

import pytest

from foodcatch.geo import haversine_km
from foodcatch.jobs.salling_geo import (
    MAX_ATTEMPTS_PER_TARGET,
    GeoTiler,
    ReturnedStore,
    TargetStore,
)

# About 1.1 km per 0.01 degree latitude; 0.0179 degree longitude ~ 1.1 km at 56 N.
LAT0, LON0 = 56.0, 10.0
STEP_LAT, STEP_LON = 0.01, 0.0179


def _store(
    store_id: str,
    row: float,
    col: float,
    *,
    region: bool = False,
    brand: str = "netto",
    checked_at: datetime | None = None,
) -> TargetStore:
    return TargetStore(
        id=store_id,
        brand=brand,
        lat=LAT0 + row * STEP_LAT,
        lon=LON0 + col * STEP_LON,
        in_region=region,
        checked_at=checked_at,
    )


def _grid(rows: int, cols: int, *, region_rows: int = 0, prefix: str = "s") -> list[TargetStore]:
    """A grid of stores; the southern ``region_rows`` rows are the region."""
    return [
        _store(f"{prefix}{r:02d}{c:02d}", r, c, region=r < region_rows)
        for r in range(rows)
        for c in range(cols)
    ]


def _returned(items: Sequence[TargetStore]) -> list[ReturnedStore]:
    return [ReturnedStore(s.id, s.brand, s.lat, s.lon) for s in items]


type Api = Callable[[TargetStore], list[ReturnedStore]]


def _nearest_api(stores: Sequence[TargetStore], n: int) -> Api:
    def answer(target: TargetStore) -> list[ReturnedStore]:
        ranked = sorted(stores, key=lambda s: haversine_km(target.lat, target.lon, s.lat, s.lon))
        return _returned(ranked[:n])

    return answer


def _run(
    tiler: GeoTiler, stores: Sequence[TargetStore], *, n: int = 16, budget: int = 1000
) -> list[TargetStore]:
    """Drive the tiler against a fake 'n nearest stores' API; returns the targets in order."""
    answer = _nearest_api(stores, n)
    targets: list[TargetStore] = []
    while len(targets) < budget and (target := tiler.next_target()) is not None:
        targets.append(target)
        tiler.mark_covered(target, answer(target))
    return targets


# --------------------------------------------------------------------------- coverage


def test_response_covers_returned_and_nearer_absent_stores_of_the_same_brand() -> None:
    target = _store("t", 0, 0, region=True)
    near_netto = _store("near-netto", 0, 1, region=True)  # ~1.1 km, absent from the answer
    near_foetex = _store("near-foetex", 1, 0, brand="foetex")  # no foetex in the answer
    returned = _store("returned", 0, 3)  # ~3.3 km, returned
    beyond = _store("beyond", 0, 5)  # farther than every returned netto
    tiler = GeoTiler([target, near_netto, near_foetex, returned, beyond])

    coverage = tiler.mark_covered(target, _returned([target, returned]))

    assert coverage.returned == {"t", "returned"}
    assert coverage.inferred == {"near-netto"}
    assert tiler.covered == {"t", "returned", "near-netto"}
    assert tiler.region_complete


def test_store_at_the_edge_of_the_answer_is_not_inferred() -> None:
    target = _store("t", 0, 0)
    edge = _store("edge", 0, 2.99)  # within 5 % of the farthest returned distance
    returned = _store("returned", 0, 3)
    tiler = GeoTiler([target, edge, returned])

    coverage = tiler.mark_covered(target, _returned([target, returned]))

    assert "edge" not in coverage.stores


def test_target_counts_as_covered_even_if_absent_from_an_empty_answer() -> None:
    target = _store("t", 0, 0, region=True)
    other = _store("o", 0, 1, region=True)
    tiler = GeoTiler([target, other])

    coverage = tiler.mark_covered(target, [])

    assert coverage.inferred == {"t"}
    assert tiler.region_covered == 1
    assert tiler.next_target() == other


def test_unknown_returned_stores_are_ignored() -> None:
    target = _store("t", 0, 0)
    tiler = GeoTiler([target])

    coverage = tiler.mark_covered(
        target, [*_returned([target]), ReturnedStore("new", "netto", None, None)]
    )

    assert coverage.returned == {"t"}
    assert tiler.covered == {"t"}
    assert tiler.next_target() is None


def test_already_covered_stores_are_not_reported_again() -> None:
    a, b, c = _store("a", 0, 0), _store("b", 0, 1), _store("c", 0, 2)
    tiler = GeoTiler([a, b, c])
    tiler.mark_covered(a, _returned([a, b]))

    coverage = tiler.mark_covered(c, _returned([c, b]))

    assert coverage.returned == {"c"}


# --------------------------------------------------------------------------- planning


def test_covers_every_store_with_few_queries() -> None:
    stores = _grid(10, 10)
    tiler = GeoTiler(stores)

    targets = _run(tiler, stores, n=16)

    assert tiler.covered == {s.id for s in stores}
    assert tiler.remaining() == 0
    assert len(targets) <= 11  # 100 stores / 16 per query >= 7 queries
    assert len({t.id for t in targets}) == len(targets)


def test_region_is_covered_before_the_rest() -> None:
    stores = _grid(12, 6, region_rows=4)  # 24 region stores in the south
    tiler = GeoTiler(stores)
    answer = _nearest_api(stores, 16)

    calls_until_region = 0
    while not tiler.region_complete:
        target = tiler.next_target()
        assert target is not None
        response = answer(target)
        assert any(s.id in tiler.region_ids for s in response)  # every call serves the region
        tiler.mark_covered(target, response)
        calls_until_region += 1
    assert tiler.national_covered < tiler.national_total
    assert calls_until_region <= 3
    assert tiler.region_covered == tiler.region_total == 24


def test_rotation_prefers_never_checked_then_least_recently_checked() -> None:
    old = datetime(2026, 11, 1, tzinfo=UTC)
    new = datetime(2026, 11, 17, tzinfo=UTC)
    # three clusters ~50 km apart, no region
    recent = [_store(f"recent{i}", 0, i, checked_at=new) for i in range(3)]
    stale = [_store(f"stale{i}", 45, i, checked_at=old) for i in range(3)]
    never = [_store(f"never{i}", 90, i) for i in range(3)]
    stores = [*recent, *stale, *never]
    tiler = GeoTiler(stores, predicted_per_call=3)

    targets = _run(tiler, stores, n=3)

    clusters = [t.id.rstrip("0123456789") for t in targets]
    assert clusters == ["never", "stale", "recent"]


def test_rotation_continues_where_the_previous_run_stopped() -> None:
    stores = _grid(1, 40)  # a line of stores ~1.1 km apart, nothing in the region
    checked: dict[str, datetime | None] = {s.id: None for s in stores}
    seen_per_run: list[set[str]] = []
    stalest_before: set[str] = set()
    for run in range(4):
        times = [t for t in checked.values() if t is not None]
        if None not in checked.values() and times:
            stalest_before = {sid for sid, t in checked.items() if t == min(times)}
        current = [
            TargetStore(s.id, s.brand, s.lat, s.lon, s.in_region, checked[s.id]) for s in stores
        ]
        tiler = GeoTiler(current, predicted_per_call=8)
        _run(tiler, current, n=8, budget=2)  # 2 calls cover 16 of 40 stores
        seen_per_run.append(set(tiler.covered))
        for store_id in tiler.covered:
            checked[store_id] = datetime(2026, 11, 18, run, tzinfo=UTC)

    assert all(len(seen) == 16 for seen in seen_per_run)
    assert seen_per_run[0].isdisjoint(seen_per_run[1])
    assert len(seen_per_run[0] | seen_per_run[1] | seen_per_run[2]) == 40  # whole line covered
    # after a full cycle the least recently checked stores come first again
    assert stalest_before
    assert stalest_before <= seen_per_run[3]
    assert stalest_before <= seen_per_run[0]


def test_failed_target_is_retried_once_then_given_up() -> None:
    only = _store("only", 0, 0, region=True)
    tiler = GeoTiler([only])

    for _ in range(MAX_ATTEMPTS_PER_TARGET):
        assert tiler.next_target() == only
        tiler.mark_failed(only)

    assert tiler.next_target() is None
    assert not tiler.region_complete


def test_no_stores() -> None:
    tiler = GeoTiler([])
    assert tiler.next_target() is None
    assert tiler.region_complete
    assert tiler.region_total == tiler.national_total == 0


@pytest.mark.parametrize("n", [12, 16, 19])
def test_prediction_mismatch_still_terminates(n: int) -> None:
    stores = _grid(6, 6, region_rows=3)
    tiler = GeoTiler(stores)  # predicts 16 per call whatever the API returns

    _run(tiler, stores, n=n)

    assert tiler.remaining() == 0
