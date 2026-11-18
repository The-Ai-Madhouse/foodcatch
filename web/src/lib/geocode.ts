/**
 * Pure helpers for geocoding addresses with Nominatim (OpenStreetMap): request URL, response
 * validation, a small TTL cache and a minimum-interval rate limiter (Nominatim's usage policy
 * allows at most one request per second and requires caching).
 */

import { isValidCoordinate, type Coordinates } from "./geo";

export const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

/** Longest address we send to Nominatim. */
export const MAX_QUERY_LENGTH = 200;

export interface GeocodeResult extends Coordinates {
  /** Display label for the UI (shortened Nominatim `display_name`). */
  label: string;
}

/** Collapse whitespace and trim; returns "" for blank input. */
export function normalizeQuery(query: string): string {
  return query
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/** The search URL for a (normalized) Danish address. */
export function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({
    format: "json",
    limit: "1",
    countrycodes: "dk",
    "accept-language": "da",
    q: query,
  });
  return `${NOMINATIM_SEARCH_URL}?${params.toString()}`;
}

/**
 * Shorten Nominatim's `display_name` ("10, Nørrebrogade, Nørrebro, København, ..., Danmark") to
 * the first few parts, without the country.
 */
export function shortenDisplayName(displayName: string, maxParts = 4): string {
  const parts = displayName
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && p !== "Danmark" && p !== "Denmark");
  return parts.slice(0, maxParts).join(", ");
}

/**
 * Validate a Nominatim search response. Returns the first hit, null when there is none, and
 * throws a `TypeError` when the payload does not have the documented shape.
 */
export function parseSearchResponse(json: unknown): GeocodeResult | null {
  if (!Array.isArray(json)) throw new TypeError("Nominatim response is not an array");
  const first: unknown = json[0];
  if (first === undefined) return null;
  if (typeof first !== "object" || first === null) {
    throw new TypeError("Nominatim result is not an object");
  }
  const { lat, lon, display_name: displayName } = first as Record<string, unknown>;
  const latNum = typeof lat === "string" ? Number(lat) : Number.NaN;
  const lonNum = typeof lon === "string" ? Number(lon) : Number.NaN;
  if (!isValidCoordinate(latNum, lonNum))
    throw new TypeError("Nominatim result has no coordinates");
  return {
    lat: latNum,
    lon: lonNum,
    label: typeof displayName === "string" ? shortenDisplayName(displayName) : "",
  };
}

/** A bounded in-memory cache whose entries expire after `ttlMs`. Oldest entries are evicted. */
export class TtlCache<V> {
  readonly #entries = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

/**
 * Serialize calls so that consecutive calls start at least `intervalMs` apart.
 *
 * `schedule(fn)` resolves with `fn()`'s result; a failing `fn` does not block later calls.
 */
export function createRateLimiter(
  intervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      const wait = lastStart + intervalMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      return fn();
    });
    tail = run.catch(() => undefined);
    return run;
  };
}
