/**
 * The user's chosen location (architecture §7 "Location handling"): coordinates, a display label
 * and a search radius. Stored server-side in a cookie as compact JSON; everything here is pure
 * so it can be unit tested.
 */

import { isValidCoordinate, type Coordinates } from "./geo";

export const LOCATION_COOKIE = "fc_location";
export const RADIUS_OPTIONS_KM = [1, 2, 3, 4, 5] as const;
export const DEFAULT_RADIUS_KM = 2;
export const MAX_LABEL_LENGTH = 120;

/** Copenhagen City Hall Square; used when neither the cookie nor the environment has a value. */
export const FALLBACK_COORDINATES: Coordinates = { lat: 55.6761, lon: 12.5683 };

export interface UserLocation extends Coordinates {
  label: string;
  radiusKm: number;
  /** Whether the user chose this location (false: default from configuration). */
  isDefault: boolean;
}

/** Clamp a radius to the allowed 1-5 km; returns the default for anything unparsable. */
export function clampRadius(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return DEFAULT_RADIUS_KM;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** Parse `"lat,lon"` (as in `FOODCATCH_DEFAULT_LOCATION`); null when malformed or out of range. */
export function parseCoordinates(value: string | null | undefined): Coordinates | null {
  if (!value) return null;
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length !== 2 || parts.some((p) => !/^[-+]?\d+(\.\d+)?$/.test(p))) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  return isValidCoordinate(lat, lon) ? { lat, lon } : null;
}

/** The location shown before the user has chosen one. */
export function defaultLocation(envValue: string | null | undefined): UserLocation {
  const coords = parseCoordinates(envValue) ?? FALLBACK_COORDINATES;
  return { ...coords, label: "Standardplacering", radiusKm: DEFAULT_RADIUS_KM, isDefault: true };
}

function sanitizeLabel(label: unknown): string {
  if (typeof label !== "string") return "Valgt placering";
  // Strip control characters; keep it short (labels come from Nominatim or the user).
  const clean = label
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Valgt placering";
  return clean.length > MAX_LABEL_LENGTH ? `${clean.slice(0, MAX_LABEL_LENGTH - 1)}…` : clean;
}

/** Serialize a location for the cookie (coordinates rounded to ~1 m). */
export function serializeLocation(loc: Omit<UserLocation, "isDefault">): string {
  return JSON.stringify({
    lat: Math.round(loc.lat * 1e5) / 1e5,
    lon: Math.round(loc.lon * 1e5) / 1e5,
    label: sanitizeLabel(loc.label),
    r: clampRadius(loc.radiusKm),
  });
}

/** Parse the cookie value; null when missing or invalid (never throws). */
export function parseLocationCookie(value: string | null | undefined): UserLocation | null {
  if (!value) return null;
  let data: unknown;
  try {
    data = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { lat, lon, label, r } = data as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lon !== "number" || !isValidCoordinate(lat, lon)) {
    return null;
  }
  return { lat, lon, label: sanitizeLabel(label), radiusKm: clampRadius(r), isDefault: false };
}

/** localStorage key of the client-side backup of the location (docs/ui.md §5.1). */
export const LOCATION_STORAGE_KEY = "foodcatch.location.v1";

/** Label of a location taken from the browser's geolocation. */
export const MY_POSITION_LABEL = "Min position";

/** The location as kept in localStorage (and as returned by the location actions). */
export interface StoredLocation {
  lat: number;
  lon: number;
  label: string;
  r: number;
  savedAt: string;
}

/**
 * Validate a stored location (a JSON string or an already parsed value) with the cookie's rules.
 * Returns null for anything malformed; never throws.
 */
export function parseStoredLocation(value: unknown): StoredLocation | null {
  let data = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { savedAt } = data as Record<string, unknown>;
  const parsed = parseLocationCookie(JSON.stringify(data));
  if (!parsed) return null;
  const savedAtMs = typeof savedAt === "string" ? Date.parse(savedAt) : Number.NaN;
  return {
    lat: Math.round(parsed.lat * 1e5) / 1e5,
    lon: Math.round(parsed.lon * 1e5) / 1e5,
    label: parsed.label,
    r: parsed.radiusKm,
    savedAt: Number.isFinite(savedAtMs)
      ? new Date(savedAtMs).toISOString()
      : new Date(0).toISOString(),
  };
}

/** The stored form of a location. */
export function toStoredLocation(
  loc: Pick<UserLocation, "lat" | "lon" | "label" | "radiusKm">,
  now: Date,
): StoredLocation {
  const parsed = parseStoredLocation({
    ...JSON.parse(serializeLocation(loc)),
    savedAt: now.toISOString(),
  });
  if (!parsed) throw new RangeError("Invalid location");
  return parsed;
}

/** Whether two locations show the same place, label and radius (ignores `savedAt`). */
export function sameStoredLocation(
  a: Pick<StoredLocation, "lat" | "lon" | "label" | "r"> | null,
  b: Pick<StoredLocation, "lat" | "lon" | "label" | "r"> | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.lat - b.lat) < 1e-5 &&
    Math.abs(a.lon - b.lon) < 1e-5 &&
    a.label === b.label &&
    a.r === b.r
  );
}
