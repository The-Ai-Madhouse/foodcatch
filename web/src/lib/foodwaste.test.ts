import { describe, expect, it } from "vitest";
import {
  foodWastePackSize,
  foodWasteUnitPrice,
  latestSeen,
  shownDiscount,
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
