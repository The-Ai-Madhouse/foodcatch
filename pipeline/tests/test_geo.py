from __future__ import annotations

import pytest

from foodcatch.geo import haversine_km, in_region

COPENHAGEN = (55.6761, 12.5683)
AARHUS = (56.1629, 10.2039)


def test_haversine_known_distance() -> None:
    assert haversine_km(*COPENHAGEN, *AARHUS) == pytest.approx(157, abs=2)
    assert haversine_km(*COPENHAGEN, *COPENHAGEN) == 0


def test_in_region() -> None:
    roskilde = (55.6415, 12.0803)
    assert in_region(*roskilde, [COPENHAGEN], 31)
    assert not in_region(*roskilde, [COPENHAGEN], 30)
    assert in_region(*AARHUS, [COPENHAGEN, AARHUS], 1)
    assert not in_region(*AARHUS, [], 1000)
