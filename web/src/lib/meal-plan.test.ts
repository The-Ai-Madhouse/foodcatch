import { describe, expect, it } from "vitest";
import { evaluateDeals, type DealRow } from "./deals";
import {
  addDays,
  addPlanDish,
  dayLabel,
  parsePlan,
  planOptions,
  plannedRecipes,
  removePlanDish,
  serializePlan,
  todayInDenmark,
  togglePlanDay,
} from "./meal-plan";
import { priceFinder } from "./pantry";
import { RECIPES } from "./recipes";

const TODAY = "2026-11-20";
const NOW = new Date("2026-11-20T12:00:00Z");
const NEARBY = new Set(["netto", "lidl"]);

describe("dates", () => {
  it("uses the Danish date and labels days", () => {
    expect(todayInDenmark(new Date("2026-11-20T23:30:00Z"))).toBe("2026-11-21");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(dayLabel(TODAY, TODAY)).toBe("I dag 20/11");
    expect(dayLabel("2026-11-21", TODAY)).toBe("I morgen 21/11");
    expect(dayLabel("2026-11-23", TODAY)).toMatch(/^Man\.? 23\/11$/);
  });
});

describe("plan cookie", () => {
  it("round-trips and drops past days, far days and unknown dishes", () => {
    const plan = parsePlan(
      "2026-11-19=chili|2026-11-21=chili.nope.dal|2026-11-22=|2026-12-30=dal|junk",
      TODAY,
    );
    expect(plan).toEqual([
      { date: "2026-11-21", recipes: ["chili", "dal"] },
      { date: "2026-11-22", recipes: [] },
    ]);
    expect(parsePlan(serializePlan(plan), TODAY)).toEqual(plan);
  });

  it("adds and removes days and dishes", () => {
    let plan = togglePlanDay([], "2026-11-22");
    plan = addPlanDish(plan, "2026-11-21", "chili");
    plan = addPlanDish(plan, "2026-11-21", "dal");
    expect(plan.map((d) => d.date)).toEqual(["2026-11-21", "2026-11-22"]);
    expect(plannedRecipes(plan).map((r) => r.id)).toEqual(["chili", "dal"]);
    plan = removePlanDish(plan, "2026-11-21", 0);
    expect(plan[0]?.recipes).toEqual(["dal"]);
    expect(addPlanDish(plan, "2026-11-21", "nope")).toBe(plan);
    expect(togglePlanDay(plan, "2026-11-21").map((d) => d.date)).toEqual(["2026-11-22"]);
  });
});

function row(overrides: Partial<DealRow>): DealRow {
  return {
    listingId: "o",
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
    references: [{ kind: "regular", chain_id: "lidl", unit_price: 89.9, unit: "kg" }],
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

describe("planOptions", () => {
  const chili = RECIPES.find((r) => r.id === "chili")!;
  const tacos = RECIPES.find((r) => r.id === "tacos")!;
  const deals = evaluateDeals([row({ listingId: "mince" })], NEARBY);
  // Lidl's shelf price for the same mince: what a Lidl-only plan pays (lib/pantry.ts).
  const finder = priceFinder([
    {
      key: "lidl-mince",
      label: "Hakket oksekød 8-12%",
      chainId: "lidl",
      classKey: "hakket_oksekød|fedt=8-12%|øko=nej|laktosefri=nej|forarbejdet=nej",
      kind: "regular",
      price: 44.95,
      unit: "kg",
      sizeMin: 0.5,
      sizeMax: 0.5,
      source: "tjek",
      sourceItemId: "l1",
      catalogId: null,
      validTo: null,
      ean: null,
    },
  ]);

  it("recommends the cheapest single store and buys packs for all dishes", () => {
    const options = planOptions([chili, tacos], deals, [], NEARBY, NOW, finder);
    expect(options.recommended).toBe("netto");
    const netto = options.single[0]!;
    const mince = netto.lines.find((l) => l.item);
    // 0,35 kg + 0,4 kg of mince = two 0,5 kg packs.
    expect(mince?.packs).toBe(2);
    expect(mince?.payKr).toBe(70);
    expect(mince?.dishes).toEqual(["Chili con carne", "Tacoskåle med oksekød"]);
    const lidl = options.single.find((s) => s.store.kind === "one" && s.store.chainId === "lidl")!;
    expect(lidl.offerCount).toBe(0);
    expect(netto.total).toBeLessThan(lidl.total);
    // Basics are listed but not counted.
    const basics = netto.lines.filter((l) => l.basic);
    expect(basics.length).toBeGreaterThan(0);
    const counted = netto.lines.filter((l) => !l.basic).reduce((s, l) => s + l.payKr, 0);
    expect(netto.total).toBeCloseTo(counted, 2);
  });

  it("across stores is never dearer than the store it would pick for each item", () => {
    const options = planOptions([chili], deals, [], NEARBY, NOW, finder);
    expect(options.many.chains).toEqual(["netto"]);
    expect(options.many.total).toBe(options.single[0]?.total);
  });
});
