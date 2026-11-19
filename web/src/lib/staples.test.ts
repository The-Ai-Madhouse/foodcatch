import { describe, expect, it } from "vitest";
import { evaluateDeals, groupByListing, type DealRow } from "./deals";
import type { FoodWasteItem } from "./foodwaste";
import { TYPE_IDS } from "./groups";
import {
  MAX_OFFERS_PER_STAPLE,
  STAPLE_OPTIONS,
  parseStaples,
  serializeStaples,
  stapleMatches,
} from "./staples";

function row(overrides: Partial<DealRow>): DealRow {
  return {
    listingId: "l1",
    variantIndex: 0,
    chainId: "netto",
    chainName: "Netto",
    title: "Frilandsæg 10 stk.",
    description: "",
    price: 25,
    unit: "stk",
    unitPriceMin: 2.5,
    unitPriceMax: 2.5,
    validFrom: "2026-11-16T23:00:00Z",
    validTo: "2026-11-22T22:59:59Z",
    typeId: "æg",
    typeLabel: "Æg",
    groupName: "Æg",
    classKey: "æg|produktion=frilands",
    classLabel: "Æg, frilands",
    isExact: true,
    notes: [],
    priceApplies: true,
    targetUnitPriceWorst: 2.5,
    targetUnitPriceBest: 2.5,
    references: [{ kind: "regular", chain_id: "rema1000", unit_price: 3 }],
    memberOnly: false,
    source: "tjek",
    sourceItemId: null,
    catalogId: null,
    sizeMin: 10,
    sizeMax: 10,
    maxPerCustomer: null,
    productKey: null,
    ...overrides,
  };
}

const NEARBY = new Set(["netto", "rema1000", "lidl"]);
const listings = (rows: DealRow[]) => groupByListing(evaluateDeals(rows, NEARBY));

const waste = (overrides: Partial<FoodWasteItem>) =>
  ({
    listingId: "w1",
    classKey: "æg|x",
    discountPct: 40,
    distanceKm: 1,
    ...overrides,
  }) as FoodWasteItem;

describe("staple selection", () => {
  it("parses known ids in catalogue order without duplicates", () => {
    expect(parseStaples("maelk,aeg,ukendt,aeg")).toEqual(["aeg", "maelk"]);
    expect(parseStaples("")).toEqual([]);
    expect(parseStaples(undefined)).toEqual([]);
  });

  it("serializes only known ids", () => {
    expect(serializeStaples(["havregryn", "x", 3, "aeg"])).toEqual("aeg,havregryn");
  });

  it("only offers staples of the taxonomy", () => {
    for (const o of STAPLE_OPTIONS) for (const t of o.types) expect(TYPE_IDS).toContain(t);
  });
});

describe("stapleMatches", () => {
  it("finds offers and clearances of a chosen staple", () => {
    const [eggs] = stapleMatches(
      ["aeg"],
      listings([row({}), row({ listingId: "l2", typeId: "mælk", unit: "l" })]),
      [waste({}), waste({ listingId: "w2", classKey: "skyr|x" })],
    );
    expect(eggs?.offers.map((l) => l.listingId)).toEqual(["l1"]);
    expect(eggs?.clearances.map((w) => w.listingId)).toEqual(["w1"]);
  });

  it("leaves out offers that are cheaper elsewhere and sorts good deals first", () => {
    const [eggs] = stapleMatches(
      ["aeg"],
      listings([
        row({ listingId: "dear", targetUnitPriceWorst: 4, targetUnitPriceBest: 4 }),
        row({
          listingId: "undecided",
          unitPriceMin: 2,
          targetUnitPriceWorst: 3.5,
          targetUnitPriceBest: 2,
        }),
        row({ listingId: "good" }),
      ]),
      [],
    );
    expect(eggs?.offers.map((l) => l.listingId)).toEqual(["good", "undecided"]);
  });

  it("limits the rows per staple but keeps the counts", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ listingId: `l${i}` }));
    const [eggs] = stapleMatches(["aeg"], listings(rows), []);
    expect(eggs?.offers).toHaveLength(MAX_OFFERS_PER_STAPLE);
    expect(eggs?.offerCount).toBe(5);
  });

  it("keeps a chosen staple with nothing on offer (shown as such)", () => {
    expect(stapleMatches(["havregryn"], [], [])[0]?.offerCount).toBe(0);
  });
});
