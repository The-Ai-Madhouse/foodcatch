import { describe, expect, it } from "vitest";
import { evaluateDeals, type DealRow, type EvaluatedDeal } from "./deals";
import type { FoodWasteItem } from "./foodwaste";
import {
  MAX_IDEAS,
  RECIPES,
  fillRecipe,
  foodWasteItem,
  mealIdeas,
  mealItemsByType,
  normalUnitPrice,
  offerItem,
  typeIdOf,
  type Recipe,
} from "./meals";

const NOW = new Date("2026-11-19T12:00:00Z");
const NEARBY = new Set(["netto", "rema1000", "lidl"]);

function row(overrides: Partial<DealRow> = {}): DealRow {
  return {
    listingId: "offer-1",
    variantIndex: 0,
    chainId: "netto",
    chainName: "Netto",
    title: "Hakket oksekød 8-12%",
    description: "",
    price: 35,
    unit: "kg",
    unitPriceMin: 70,
    unitPriceMax: 70,
    validFrom: "2026-11-16T23:00:00Z",
    validTo: "2026-11-22T22:59:59Z",
    typeId: "hakket_oksekød",
    typeLabel: "Hakket oksekød",
    groupName: "Kød",
    classKey: "hakket_oksekød|fedt=8-12%|øko=nej|laktosefri=nej|forarbejdet=nej",
    classLabel: "Hakket oksekød, 8-12%",
    isExact: true,
    notes: [],
    priceApplies: true,
    targetUnitPriceWorst: 70,
    targetUnitPriceBest: 70,
    references: [{ kind: "regular", chain_id: "rema1000", unit_price: 89.9, unit: "kg" }],
    memberOnly: false,
    source: "tjek",
    sourceItemId: "o1",
    catalogId: "c1",
    sizeMin: 0.5,
    sizeMax: 0.5,
    maxPerCustomer: null,
    productKey: null,
    ...overrides,
  };
}

const deal = (overrides: Partial<DealRow> = {}): EvaluatedDeal =>
  evaluateDeals([row(overrides)], NEARBY)[0] as EvaluatedDeal;

function waste(overrides: Partial<FoodWasteItem> = {}): FoodWasteItem {
  return {
    listingId: "waste-1",
    storeId: "s1",
    chainId: "netto",
    storeName: "Netto Vesterbrogade",
    street: null,
    zip: null,
    city: null,
    lat: 55.67,
    lon: 12.56,
    distanceKm: 0.4,
    title: "FRILANDSÆG 10 STK",
    ean: null,
    price: 18,
    referencePrice: 32.95,
    discountPct: 45.4,
    unit: "stk",
    unitPrice: 1.8,
    validTo: null,
    stock: 4,
    stockUnit: "each",
    typeLabel: "Æg",
    classLabel: "Æg, frilandsæg",
    isExact: true,
    size: 10,
    imageUrl: null,
    productQuantityText: null,
    productNetQuantity: null,
    productNetUnit: null,
    lastSeenAt: null,
    productKey: null,
    sourceItemId: null,
    sallingStoreId: null,
    sourceFetchedAt: null,
    sallingPercentDiscount: null,
    offerEan: null,
    productCode: null,
    classKey: "æg|produktion=frilands|laktosefri=nej|forarbejdet=nej",
    references: [],
    beatsCompetitors: null,
    ...overrides,
  };
}

describe("typeIdOf", () => {
  it("takes the type id from a class key", () => {
    expect(typeIdOf("hakket_oksekød|fedt=8-12%")).toBe("hakket_oksekød");
    expect(typeIdOf("æg")).toBe("æg");
    expect(typeIdOf(null)).toBeNull();
    expect(typeIdOf("")).toBeNull();
  });
});

