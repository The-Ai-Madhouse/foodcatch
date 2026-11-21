import { describe, expect, it } from "vitest";
import { checklistTotals } from "./checklist";
import { parsePeople, portions } from "./people";

describe("portions", () => {
  it("a dish for 4 lasts 4 days for one person, at a quarter of the price per day", () => {
    expect(portions(4, 1, 80)).toEqual({ days: 4, times: null, perDayKr: 20, freeze: true });
    expect(portions(4, 2, 80)).toEqual({ days: 2, times: null, perDayKr: 40, freeze: false });
    // 6 servings for 4: one day (the rest is a smaller meal), price for four.
    expect(portions(6, 4, 90)).toMatchObject({ days: 1, perDayKr: 60 });
  });

  it("more people than the recipe serves: make it several times", () => {
    expect(portions(2, 5, 50)).toEqual({ days: null, times: 2.5, perDayKr: 125, freeze: false });
    expect(portions(4, 4, 80)).toEqual({ days: null, times: null, perDayKr: 80, freeze: false });
  });

  it("reads the cookie", () => {
    expect(parsePeople("2")).toBe(2);
    expect(parsePeople("0")).toBeNull();
    expect(parsePeople("abc")).toBeNull();
    expect(parsePeople(undefined)).toBeNull();
  });
});

describe("checklistTotals", () => {
  const rows = [
    { key: "a", payKr: 20, portionKr: 10, approx: false },
    { key: "b", payKr: 8, portionKr: 4, approx: true },
    { key: "c", payKr: 1, approx: true },
  ];
  it("removed rows count in neither total; rows at home only in the dish price", () => {
    expect(checklistTotals(rows, new Set(["c"]), new Set())).toEqual({
      toBuy: 2,
      purchaseKr: 28,
      purchaseApprox: true,
      dishKr: 15,
      dishApprox: true,
      removed: 0,
    });
    expect(checklistTotals(rows, new Set(["c"]), new Set(["b"]))).toEqual({
      toBuy: 1,
      purchaseKr: 20,
      purchaseApprox: false,
      dishKr: 11,
      dishApprox: true,
      removed: 1,
    });
  });
});
