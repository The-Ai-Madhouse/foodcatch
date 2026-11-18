/** Geographic helpers. Mirrors `pipeline/src/foodcatch/geo.py` (same Earth radius). */

export const EARTH_RADIUS_KM = 6371.0;

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres between two WGS84 points. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = toRadians(lat1);
  const p2 = toRadians(lat2);
  const dp = toRadians(lat2 - lat1);
  const dl = toRadians(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * A latitude/longitude box that contains every point within `radiusKm` of `center`.
 *
 * Used as a cheap, index-friendly pre-filter before the exact haversine distance. Not meant for
 * the poles or the antimeridian (FoodCatch covers Denmark).
 */
export function boundingBox(center: Coordinates, radiusKm: number): BoundingBox {
  const dLat = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const dLon = dLat / Math.max(Math.cos(toRadians(center.lat)), 1e-6);
  return {
    minLat: center.lat - dLat,
    maxLat: center.lat + dLat,
    minLon: center.lon - dLon,
    maxLon: center.lon + dLon,
  };
}

/** Whether a latitude/longitude pair is a valid WGS84 coordinate. */
export function isValidCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}
