import { describe, expect, it } from "vitest";
import {
  type ProductHistoryRow,
  buildProductChart,
  chartSummary,
  newestFirst,
  parseMeasure,
  productKindLabel,
  productUnit,
  rowValue,
  shortHistoryNote,
  stepPath,
} from "./product";

const NOW = new Date("2026-11-19T12:00:00Z");

function row(overrides: Partial<ProductHistoryRow> = {}): ProductHistoryRow {
  return {
    productKey: "ean:5701234000011",
    productLabel: "Hakket oksekød 8-12%",
    chainId: "netto",
    kind: "offer",
    price: 40,
    unit: "kg",
    unitPriceMin: 80,
    unitPriceMax: 80,
    sizeMin: 0.5,
    sizeMax: 0.5,
    validFrom: "2026-11-14T23:00:00Z",
    validTo: "2026-11-20T22:59:59Z",
    source: "tjek",
    sourceItemId: "abc",
    catalogId: "cat",
    storeId: null,
    memberOnly: false,
    listingId: "00000000-0000-0000-0000-000000000001",
    title: "Hakket oksekød 8-12%",
    ...overrides,
  };
}

const reference = (from: string, to: string | null, price: number, chainId = "netto") =>
  row({
    kind: "reference",
    chainId,
    price,
    unit: null,
    unitPriceMin: null,
    unitPriceMax: null,
    sizeMin: null,
    sizeMax: null,
    validFrom: from,
    validTo: to,
    source: "salling_food_waste",
    sourceItemId: null,
    listingId: null,
  });

describe("measure and values", () => {
  it("plots the pack price by default and the unit price only when asked and available", () => {
    expect(parseMeasure(undefined, true)).toBe("pakke");
    expect(parseMeasure("enhed", true)).toBe("enhed");
    expect(parseMeasure("enhed", false)).toBe("pakke");
  });

  it("finds the dominant unit and the plotted value of a row", () => {
    expect(productUnit([row(), row({ unit: "l" }), row()])).toBe("kg");
    expect(productUnit([reference("2026-10-01T00:00:00Z", null, 40)])).toBeNull();
    expect(rowValue(row(), "pakke", "kg")).toEqual({ low: 40, high: 40 });
    expect(rowValue(row({ unitPriceMin: 70, unitPriceMax: 90 }), "enhed", "kg")).toEqual({
      low: 70,
      high: 90,
    });
    expect(rowValue(row({ unit: "l" }), "enhed", "kg")).toBeNull();
    // A Salling normal price has a pack price only.
    expect(rowValue(reference("2026-10-01T00:00:00Z", null, 40), "enhed", "kg")).toBeNull();
  });

  it("labels kinds in Danish", () => {
    expect(productKindLabel("reference")).toBe("Normalpris ifølge Salling");
    expect(productKindLabel("clearance")).toBe("Madspild");
    expect(productKindLabel("other")).toBe("other");
  });
});

