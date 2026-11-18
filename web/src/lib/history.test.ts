import { describe, expect, it } from "vitest";
import {
  MAX_WINDOW_DAYS,
  type PriceHistoryRow,
  buildPriceChart,
  dominantUnit,
  linearScale,
  niceTicks,
  seriesOf,
  timeTicks,
} from "./history";

const NOW = new Date("2026-11-18T12:00:00Z");

function row(overrides: Partial<PriceHistoryRow> = {}): PriceHistoryRow {
  return {
    classKey: "hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej",
    classLabel: "Hakket grisekød, 8-12%",
    kind: "offer",
    chainId: "netto",
    chainName: "Netto",
    listingId: "1",
    title: "Hakket grisekød 8-12%",
    unit: "kg",
    unitPriceMin: 33.33,
    unitPriceMax: 33.33,
    validFrom: "2026-11-15T23:00:00Z",
    validTo: "2026-11-22T22:59:59Z",
    priceApplies: true,
    memberOnly: false,
    source: "tjek",
    sourceItemId: null,
    catalogId: null,
    storeId: null,
    price: null,
    description: null,
    sizeMin: null,
    sizeMax: null,
    ...overrides,
  };
}

describe("seriesOf", () => {
  it("splits Netto offers, other offers and shelf prices; skips clearances", () => {
    expect(seriesOf({ kind: "offer", chainId: "netto" })).toBe("netto_offer");
    expect(seriesOf({ kind: "offer", chainId: "lidl" })).toBe("other_offer");
    expect(seriesOf({ kind: "regular", chainId: "rema1000" })).toBe("regular");
    expect(seriesOf({ kind: "clearance", chainId: "netto" })).toBeNull();
  });
});

describe("dominantUnit", () => {
  it("picks the most common unit among priced rows", () => {
    expect(dominantUnit([row(), row({ unit: "stk" }), row({ unit: "stk" })])).toBe("stk");
    expect(dominantUnit([row({ unit: "l", unitPriceMin: null, unitPriceMax: null }), row()])).toBe(
      "kg",
    );
    expect(dominantUnit([])).toBeNull();
  });

  it("breaks ties in the order kg, l, stk", () => {
    expect(dominantUnit([row({ unit: "stk" }), row({ unit: "kg" })])).toBe("kg");
  });
});

describe("niceTicks", () => {
  it("covers the range with round steps", () => {
    expect(niceTicks(33.33, 49.9)).toEqual([30, 35, 40, 45, 50]);
    expect(niceTicks(2.5, 2.95)).toEqual([2.4, 2.6, 2.8, 3]);
  });

  it("pads a single value", () => {
    const ticks = niceTicks(10, 10);
    expect(ticks[0]).toBeLessThan(10);
    expect(ticks.at(-1)).toBeGreaterThan(10);
  });

  it("returns nothing for non-finite input", () => {
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
  });
});

describe("timeTicks", () => {
  it("uses Copenhagen Mondays for short spans", () => {
    const ticks = timeTicks(Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-11-20T00:00:00Z"));
    expect(ticks.map((t) => t.label)).toEqual(["2. nov.", "9. nov.", "16. nov."]);
  });

  it("uses month starts for long spans and marks January with the year", () => {
    const ticks = timeTicks(Date.parse("2026-10-10T00:00:00Z"), Date.parse("2027-03-02T00:00:00Z"));
    expect(ticks.map((t) => t.label)).toEqual(["nov.", "dec.", "jan. 2027", "feb.", "mar."]);
  });
});

describe("buildPriceChart", () => {
  it("builds marks, domains and present series", () => {
    const model = buildPriceChart(
      [
        row(),
        row({
          listingId: "2",
          kind: "regular",
          chainId: "rema1000",
          chainName: "REMA 1000",
          unitPriceMin: 49.9,
          unitPriceMax: 49.9,
          validFrom: "2026-08-20T22:00:00Z",
          validTo: null,
        }),
        row({ listingId: "3", kind: "clearance" }),
        row({ listingId: "4", unit: "stk" }),
      ],
      NOW,
    );
    expect(model.unit).toBe("kg");
    expect(model.marks).toHaveLength(2);
    expect(model.excluded).toBe(2);
    expect(model.series.map((s) => s.key)).toEqual(["netto_offer", "regular"]);
    expect(model.yDomain).toEqual([30, 50]);
    const regular = model.marks.find((m) => m.series === "regular");
    expect(regular?.openEnded).toBe(true);
    expect(regular?.end).toBe(NOW.getTime());
    expect(model.xDomain[0]).toBe(Date.parse("2026-08-20T22:00:00Z"));
    expect(model.xDomain[1]).toBe(Date.parse("2026-11-22T22:59:59Z"));
  });

  it("drops rows older than the window and clips long ones", () => {
    const old = row({ validFrom: "2024-01-01T00:00:00Z", validTo: "2024-01-07T00:00:00Z" });
    const long = row({ listingId: "9", validFrom: "2024-01-01T00:00:00Z", validTo: null });
    const model = buildPriceChart([old, long], NOW);
    expect(model.marks).toHaveLength(1);
    expect(model.marks[0]?.start).toBe(NOW.getTime() - MAX_WINDOW_DAYS * 86_400_000);
  });

  it("leaves out offers whose price covers other products", () => {
    // regression: "hel kylling eller hakket kyllingekød" must not chart as the mince's price
    const model = buildPriceChart(
      [
        row({ listingId: "1" }),
        row({ listingId: "2", unitPriceMin: 20, unitPriceMax: 61.25, priceApplies: false }),
      ],
      NOW,
    );
    expect(model.marks.map((m) => m.row.listingId)).toEqual(["1"]);
    expect(model.excluded).toBe(1);
    expect(model.yDomain[0]).toBeGreaterThan(20);
  });

  it("handles a class without chartable rows", () => {
    const model = buildPriceChart([row({ kind: "clearance" })], NOW);
    expect(model.marks).toEqual([]);
    expect(model.series).toEqual([]);
    expect(model.excluded).toBe(1);
  });
});

describe("linearScale", () => {
  it("maps domain to range, including inverted ranges", () => {
    const y = linearScale([0, 100], [300, 0]);
    expect(y(0)).toBe(300);
    expect(y(50)).toBe(150);
    expect(linearScale([5, 5], [0, 10])(5)).toBe(0);
  });
});
