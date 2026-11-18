import "server-only";

import packageJson from "../../package.json";
import {
  TtlCache,
  buildSearchUrl,
  createRateLimiter,
  normalizeQuery,
  parseSearchResponse,
  type GeocodeResult,
} from "@/lib/geocode";

/** Raised when the geocoding service fails (network, HTTP status or unexpected payload). */
export class GeocodingError extends Error {
  override name = "GeocodingError";
}

/** `User-Agent` required by architecture §3 and Nominatim's usage policy. */
export const USER_AGENT = `foodcatch/${packageJson.version} (+https://github.com/toke-dk/foodcatch)`;

const CACHE_TTL_MS = 30 * 24 * 3_600_000;
const REQUEST_TIMEOUT_MS = 8_000;

// One cache and one limiter per server process (kept across hot reloads in development).
const globalForGeocode = globalThis as unknown as {
  foodcatchGeocode?: {
    cache: TtlCache<GeocodeResult | null>;
    limit: <T>(fn: () => Promise<T>) => Promise<T>;
  };
};

function state() {
  globalForGeocode.foodcatchGeocode ??= {
    cache: new TtlCache<GeocodeResult | null>(CACHE_TTL_MS, 1000),
    limit: createRateLimiter(1_100),
  };
  return globalForGeocode.foodcatchGeocode;
}

/**
 * Geocode a Danish address. Returns null when nothing matches.
 *
 * Results (including misses) are cached in memory for 30 days; requests to Nominatim are
 * serialized at most one per ~1.1 s.
 */
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const query = normalizeQuery(address);
  if (!query) return null;
  const key = query.toLocaleLowerCase("da-DK");
  const { cache, limit } = state();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const result = await limit(async () => {
    let response: Response;
    try {
      response = await fetch(buildSearchUrl(query), {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      throw new GeocodingError("Nominatim request failed", { cause: error });
    }
    if (!response.ok) throw new GeocodingError(`Nominatim answered HTTP ${response.status}`);
    try {
      return parseSearchResponse(await response.json());
    } catch (error) {
      throw new GeocodingError("Unexpected Nominatim response", { cause: error });
    }
  });
  cache.set(key, result);
  return result;
}
