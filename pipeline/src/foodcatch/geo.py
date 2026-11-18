"""Geographic helpers (great-circle distance and region membership)."""

from __future__ import annotations

import math
from collections.abc import Iterable

EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres between two WGS84 points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def in_region(
    lat: float, lon: float, centers: Iterable[tuple[float, float]], radius_km: float
) -> bool:
    """Whether ``(lat, lon)`` lies within ``radius_km`` of any of ``centers``.

    Used to decide which food-waste clearances are stored as listings (architecture §4,
    ``REGION_CENTERS`` / ``REGION_RADIUS_KM``).
    """
    return any(haversine_km(lat, lon, c_lat, c_lon) <= radius_km for c_lat, c_lon in centers)
