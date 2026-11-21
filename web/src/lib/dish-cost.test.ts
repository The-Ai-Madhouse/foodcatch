import { describe, expect, it } from "vitest";
import { dishCost } from "./dish-cost";
import { fillRecipe } from "./meals";
import { planShopping } from "./meal-plan";
import { priceFinder, type BuyableProduct } from "./pantry";
import type { Recipe } from "./recipes";

const recipe: Recipe = {
  id: "test",
  name: "Testret",
  meal: "aftensmad",
  servings: 4,
  minutes: 30,
  description: "",
  slots: [
    { label: "Hakket oksekød", types: ["hakket_oksekød"], amount: 0.5, unit: "kg", estimateKr: 35 },
  ],
  pantry: [
    { name: "kartofler", amount: "1 kg", estimateKr: 10 },
    { name: "olie", amount: "2 spsk.", estimateKr: 1, basic: true },
  ],
  steps: [],
};

function product(overrides: Partial<BuyableProduct>): BuyableProduct {
  return {
    key: "k",
    label: "X",
    chainId: "rema1000",
    classKey: null,
    kind: "regular",
    price: 10,
    unit: "kg",
    sizeMin: 1,
    sizeMax: 1,
    source: "rema",
    sourceItemId: "1",
    catalogId: null,
    validTo: null,
    ean: null,
    ...overrides,
  };
}

const finder = priceFinder([
  product({ key: "potatoes", label: "Kartofler", price: 16, sizeMin: 2, sizeMax: 2 }),
  product({
    key: "beef",
    label: "Hakket oksekød 8-12%",
    classKey: "hakket_oksekød|fedt=8-12%",
    price: 40,
    sizeMin: 0.5,
    sizeMax: 0.5,
  }),
]);

describe("dishCost", () => {
  it("prices every item from real products: whole packs to buy, used amounts for the dish", () => {
    const idea = fillRecipe(recipe, new Map(), { chainId: null, only: false })!;
    const cost = dishCost(idea, finder, () => "500 g");
    const potatoes = cost.lines.find((l) => l.label === "Kartofler")!;
    // A 2 kg bag for 16 kr.; the dish uses 1 kg of it: 8 kr.
    expect(potatoes).toMatchObject({ purchaseKr: 16, portionKr: 8, estimate: false });
    expect(cost.lines.find((l) => l.label === "Hakket oksekød")).toMatchObject({
      purchaseKr: 40,
      estimate: false,
    });
    // Purchase: beef + potatoes (the oil is a basic, expected at home).
    expect(cost.purchaseKr).toBe(56);
    expect(cost.purchaseApprox).toBe(false);
    // Dish: 40 + 8 + the oil's estimate (no oil product): approximate.
    expect(cost.dishKr).toBe(49);
    expect(cost.dishApprox).toBe(true);
    expect(cost.perServingKr).toBe(12.25);
  });

  it("falls back to the recipe's estimate and says so", () => {
    const idea = fillRecipe(recipe, new Map(), { chainId: null, only: false })!;
    const cost = dishCost(idea, undefined, () => "");
    expect(cost.purchaseKr).toBe(45);
    expect(cost.purchaseApprox).toBe(true);
    expect(cost.realCount).toBe(0);
  });
});

describe("planShopping with real prices", () => {
  it("adds up the amounts of several dishes before buying packs, per store", () => {
    const many = planShopping([recipe, recipe], new Map(), { kind: "many" }, finder);
    const potatoes = many.lines.find((l) => l.key === "pantry:kartofler")!;
    // 2 × 1 kg: one 2 kg bag covers both dishes.
    expect(potatoes).toMatchObject({ payKr: 16, portionKr: 16, approx: false });
    // In a store without potatoes on the shelf, the estimate stays (and says so).
    const netto = planShopping([recipe], new Map(), { kind: "one", chainId: "netto" }, finder);
    expect(netto.lines.find((l) => l.key === "pantry:kartofler")).toMatchObject({ approx: true });
  });
});
