import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type DealInput, type VerdictResult, referenceCounts, toOre, verdict } from "./verdict";

interface VerdictCase {
  name: string;
  deal: DealInput;
  nearby_chains: string[];
  member_price_marked?: boolean;
  expected: VerdictResult;
}

// Shared with the pipeline (pipeline/src/foodcatch/deals/verdict.py): repo-root fixtures/.
const fixtureUrl = new URL("../../../fixtures/verdict_cases.json", import.meta.url);
const { cases } = JSON.parse(readFileSync(fixtureUrl, "utf8")) as { cases: VerdictCase[] };

describe("verdict (shared fixtures)", () => {
  it("loads the shared cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const options = { memberPriceMarked: c.member_price_marked ?? false };
    expect(verdict(c.deal, c.nearby_chains, options)).toEqual(c.expected);
  });
});

describe("verdict", () => {
  const base: DealInput = {
    netto_unit_price_worst: 40,
    netto_unit_price_best: 30,
    price_applies: true,
    is_exact: true,
    references: [],
  };

  it("accepts a Set of nearby chains", () => {
    const deal = { ...base, references: [{ kind: "offer", chain_id: "lidl", unit_price: 50 }] };
    expect(verdict(deal as DealInput, new Set(["lidl"])).verdict).toBe("good_deal");
  });

  it("treats a missing best price as the worst price", () => {
    const deal: DealInput = {
      ...base,
      netto_unit_price_best: null,
      references: [{ kind: "history", chain_id: "netto", unit_price: 35 }],
    };
    expect(verdict(deal, []).verdict).toBe("cheaper_elsewhere");
  });

  it("checks rules in order: no price wins over ambiguity and inexactness", () => {
    const deal: DealInput = {
      ...base,
      netto_unit_price_worst: null,
      price_applies: false,
      is_exact: false,
    };
    expect(verdict(deal, []).verdict).toBe("no_price");
    expect(verdict({ ...base, price_applies: false, is_exact: false }, []).verdict).toBe(
      "ambiguous_offer",
    );
  });
});

describe("referenceCounts", () => {
  it("counts nearby chains and location-independent kinds only", () => {
    const nearby = new Set(["rema1000"]);
    expect(referenceCounts({ kind: "offer", chain_id: "rema1000", unit_price: 1 }, nearby)).toBe(
      true,
    );
    expect(referenceCounts({ kind: "regular", chain_id: "lidl", unit_price: 1 }, nearby)).toBe(
      false,
    );
    expect(referenceCounts({ kind: "history", chain_id: "netto", unit_price: 1 }, nearby)).toBe(
      true,
    );
    expect(
      referenceCounts({ kind: "ean_reference", chain_id: "foetex", unit_price: 1 }, nearby),
    ).toBe(true);
  });
});

describe("toOre", () => {
  it("rounds to whole øre, half up, like the pipeline", () => {
    const cases: [number, number][] = [
      [33.3333, 3333],
      [33.335, 3334],
      [33.3349, 3333],
      [0.005, 1],
      [49.9, 4990],
      [87.5, 8750],
    ];
    for (const [value, ore] of cases) expect(toOre(value)).toBe(ore);
  });
});
