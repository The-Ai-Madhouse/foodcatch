/**
 * The filters of the "Madideer" catalogue (docs/ui.md §19), read from the URL so every view is
 * a link, and the cookie of liked dishes. Pure and unit tested.
 */

import type { Meal, MealIdea, StoreChoice } from "./meals";
import { RECIPES } from "./recipes";

export type MealSort = "spar" | "pris" | "tid";

export interface MealFilters {
  meal: Meal | null;
  /** Longest total time (minutes), or null for any. */
  maxMinutes: number | null;
  /** Highest estimated price per person (kr.), or null for any. */
  maxPerPerson: number | null;
  store: StoreChoice;
  sort: MealSort;
  /** Only liked dishes. */
  liked: boolean;
}

export const TIME_CHOICES = [15, 30, 45, 60] as const;
export const PRICE_CHOICES = [10, 15, 20, 30] as const;

export const SORT_LABELS: Record<MealSort, string> = {
  spar: "Mest sparet",
  pris: "Billigst pr. person",
  tid: "Hurtigst",
};

type Param = string | string[] | undefined;
const one = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v);

function choice(v: Param, allowed: readonly number[]): number | null {
  const n = Number(one(v));
  return allowed.includes(n) ? n : null;
}

export function parseMealFilters(
  params: Record<string, Param>,
  chains: ReadonlySet<string>,
): MealFilters {
  const meal = one(params.maaltid);
  const chain = one(params.butik);
  const sort = one(params.sorter);
  return {
    meal: meal === "frokost" || meal === "aftensmad" ? meal : null,
    maxMinutes: choice(params.tid, TIME_CHOICES),
    maxPerPerson: choice(params.pris, PRICE_CHOICES),
    store: {
      chainId: chain && chains.has(chain) ? chain : null,
      only: one(params.kun) === "1",
    },
    sort: sort === "pris" || sort === "tid" ? sort : "spar",
    liked: one(params.gemte) === "1",
  };
}

/** How many filters differ from the defaults (shown on the "Filtre" button). */
export function activeFilterCount(f: MealFilters): number {
  return [
    f.meal,
    f.maxMinutes,
    f.maxPerPerson,
    f.store.chainId,
    f.store.only || null,
    f.liked || null,
  ].filter((v) => v != null).length;
}

/** The ideas that pass the filters, sorted. */
export function filterIdeas(
  ideas: readonly MealIdea[],
  f: MealFilters,
  liked: ReadonlySet<string>,
): MealIdea[] {
  const byName = (a: MealIdea, b: MealIdea) => a.recipe.name.localeCompare(b.recipe.name, "da-DK");
  const compare: Record<MealSort, (a: MealIdea, b: MealIdea) => number> = {
    spar: (a, b) =>
      b.totalSaving - a.totalSaving ||
      b.filled.length - a.filled.length ||
      a.costPerServing - b.costPerServing ||
      byName(a, b),
    pris: (a, b) =>
      a.costPerServing - b.costPerServing || b.totalSaving - a.totalSaving || byName(a, b),
    tid: (a, b) =>
      a.recipe.minutes - b.recipe.minutes || a.costPerServing - b.costPerServing || byName(a, b),
  };
  return ideas
    .filter(
      (i) =>
        (f.meal == null || i.recipe.meal === f.meal) &&
        (f.maxMinutes == null || i.recipe.minutes <= f.maxMinutes) &&
        (f.maxPerPerson == null || i.costPerServing <= f.maxPerPerson) &&
        (!f.liked || liked.has(i.recipe.id)),
    )
    .sort(compare[f.sort]);
}

// ---------------------------------------------------------------- liked dishes

export const LIKED_COOKIE = "fc_liked_recipes";
const RECIPE_IDS = new Set(RECIPES.map((r) => r.id));

/** The liked recipe ids in the cookie; unknown ids are dropped. */
export function parseLiked(value: string | undefined | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").filter((id) => RECIPE_IDS.has(id)))];
}

export function serializeLiked(ids: readonly string[]): string {
  return parseLiked(ids.join(",")).join(",");
}

/** Like or unlike one dish. */
export function toggleLiked(ids: readonly string[], id: string): string[] {
  if (!RECIPE_IDS.has(id)) return [...ids];
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