describe("offer savings", () => {
  it("compares the smallest pack with the cheapest nearby normal price", () => {
    const item = offerItem(deal(), NEARBY, NOW);
    // 89,90 kr./kg × 0,5 kg = 44,95 kr. normal price; offer 35 kr.
    expect(item).toMatchObject({ kind: "offer", normalPrice: 44.95, saving: 9.95 });
  });

  it("uses the smallest pack of a range", () => {
    const item = offerItem(
      deal({ sizeMin: 0.375, sizeMax: 0.5, targetUnitPriceWorst: 93.33, targetUnitPriceBest: 70 }),
      NEARBY,
      NOW,
    );
    // 89,90 × 0,375 = 33,7125 -> 33,71; 35 kr. is more: no saving, and only "undecided".
    expect(item).toBeNull();
  });

  it("ignores offers and normal prices of chains that are not nearby", () => {
    const d = deal({
      references: [
        { kind: "offer", chain_id: "lidl", unit_price: 95 },
        { kind: "regular", chain_id: "meny", unit_price: 60 },
        { kind: "regular", chain_id: "rema1000", unit_price: 89.9 },
      ],
    });
    expect(normalUnitPrice(d, NEARBY)).toBe(89.9);
  });

  it("counts Salling's EAN price wherever the user is", () => {
    const d = deal({ references: [{ kind: "ean_reference", chain_id: "netto", unit_price: 80 }] });
    expect(normalUnitPrice(d, new Set(["netto"]))).toBe(80);
  });

  it("keeps a good deal without a normal price, with an unknown saving", () => {
    const d = deal({ references: [{ kind: "offer", chain_id: "lidl", unit_price: 90 }] });
    expect(d.status).toBe("good_deal");
    expect(offerItem(d, NEARBY, NOW)).toMatchObject({ saving: null, normalPrice: null });
  });

  it("never suggests an offer that is cheaper elsewhere, upcoming or ambiguous", () => {
    const elsewhere = deal({ references: [{ kind: "offer", chain_id: "lidl", unit_price: 50 }] });
    expect(elsewhere.status).toBe("cheaper_elsewhere");
    expect(offerItem(elsewhere, NEARBY, NOW)).toBeNull();
    expect(offerItem(deal({ validFrom: "2026-11-23T23:00:00Z" }), NEARBY, NOW)).toBeNull();
    expect(offerItem(deal({ priceApplies: false }), NEARBY, NOW)).toBeNull();
  });

  it("has no normal price for an inexact variant", () => {
    expect(normalUnitPrice(deal({ isExact: false }), NEARBY)).toBeNull();
  });
});

describe("food-waste savings", () => {
  it("is the price before the markdown minus the clearance price", () => {
    expect(foodWasteItem(waste())).toMatchObject({
      kind: "foodwaste",
      typeId: "æg",
      normalPrice: 32.95,
      saving: 14.95,
    });
  });

  it("is unknown without a higher price before", () => {
    expect(foodWasteItem(waste({ referencePrice: null }))?.saving).toBeNull();
    expect(foodWasteItem(waste({ referencePrice: 10 }))?.saving).toBeNull();
  });

  it("skips clearances without a class", () => {
    expect(foodWasteItem(waste({ classKey: null }))).toBeNull();
  });
});

describe("fillRecipe", () => {
  const recipe: Recipe = {
    id: "test",
    name: "Test",
    description: "",
    slots: [
      { label: "Æg", types: ["æg"], core: true },
      { label: "Tomater", types: ["hakkede_tomater"] },
    ],
    pantry: [],
  };

  it("needs every core slot", () => {
    expect(fillRecipe(recipe, new Map())).toBeNull();
  });

  it("lists unfilled optional slots as missing and sums known savings", () => {
    const byType = mealItemsByType(
      [],
      [waste(), waste({ listingId: "waste-2", price: 20, referencePrice: 40 })],
      NEARBY,
      NOW,
    );
    const idea = fillRecipe(recipe, byType);
    expect(idea?.filled.map((f) => f.item.id)).toEqual(["waste-2"]);
    expect(idea?.missing.map((s) => s.label)).toEqual(["Tomater"]);
    expect(idea?.totalSaving).toBe(20);
    expect(idea?.unknownSavings).toBe(0);
  });

  it("does not use one item for two slots", () => {
    const twice: Recipe = {
      ...recipe,
      slots: [
        { label: "Æg", types: ["æg"], core: true },
        { label: "Flere æg", types: ["æg"], core: true },
      ],
    };
    const byType = mealItemsByType([], [waste()], NEARBY, NOW);
    expect(fillRecipe(twice, byType)).toBeNull();
  });
});

