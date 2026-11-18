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
