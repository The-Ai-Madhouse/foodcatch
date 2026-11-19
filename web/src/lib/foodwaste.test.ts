import { describe, expect, it } from "vitest";
import {
  competitorBadge,
  foodWastePackSize,
  foodWasteUnitPrice,
  latestSeen,
  shownDiscount,
  sortedReferences,
  type FoodWasteItem,
} from "./foodwaste";

function item(overrides: Partial<FoodWasteItem> = {}): FoodWasteItem {
  return {
    listingId: "1",
    storeId: "s",
    chainId: "netto",
    storeName: "Netto Rådhuspladsen",
    street: null,
    zip: null,
    city: null,
    lat: 55.676,
    lon: 12.568,
    distanceKm: 0.08,
    title: "FRAICHE 5% 250G CHEASY",
    ean: "5701234567890",
    price: 9,
    referencePrice: 18,
    discountPct: 50,
    unit: "kg",
    unitPrice: 36,
    validTo: "2026-11-18T22:59:59Z",
    stock: 1,
    stockUnit: "each",
    typeLabel: "Fraiche",
    classLabel: "Fraiche, 5%",
    isExact: true,
    size: 0.25,
    imageUrl: null,
    productQuantityText: null,
    productNetQuantity: null,
    productNetUnit: null,
    lastSeenAt: "2026-11-18T12:37:00Z",
    productKey: "ean:5701234000011",
    sourceItemId: "store-1:2900000000001",
    sallingStoreId: "store-1",
    sourceFetchedAt: "2026-11-18T12:37:00Z",
    sallingPercentDiscount: 80,
    offerEan: "2900000000001",
    productCode: "5701234000011",
    classKey: "hakket_oksekød|fedt=8-12%",
    references: [],
    beatsCompetitors: null,
    ...overrides,
  };
}

describe("food-waste sizes and unit prices", () => {
  it("shows the unit price only when the size comes from the Salling name", () => {
    expect(foodWastePackSize(item()).origin).toBe("source");
    expect(foodWasteUnitPrice(item())).toBe(36);
    const off = item({ size: null, unit: null, productNetQuantity: 1, productNetUnit: "kg" });
    expect(foodWastePackSize(off).text.replace(/ /g, " ")).toBe("1 kg ifølge Open Food Facts");
    expect(foodWasteUnitPrice({ ...off, unitPrice: 12 })).toBeNull();
    expect(foodWastePackSize(item({ size: null, unit: null, stockUnit: "kg" })).text).toBe(
      "Vægt varierer",
    );
  });

  it("rounds the discount and hides tiny ones", () => {
    expect(shownDiscount(79.6)).toBe(80);
    expect(shownDiscount(0.4)).toBeNull();
    expect(shownDiscount(null)).toBeNull();
  });

  it("finds the latest stock snapshot", () => {
    expect(
      latestSeen([
        item(),
        item({ lastSeenAt: "2026-11-18T13:00:00Z" }),
        item({ lastSeenAt: null }),
      ]),
    ).toBe("2026-11-18T13:00:00.000Z");
    expect(latestSeen([])).toBeNull();
  });
});

describe("competitorBadge", () => {
  const rema = { kind: "regular" as const, chain_id: "rema1000", unit_price: 89.9 };
  const lidl = { kind: "offer" as const, chain_id: "lidl", unit_price: 79 };

  it("names one chain and kind, or says it is the cheapest of several chains", () => {
    expect(competitorBadge(item({ beatsCompetitors: true, references: [rema] }))).toBe(
      "Billigere end REMA 1000s normalpris",
    );
    expect(competitorBadge(item({ beatsCompetitors: true, references: [lidl] }))).toBe(
      "Billigere end Lidls tilbud",
    );
    expect(
      competitorBadge(
        item({ beatsCompetitors: true, references: [rema, { ...rema, kind: "offer" }] }),
      ),
    ).toBe("Billigere end REMA 1000");
    expect(competitorBadge(item({ beatsCompetitors: true, references: [rema, lidl] }))).toBe(
      "Billigst blandt kæderne",
    );
  });

  it("shows nothing when it is not cheaper or cannot be judged", () => {
    expect(competitorBadge(item({ beatsCompetitors: false, references: [rema] }))).toBeNull();
    expect(competitorBadge(item({ beatsCompetitors: null, references: [] }))).toBeNull();
    expect(competitorBadge(item({ beatsCompetitors: true, references: [] }))).toBeNull();
  });

  it("sorts references cheapest first", () => {
    expect(sortedReferences(item({ references: [rema, lidl] })).map((r) => r.chain_id)).toEqual([
      "lidl",
      "rema1000",
    ]);
  });
});