describe("mealIdeas", () => {
  it("combines offers and clearances, best saving first", () => {
    const ideas = mealIdeas(
      [
        deal(),
        deal({
          listingId: "offer-2",
          title: "Hakkede tomater",
          typeId: "hakkede_tomater",
          classKey: "hakkede_tomater|øko=nej|laktosefri=nej|forarbejdet=nej",
          price: 5,
          sizeMin: 0.4,
          sizeMax: 0.4,
          targetUnitPriceWorst: 12.5,
          targetUnitPriceBest: 12.5,
          references: [{ kind: "regular", chain_id: "rema1000", unit_price: 20, unit: "kg" }],
        }),
      ],
      [waste()],
      NEARBY,
      NOW,
    );
    expect(ideas.length).toBeGreaterThanOrEqual(2);
    expect(ideas.length).toBeLessThanOrEqual(MAX_IDEAS);
    for (let i = 1; i < ideas.length; i++) {
      expect(ideas[i - 1]?.totalSaving).toBeGreaterThanOrEqual(ideas[i]?.totalSaving ?? 0);
    }
    const names = ideas.map((i) => i.recipe.name);
    expect(names).toContain("Shakshuka");
    // Shakshuka: eggs from the clearance (14,95) + tomatoes on offer (8 - 5 = 3).
    const shakshuka = ideas.find((i) => i.recipe.id === "shakshuka");
    expect(shakshuka?.totalSaving).toBe(17.95);
    expect(new Set(shakshuka?.filled.map((f) => f.item.kind))).toEqual(
      new Set(["foodwaste", "offer"]),
    );
  });

  it("builds every idea around a different main item", () => {
    const ideas = mealIdeas([deal()], [], NEARBY, NOW);
    // Only one cheap item (minced beef): bolognese, chili and lasagne all hinge on it.
    expect(ideas).toHaveLength(1);
  });

  it("returns nothing when nothing is cheap", () => {
    expect(mealIdeas([], [], NEARBY, NOW)).toEqual([]);
  });

  it("caps the number of ideas", () => {
    const items = [
      waste(),
      waste({ listingId: "w-milk", classKey: "mælk|mælketype=let", referencePrice: 14, price: 7 }),
      waste({ listingId: "w-feta", classKey: "feta|øko=nej", referencePrice: 20, price: 10 }),
      waste({ listingId: "w-tun", classKey: "tun|medium=vand", referencePrice: 15, price: 8 }),
      waste({ listingId: "w-oats", classKey: "havregryn|øko=nej", referencePrice: 12, price: 6 }),
      waste({ listingId: "w-skyr", classKey: "skyr|smag=naturel", referencePrice: 22, price: 12 }),
      waste({
        listingId: "w-linser",
        classKey: "linser|form=tørret",
        referencePrice: 20,
        price: 9,
      }),
    ];
    expect(mealIdeas([], items, NEARBY, NOW)).toHaveLength(MAX_IDEAS);
  });
});

describe("RECIPES", () => {
  it("has unique ids and at least one core slot per dish", () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    for (const r of RECIPES) expect(r.slots.some((s) => s.core)).toBe(true);
  });

  it("only uses type ids of the taxonomy", () => {
    const known = new Set([
      "hakket_gris_kalv",
      "hakket_okse_gris",
      "hakket_oksekød",
      "hakket_grisekød",
      "hakket_kylling",
      "hakket_kalkun",
      "kyllingeinderfilet",
      "kyllingebryst",
      "kyllingelår",
      "hel_kylling",
      "svinekoteletter",
      "svinemørbrad",
      "æg",
      "kærnemælk",
      "mælk",
      "piskefløde",
      "madlavningsfløde",
      "creme_fraiche",
      "smørbar",
      "smør",
      "hytteost",
      "mozzarella",
      "feta",
      "fast_ost",
      "skyr",
      "græsk_yoghurt",
      "a38_ymer",
      "yoghurt",
      "hakkede_tomater",
      "flåede_tomater",
      "passata",
      "tomatpuré",
      "kikærter",
      "kidneybønner",
      "sorte_bønner",
      "hvide_bønner",
      "linser",
      "tun",
      "havregryn",
    ]);
    for (const r of RECIPES) {
      for (const s of r.slots) for (const t of s.types) expect(known, `${r.id}: ${t}`).toContain(t);
    }
  });
});
