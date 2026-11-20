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
  cheapestFirst,
  commonUnit,
  hitTiming,
  groupHits,
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

describe("where an item is cheapest", () => {
  it("knows whether a price applies now, later or only in the past", () => {
    expect(hitTiming(hit({}), now)).toBe("now");
    expect(hitTiming(hit({ latestValidFrom: "2026-11-22T00:00:00Z" }), now)).toBe("later");
    expect(hitTiming(hit({ latestValidTo: "2026-11-19T00:00:00Z" }), now)).toBe("past");
    // A shelf price without an end applies now.
    expect(hitTiming(hit({ latestKind: "regular", latestValidTo: null }), now)).toBe("now");
  });

  it("sorts nearby chains first, then by unit price in the common unit", () => {
    const hits = [
      hit({ productKey: "a", chainId: "netto", latestUnitPriceMin: 30 }),
      hit({ productKey: "b", chainId: "rema1000", latestUnitPriceMin: 20 }),
      hit({ productKey: "c", chainId: "lidl", latestUnitPriceMin: 5 }), // no store nearby
      hit({ productKey: "d", chainId: "netto", latestUnit: "stk", latestUnitPriceMin: 1 }),
      hit({
        productKey: "e",
        chainId: "netto",
        latestUnitPriceMin: null,
        latestUnitPriceMax: null,
      }),
    ];
    const unit = commonUnit(hits);
    expect(unit).toBe("kg");
    const order = cheapestFirst(hits, unit, new Set(["netto", "rema1000"]));
    expect(order.map((h) => h.productKey)).toEqual(["b", "a", "d", "e", "c"]);
  });
});

describe("groupHits", () => {
  it("only compares the same item: one group per exact class, cheapest first", () => {
    const pork = {
      classKey: "hakket_grisekød|fedt=8-12%",
      classLabel: "Hakket grisekød, 8-12%",
      isExact: true,
    };
    const beef = {
      classKey: "hakket_oksekød|fedt=8-12%",
      classLabel: "Hakket oksekød, 8-12%",
      isExact: true,
    };
    const groups = groupHits(
      [
        hit({ productKey: "p1", ...pork, latestUnitPriceMin: 40 }),
        hit({ productKey: "b1", ...beef, latestUnitPriceMin: 30, chainId: "rema1000" }),
        hit({ productKey: "p2", ...pork, latestUnitPriceMin: 33, chainId: "rema1000" }),
      ],
      new Set(["netto", "rema1000"]),
    );
    expect(groups.map((g) => [g.label, g.hits.map((h) => h.productKey), g.cheapestNearby])).toEqual(
      [
        ["Hakket grisekød, 8-12%", ["p2", "p1"], true],
        // A single price is not called "cheapest".
        ["Hakket oksekød, 8-12%", ["b1"], false],
      ],
    );
  });
});
