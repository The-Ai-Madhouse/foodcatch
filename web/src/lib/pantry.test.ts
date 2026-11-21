import { describe, expect, it } from "vitest";
import {
  PANTRY_SPECS,
  type BuyableProduct,
  matchesSpec,
  packText,
  parseAmount,
  priceFinder,
  priceFor,
} from "./pantry";

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

const spec = (name: string) => PANTRY_SPECS[name]!;

describe("matchesSpec", () => {
  it("finds rice, but not rice flour, rice pudding or Paris", () => {
    for (const ok of ["Jasminris", "Basmati ris 1 kg", "Ris, langkornet", "Parboiled ris"]) {
      expect(matchesSpec(ok, spec("ris")), ok).toBe(true);
    }
    for (const no of [
      "Rismel",
      "Risengrød",
      "Riskiks",
      "Paris-toast",
      "Ris à la mande",
      "Risotto ris",
    ]) {
      expect(matchesSpec(no, spec("ris")), no).toBe(false);
    }
  });

  it("finds potatoes, but not mash, chips or sweet potatoes", () => {
    expect(matchesSpec("Bagekartofler", spec("kartofler"))).toBe(true);
    expect(matchesSpec("Kartofler, faste 2 kg", spec("kartofler"))).toBe(true);
    for (const no of ["Kartoffelmos", "Kartoffelchips", "Søde kartofler", "Kartoffelbåde"]) {
      expect(matchesSpec(no, spec("kartofler")), no).toBe(false);
    }
  });

  it("keeps onions apart from red onions and garlic, and finds lasagne sheets", () => {
    expect(matchesSpec("Løg gule 1 kg", spec("løg"))).toBe(true);
    expect(matchesSpec("Rødløg", spec("løg"))).toBe(false);
    expect(matchesSpec("Hvidløg 3 stk.", spec("løg"))).toBe(false);
    expect(matchesSpec("Lasagneplader 500 g", spec("lasagneplader"))).toBe(true);
    expect(matchesSpec("Lasagne bolognese", spec("lasagneplader"))).toBe(false);
    expect(matchesSpec("Basilikum i potte", spec("basilikum"))).toBe(true);
    expect(matchesSpec("Pesto basilikum", spec("basilikum"))).toBe(false);
  });
});

describe("parseAmount", () => {
  it("reads recipe amounts into kg, l or pieces", () => {
    expect(parseAmount("300 g")).toEqual({ amount: 0.3, unit: "kg" });
    expect(parseAmount("1 kg")).toEqual({ amount: 1, unit: "kg" });
    expect(parseAmount("1/2 stk.")).toEqual({ amount: 0.5, unit: "stk" });
    expect(parseAmount("4 skiver")).toEqual({ amount: 4, unit: "stk" });
    expect(parseAmount("1 potte")).toEqual({ amount: 1, unit: "stk" });
    expect(parseAmount("2 spsk.", { words: [], spoon: 0.015 })?.amount).toBeCloseTo(0.03);
    expect(parseAmount("efter smag")).toBeNull();
  });
});

describe("priceFor", () => {
  it("buys the packs that cover the amount and prices the portion", () => {
    // 300 g rice from a 1 kg bag at 12 kr.: buy 12 kr., the portion costs 3,60 kr.
    expect(priceFor(product({ price: 12 }), { amount: 0.3, unit: "kg" })).toMatchObject({
      packs: 1,
      purchaseKr: 12,
      portionKr: 3.6,
    });
    // 1 kg from 500 g packs: two packs.
    expect(
      priceFor(product({ price: 8, sizeMin: 0.5, sizeMax: 0.5 }), { amount: 1, unit: "kg" }),
    ).toMatchObject({ packs: 2, purchaseKr: 16, portionKr: 16 });
    // Pieces to kg through the piece weight (4 slices of 50 g from a 1 kg bread).
    expect(
      priceFor(product({ price: 20 }), { amount: 4, unit: "stk" }, { words: [], pieceKg: 0.05 }),
    ).toMatchObject({ packs: 1, purchaseKr: 20, portionKr: 4 });
  });

  it("will not compare without a size or across units it cannot convert", () => {
    expect(
      priceFor(product({ sizeMin: null, sizeMax: null }), { amount: 1, unit: "kg" }),
    ).toBeNull();
    expect(
      priceFor(product({ unit: "stk", sizeMin: null, sizeMax: null }), { amount: 1, unit: "kg" }),
    ).toBeNull();
    // A potted basil priced per piece without a size is one piece.
    expect(
      priceFor(product({ unit: "stk", sizeMin: null, sizeMax: null, price: 15 }), {
        amount: 1,
        unit: "stk",
      }),
    ).toMatchObject({ purchaseKr: 15, portionKr: 15 });
  });
});

describe("priceFinder", () => {
  it("picks the cheapest purchase for a pantry item and a slot", () => {
    const finder = priceFinder([
      product({ key: "a", label: "Kartofler 2 kg", price: 18, sizeMin: 2, sizeMax: 2 }),
      product({
        key: "b",
        label: "Bagekartofler 1 kg",
        price: 12,
        chainId: "netto",
        kind: "offer",
      }),
      product({ key: "c", label: "Kartoffelmos", price: 5 }),
      product({
        key: "d",
        label: "Hakket oksekød 8-12% 500 g",
        classKey: "hakket_oksekød|fedt=8-12%",
        price: 40,
        sizeMin: 0.5,
        sizeMax: 0.5,
      }),
    ]);
    const potatoes = finder.pantry({ name: "kartofler", amount: "1 kg", estimateKr: 10 });
    expect(potatoes?.product.key).toBe("b");
    expect(potatoes && packText(potatoes)).toBe("1 kg");
    const beef = finder.slot({
      label: "Hakket oksekød",
      types: ["hakket_oksekød"],
      amount: 0.5,
      unit: "kg",
      estimateKr: 35,
    });
    expect(beef).toMatchObject({ purchaseKr: 40, portionKr: 40 });
    expect(finder.pantry({ name: "krydderier", amount: "efter smag", estimateKr: 2 })).toBeNull();
  });
});
