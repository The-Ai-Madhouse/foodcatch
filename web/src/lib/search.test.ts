import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_LENGTH,
  type SearchHit,
  isCurrent,
  likePattern,
  parseSearchQuery,
  searchHref,
  searchTerms,
  sortHits,
} from "./search";

const now = new Date("2026-11-20T12:00:00Z");

function hit(overrides: Partial<SearchHit>): SearchHit {
  return {
    productKey: "offer:netto:x:1kg",
    label: "X",
    chainId: "netto",
    chainName: "Netto",
    classKey: null,
    classLabel: null,
    isExact: null,
    ean: null,
    latestSource: "tjek",
    latestPrice: 10,
    latestUnit: "kg",
    latestSizeMin: 1,
    latestSizeMax: 1,
    latestValidFrom: "2026-11-15T00:00:00Z",
    latestValidTo: "2026-11-21T22:59:59Z",
    latestKind: "offer",
    latestUnitPriceMin: 10,
    latestUnitPriceMax: 10,
    priceCount: 1,
    ...overrides,
  };
}

describe("parseSearchQuery", () => {
  it("trims, collapses whitespace and caps the length", () => {
    expect(parseSearchQuery("  Faxe \n  Kondi ")).toBe("Faxe Kondi");
    expect(parseSearchQuery(["mælk", "ost"])).toBe("mælk");
    expect(parseSearchQuery(undefined)).toBe("");
    expect(parseSearchQuery("x".repeat(100))).toHaveLength(MAX_QUERY_LENGTH);
  });
});

describe("searchTerms", () => {
  it("splits into distinct lower-case words", () => {
    expect(searchTerms("Hakket OKSEKØD hakket")).toEqual(["hakket", "oksekød"]);
  });

  it("ignores too short queries and caps the number of words", () => {
    expect(searchTerms("a")).toEqual([]);
    expect(searchTerms("a b c d e f g")).toHaveLength(5);
  });
});

describe("likePattern", () => {
  it("escapes LIKE wildcards", () => {
    expect(likePattern("8-12%")).toBe("%8-12\\%%");
    expect(likePattern("a_b\\c")).toBe("%a\\_b\\\\c%");
  });
});

describe("sortHits", () => {
  it("puts current items first, then the most recent, then by name", () => {
    const old = hit({ label: "Gammel", latestValidTo: "2026-11-01T00:00:00Z" });
    const regular = hit({ label: "Hylde", latestValidTo: null, latestValidFrom: "2026-11-01" });
    const offer = hit({ label: "Tilbud", latestValidFrom: "2026-11-18T00:00:00Z" });
    const offerB = hit({ label: "Æble", latestValidFrom: "2026-11-18T00:00:00Z" });
    expect(sortHits([old, regular, offerB, offer], now).map((h) => h.label)).toEqual([
      "Tilbud",
      "Æble",
      "Hylde",
      "Gammel",
    ]);
    expect(isCurrent(old, now)).toBe(false);
    expect(isCurrent(regular, now)).toBe(true);
  });
});

describe("searchHref", () => {
  it("encodes the query", () => {
    expect(searchHref(" rugbrød & smør ")).toBe("/soeg?q=rugbr%C3%B8d+%26+sm%C3%B8r");
    expect(searchHref("")).toBe("/soeg");
  });
});
