import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_LENGTH,
  TtlCache,
  buildSearchUrl,
  createRateLimiter,
  normalizeQuery,
  parseSearchResponse,
  shortenDisplayName,
} from "./geocode";

describe("query and URL", () => {
  it("normalizes whitespace and control characters and limits the length", () => {
    expect(normalizeQuery("  Nørrebrogade\t10,\n2200  ")).toBe("Nørrebrogade 10, 2200");
    expect(normalizeQuery("x".repeat(500))).toHaveLength(MAX_QUERY_LENGTH);
    expect(normalizeQuery("   ")).toBe("");
  });

  it("builds a Danish, single-result search URL", () => {
    const url = new URL(buildSearchUrl("Nørrebrogade 10, 2200 København N"));
    expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("countrycodes")).toBe("dk");
    expect(url.searchParams.get("q")).toBe("Nørrebrogade 10, 2200 København N");
  });
});

describe("parseSearchResponse", () => {
  it("returns the first hit with a short label", () => {
    expect(
      parseSearchResponse([
        {
          lat: "55.6867",
          lon: "12.5590",
          display_name:
            "10, Nørrebrogade, Nørrebro, København, Københavns Kommune, Region Hovedstaden, 2200, Danmark",
        },
      ]),
    ).toEqual({ lat: 55.6867, lon: 12.559, label: "10, Nørrebrogade, Nørrebro, København" });
  });

  it("returns null when nothing matched", () => {
    expect(parseSearchResponse([])).toBeNull();
  });

  it("rejects unexpected payloads", () => {
    expect(() => parseSearchResponse({ error: "x" })).toThrow(TypeError);
    expect(() => parseSearchResponse([null])).toThrow(TypeError);
    expect(() => parseSearchResponse([{ lat: 55, lon: 12 }])).toThrow(TypeError);
    expect(() => parseSearchResponse([{ lat: "95", lon: "12" }])).toThrow(TypeError);
  });

  it("drops the country from display names", () => {
    expect(shortenDisplayName("Rådhuspladsen, København, Danmark")).toBe(
      "Rådhuspladsen, København",
    );
  });
});

describe("TtlCache", () => {
  it("expires entries and evicts the oldest", () => {
    let now = 0;
    const cache = new TtlCache<number | null>(1000, 2, () => now);
    cache.set("a", 1);
    cache.set("miss", null);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("miss")).toBeNull();
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.size).toBe(2);
    now = 1000;
    expect(cache.get("c")).toBeUndefined();
  });
});

describe("createRateLimiter", () => {
  it("spaces calls by the interval and survives failures", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limit = createRateLimiter(
      1000,
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    );
    const starts: number[] = [];
    const task = (fail = false) =>
      limit(async () => {
        starts.push(now);
        if (fail) throw new Error("boom");
        return now;
      });
    const results = await Promise.allSettled([task(), task(true), task()]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(starts).toEqual([0, 1000, 2000]);
    expect(sleeps).toEqual([1000, 1000]);
  });
});