describe("buildProductChart", () => {
  const rows = [
    reference("2026-07-22T00:00:00Z", "2026-10-09T00:00:00Z", 42.95),
    reference("2026-10-10T00:00:00Z", "2026-11-19T00:00:00Z", 44.95),
    reference("2026-10-20T00:00:00Z", "2026-11-17T00:00:00Z", 46.95, "foetex"),
    row(),
    row({
      kind: "clearance",
      price: 24,
      unitPriceMin: 48,
      unitPriceMax: 48,
      validFrom: "2026-11-19T06:00:00Z",
      validTo: "2026-11-19T22:59:00Z",
      source: "salling_food_waste",
    }),
  ];

  it("draws shelf prices as steps per chain, offers as segments and clearances as points", () => {
    const model = buildProductChart(rows, NOW);
    expect(model.steps.map((s) => s.key)).toEqual(["reference|netto", "reference|foetex"]);
    expect(model.steps[0]?.marks.map((m) => m.high)).toEqual([42.95, 44.95]);
    expect(model.segments).toHaveLength(1);
    expect(model.points.map((p) => p.high)).toEqual([24]);
    expect(model.chains).toEqual(["netto", "foetex"]);
    expect(model.kinds).toEqual(["reference", "offer", "clearance"]);
    expect(model.charted).toBe(5);
    expect(model.excluded).toBe(0);
    expect(model.yDomain[0]).toBeLessThanOrEqual(24);
    expect(model.yDomain[1]).toBeGreaterThanOrEqual(46.95);
    expect(model.xDomain[1]).toBeGreaterThanOrEqual(NOW.getTime());
  });

  it("in unit prices leaves out rows without one", () => {
    const model = buildProductChart(rows, NOW, { measure: "enhed" });
    expect(model.unit).toBe("kg");
    expect(model.steps).toHaveLength(0);
    expect(model.charted).toBe(2);
    expect(model.excluded).toBe(3);
  });

  it("shows the last year unless everything is asked for", () => {
    const old = row({
      kind: "regular",
      source: "rema",
      validFrom: "2019-03-01T00:00:00Z",
      validTo: "2020-03-01T00:00:00Z",
    });
    const recent = row({
      kind: "regular",
      source: "rema",
      validFrom: "2020-03-01T00:00:00Z",
      validTo: null,
    });
    const model = buildProductChart([old, recent], NOW);
    expect(model.charted).toBe(1);
    expect(model.olderFrom).toBe("2019-03-01T00:00:00.000Z");
    expect(model.steps[0]?.marks[0]?.openEnded).toBe(true);
    const all = buildProductChart([old, recent], NOW, { all: true });
    expect(all.charted).toBe(2);
    expect(all.olderFrom).toBeNull();
  });

  it("has sane domains without any charted row", () => {
    const model = buildProductChart([], NOW);
    expect(model.charted).toBe(0);
    expect(model.yDomain[1]).toBeGreaterThan(model.yDomain[0]);
    expect(chartSummary(model, "Mælk")).toBe("Mælk: ingen priser at vise i grafen.");
  });

  it("summarises the chart for screen readers", () => {
    const summary = chartSummary(buildProductChart(rows, NOW), "Hakket oksekød");
    expect(summary).toContain("pakkepris over tid fra Netto, føtex");
    expect(summary).toContain("mellem 24,00 og 46,95 kr.");
  });
});

describe("stepPath", () => {
  const x = (t: number) => t / 86_400_000;
  const y = (v: number) => 100 - v;
  const day = (d: number) => d * 86_400_000;

  it("joins consecutive prices with a vertical step and leaves gaps open", () => {
    const path = stepPath(
      [
        { start: day(0), end: day(10), high: 40 },
        { start: day(11), end: day(20), high: 45 },
        { start: day(40), end: day(50), high: 42 },
      ],
      x,
      y,
    );
    expect(path).toBe("M0.0,60.0 L10.0,60.0 L11.0,55.0 L20.0,55.0 M40.0,58.0 L50.0,58.0");
  });
});

describe("shortHistoryNote", () => {
  it("says since when history is collected, except for REMA 1000 products", () => {
    const recent = [row()];
    expect(shortHistoryNote("ean:5701234000011", recent, NOW)).toBe(
      "Historik indsamles fra 18. nov. 2026",
    );
    expect(shortHistoryNote("ean:5701234000011", [], NOW)).toBe(
      "Historik indsamles fra 18. nov. 2026",
    );
    expect(shortHistoryNote("rema:400554", recent, NOW)).toBeNull();
    const long = [
      row({ validFrom: "2026-05-01T00:00:00Z" }),
      row({ validFrom: "2026-08-01T00:00:00Z" }),
      row(),
    ];
    expect(shortHistoryNote("offer:lidl:skyr", long, NOW)).toBeNull();
  });
});

describe("newestFirst", () => {
  it("orders the table newest first", () => {
    const a = row({ validFrom: "2026-01-01T00:00:00Z" });
    const b = row({ validFrom: "2026-06-01T00:00:00Z" });
    expect(newestFirst([a, b])).toEqual([b, a]);
  });
});
