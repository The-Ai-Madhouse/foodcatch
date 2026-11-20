import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  filterIdeas,
  parseLiked,
  parseMealFilters,
  serializeLiked,
  toggleLiked,
} from "./meal-filters";
import { mealCatalogue } from "./meals";

const CHAINS = new Set(["netto", "lidl"]);
const NOW = new Date("2026-11-19T12:00:00Z");

describe("parseMealFilters", () => {
  it("reads valid values and drops the rest", () => {
    const f = parseMealFilters(
      {
        maaltid: "frokost",
        tid: "30",
        pris: "15",
        butik: "netto",
        kun: "1",
        sorter: "tid",
        gemte: "1",
      },
      CHAINS,
    );
    expect(f).toEqual({
      meal: "frokost",
      maxMinutes: 30,
      maxPerPerson: 15,
      store: { chainId: "netto", only: true },
      sort: "tid",
      liked: true,
    });
    expect(activeFilterCount(f)).toBe(6);
    const bad = parseMealFilters(
      { maaltid: "morgen", tid: "7", butik: "aldi", sorter: "x" },
      CHAINS,
    );
    expect(bad.meal).toBeNull();
    expect(bad.maxMinutes).toBeNull();
    expect(bad.store.chainId).toBeNull();
    expect(bad.sort).toBe("spar");
    expect(activeFilterCount(bad)).toBe(0);
  });
});

describe("filterIdeas", () => {
  const all = mealCatalogue([], [], CHAINS, NOW);

  it("filters by meal, time and price, and sorts", () => {
    const base = parseMealFilters({}, CHAINS);
    expect(filterIdeas(all, base, new Set())).toHaveLength(all.length);
    const quick = filterIdeas(all, { ...base, maxMinutes: 15, sort: "tid" }, new Set());
    expect(quick.length).toBeGreaterThan(0);
    expect(quick.every((i) => i.recipe.minutes <= 15)).toBe(true);
    expect(quick.map((i) => i.recipe.minutes)).toEqual(
      [...quick.map((i) => i.recipe.minutes)].sort((a, b) => a - b),
    );
    const cheap = filterIdeas(all, { ...base, maxPerPerson: 15, sort: "pris" }, new Set());
    expect(cheap.every((i) => i.costPerServing <= 15)).toBe(true);
    const lunch = filterIdeas(all, { ...base, meal: "frokost" }, new Set());
    expect(lunch.every((i) => i.recipe.meal === "frokost")).toBe(true);
  });

  it("shows only liked dishes when asked", () => {
    const base = parseMealFilters({ gemte: "1" }, CHAINS);
    expect(filterIdeas(all, base, new Set(["chili"])).map((i) => i.recipe.id)).toEqual(["chili"]);
  });
});

describe("liked cookie", () => {
  it("keeps known recipe ids once and toggles", () => {
    expect(parseLiked("chili,nope,chili,dal")).toEqual(["chili", "dal"]);
    expect(parseLiked(undefined)).toEqual([]);
    expect(toggleLiked(["chili"], "dal")).toEqual(["chili", "dal"]);
    expect(toggleLiked(["chili", "dal"], "chili")).toEqual(["dal"]);
    expect(toggleLiked([], "nope")).toEqual([]);
    expect(serializeLiked(["dal", "x"])).toBe("dal");
  });
});
