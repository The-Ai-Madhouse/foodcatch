/**
 * The meal plan of "Madideer" (docs/ui.md §19.2): days with the dishes picked for them, and one
 * shopping list for the whole plan, either in one store or across stores at the lowest total.
 * Pure and unit tested.
 */

import {
  fillRecipe,
  itemChain,
  itemUnitPrice,
  mealItemsByType,
  type MealItem,
  type StoreChoice,
} from "./meals";
import type { EvaluatedDeal } from "./deals";
import type { FoodWasteItem } from "./foodwaste";
import type { FoundPrice, PriceFinder } from "./pantry";
import { RECIPES, type Recipe, type RecipeSlot } from "./recipes";
import { toOre } from "./verdict";

export const PLAN_COOKIE = "fc_meal_plan";
/** Days that can be planned, from today. */
export const PLAN_HORIZON_DAYS = 14;
export const MAX_DISHES_PER_DAY = 4;

export interface PlanDay {
  /** Local date, `YYYY-MM-DD`. */
  date: string;
  /** Recipe ids, in the order they were added. */
  recipes: string[];
}

export type MealPlan = PlanDay[];

const RECIPE_BY_ID = new Map(RECIPES.map((r) => [r.id, r]));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in Denmark, `YYYY-MM-DD`. */
export function todayInDenmark(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Copenhagen" }).format(now);
}

/** `YYYY-MM-DD` plus `days`. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The days that can be planned: today and the next {@link PLAN_HORIZON_DAYS} − 1. */
export function plannableDays(today: string): string[] {
  return Array.from({ length: PLAN_HORIZON_DAYS }, (_, i) => addDays(today, i));
}

/** "lør. 21/11" (with "I dag" / "I morgen"). */
export function dayLabel(date: string, today: string, long = false): string {
  const d = new Date(`${date}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("da-DK", {
    weekday: long ? "long" : "short",
    timeZone: "UTC",
  }).format(d);
  const dm = `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  if (date === today) return `I dag ${dm}`;
  if (date === addDays(today, 1)) return `I morgen ${dm}`;
  return `${weekday.charAt(0).toLocaleUpperCase("da-DK")}${weekday.slice(1)} ${dm}`;
}

/** The plan in the cookie: past or far days, unknown dishes and duplicates are dropped. */
export function parsePlan(value: string | null | undefined, today: string): MealPlan {
  if (!value) return [];
  const allowed = new Set(plannableDays(today));
  const byDate = new Map<string, string[]>();
  for (const part of value.split("|")) {
    const [date = "", list = ""] = part.split("=");
    if (!DATE_RE.test(date) || !allowed.has(date) || byDate.has(date)) continue;
    byDate.set(
      date,
      list
        .split(".")
        .filter((id) => RECIPE_BY_ID.has(id))
        .slice(0, MAX_DISHES_PER_DAY),
    );
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, recipes]) => ({ date, recipes }));
}

export function serializePlan(plan: MealPlan): string {
  return plan.map((d) => `${d.date}=${d.recipes.join(".")}`).join("|");
}

const sorted = (plan: MealPlan): MealPlan => [...plan].sort((a, b) => a.date.localeCompare(b.date));

/** Add or remove a day (a removed day loses its dishes). */
export function togglePlanDay(plan: MealPlan, date: string): MealPlan {
  return plan.some((d) => d.date === date)
    ? plan.filter((d) => d.date !== date)
    : sorted([...plan, { date, recipes: [] }]);
}

/** Add a dish to a day (adding the day when needed). */
export function addPlanDish(plan: MealPlan, date: string, recipeId: string): MealPlan {
  if (!RECIPE_BY_ID.has(recipeId)) return plan;
  const day = plan.find((d) => d.date === date);
  if (!day) return sorted([...plan, { date, recipes: [recipeId] }]);
  if (day.recipes.length >= MAX_DISHES_PER_DAY) return plan;
  return plan.map((d) => (d.date === date ? { ...d, recipes: [...d.recipes, recipeId] } : d));
}

/** Remove the dish at `index` of a day. */
export function removePlanDish(plan: MealPlan, date: string, index: number): MealPlan {
  return plan.map((d) =>
    d.date === date ? { ...d, recipes: d.recipes.filter((_, i) => i !== index) } : d,
  );
}

/** Every planned dish, in day order. */
export function plannedRecipes(plan: MealPlan): Recipe[] {
  return plan.flatMap((d) => d.recipes.map((id) => RECIPE_BY_ID.get(id)).filter((r) => r != null));
}

// ---------------------------------------------------------------- shopping

/** Where the plan is bought: one chain, or the cheapest item wherever it is. */
export type PlanStore = { kind: "one"; chainId: string } | { kind: "many" };

export interface PlanLine {
  key: string;
  /** A chain id for cheap items, `normal` for slots at the normal price, `basic` / `buy` for pantry. */
  group: string;
  label: string;
  /** "2 pk. · 1 kg" / "500 g" / "2 × 1 stk." */
  amount: string;
  payKr: number;
  /** What the dishes use of it (kr.): shown instead of `payKr` when ticked as "har jeg". */
  portionKr: number;
  approx: boolean;
  item?: MealItem;
  /** The real product for an item not on offer (`lib/pantry.ts`). */
  found?: FoundPrice;
  packs: number;
  /** The dishes that use it. */
  dishes: string[];
  basic: boolean;
}

export interface PlanShopping {
  store: PlanStore;
  lines: PlanLine[];
  /** What the whole list costs (kr.), estimates included. */
  total: number;
  /** Known saving of the cheap items (kr.). */
  saving: number;
  /** Chains the cheap items come from. */
  chains: string[];
  offerCount: number;
}

const roundKr = (value: number): number => toOre(value) / 100;

const storeChoice = (store: PlanStore): StoreChoice =>
  store.kind === "one"
    ? { chainId: store.chainId, only: true, cheapest: true }
    : { chainId: null, only: false, cheapest: true };

/**
 * The shopping list of the planned dishes. A cheap item used by several dishes is bought as
 * often as their amounts together need packs (one pack when its size is unknown per use).
 * Basics (oil, spices) count in the total only when not expected at home: they are listed but
 * left out of `total`.
 */
export function planShopping(
  recipes: readonly Recipe[],
  byType: ReadonlyMap<string, readonly MealItem[]>,
  store: PlanStore,
  finder?: PriceFinder,
): PlanShopping {
  // Bought in one store: only that chain's shelf prices count for what is not on offer.
  const chainId = store.kind === "one" ? store.chainId : null;
  const choice = storeChoice(store);
  const items = new Map<
    string,
    { item: MealItem; label: string; amount: number; unit: string; uses: number; dishes: string[] }
  >();
  const normal = new Map<
    string,
    {
      label: string;
      kr: number;
      uses: number;
      dishes: string[];
      types: readonly string[];
      amount: number;
      unit: RecipeSlot["unit"];
    }
  >();
  const pantry = new Map<
    string,
    { name: string; label: string; kr: number; amounts: string[]; basic: boolean; dishes: string[] }
  >();

  for (const recipe of recipes) {
    const idea = fillRecipe(recipe, byType, choice);
    if (!idea) continue;
    for (const row of idea.rows) {
      const item = row.chosen?.item;
      if (item) {
        const key = `${item.kind}:${item.id}`;
        const entry = items.get(key) ?? {
          item,
          label: row.slot.label,
          amount: 0,
          unit: row.slot.unit,
          uses: 0,
          dishes: [],
        };
        entry.amount += row.slot.amount;
        entry.uses += 1;
        entry.dishes.push(recipe.name);
        items.set(key, entry);
      } else {
        const entry = normal.get(row.slot.label) ?? {
          label: row.slot.label,
          kr: 0,
          uses: 0,
          dishes: [],
          types: row.slot.types,
          amount: 0,
          unit: row.slot.unit,
        };
        entry.kr += row.slot.estimateKr;
        entry.amount += row.slot.amount;
        entry.uses += 1;
        entry.dishes.push(recipe.name);
        normal.set(row.slot.label, entry);
      }
    }
    for (const p of recipe.pantry) {
      const entry = pantry.get(p.name) ?? {
        name: p.name,
        label: p.name.charAt(0).toLocaleUpperCase("da-DK") + p.name.slice(1),
        kr: 0,
        amounts: [],
        basic: Boolean(p.basic),
        dishes: [],
      };
      entry.kr += p.estimateKr;
      entry.amounts.push(p.amount);
      entry.dishes.push(recipe.name);
      pantry.set(p.name, entry);
    }
  }

  const lines: PlanLine[] = [];
  let saving = 0;
  for (const [key, e] of items) {
    const unitPrice = itemUnitPrice(e.item, e.unit);
    const packSize = unitPrice ? e.item.price / unitPrice : null;
    const packs = packSize ? Math.max(1, Math.ceil(e.amount / packSize - 1e-9)) : e.uses;
    if (e.item.saving != null) saving += e.item.saving * packs;
    const payKr = roundKr(e.item.price * packs);
    lines.push({
      key: `item:${key}`,
      group: itemChain(e.item),
      label: e.label,
      amount: `${packs} pk.`,
      payKr,
      portionKr: unitPrice ? Math.min(payKr, roundKr(unitPrice * e.amount)) : payKr,
      approx: false,
      item: e.item,
      packs,
      dishes: [...new Set(e.dishes)],
      basic: false,
    });
  }
  for (const e of normal.values()) {
    const found = finder?.slotAmount(e.types, e.amount, e.unit, chainId) ?? null;
    lines.push({
      key: `normal:${e.label}`,
      group: "normal",
      label: e.label,
      amount: e.uses > 1 ? `til ${e.uses} retter` : "",
      payKr: found ? found.purchaseKr : roundKr(e.kr),
      portionKr: found ? found.portionKr : roundKr(e.kr),
      approx: !found,
      ...(found ? { found } : {}),
      packs: e.uses,
      dishes: [...new Set(e.dishes)],
      basic: false,
    });
  }
  for (const [name, e] of pantry) {
    const found = finder?.pantryAmounts(e.name, e.amounts, chainId) ?? null;
    lines.push({
      key: `pantry:${name}`,
      group: e.basic ? "basic" : "buy",
      label: e.label,
      amount: e.amounts.length > 1 ? e.amounts.join(" + ") : (e.amounts[0] ?? ""),
      payKr: found ? found.purchaseKr : roundKr(e.kr),
      portionKr: found ? found.portionKr : roundKr(e.kr),
      approx: !found,
      ...(found ? { found } : {}),
      packs: e.amounts.length,
      dishes: [...new Set(e.dishes)],
      basic: e.basic,
    });
  }
  const total = roundKr(lines.filter((l) => !l.basic).reduce((sum, l) => sum + l.payKr, 0));
  const chains = [...new Set(lines.filter((l) => l.item).map((l) => l.group))];
  return {
    store,
    lines,
    total,
    saving: roundKr(saving),
    chains,
    offerCount: lines.filter((l) => l.item).length,
  };
}

export interface PlanOptions {
  /** One list per chain, cheapest first. */
  single: PlanShopping[];
  /** The lowest total across stores. */
  many: PlanShopping;
  /** The cheapest single chain (the recommendation), or null without chains. */
  recommended: string | null;
}

/** Every way to buy the plan: each nearby chain alone, and across chains. */
export function planOptions(
  recipes: readonly Recipe[],
  deals: readonly EvaluatedDeal[],
  foodWaste: readonly FoodWasteItem[],
  nearbyChains: ReadonlySet<string>,
  now: Date,
  finder?: PriceFinder,
): PlanOptions {
  const byType = mealItemsByType(deals, foodWaste, nearbyChains, now);
  const single = [...nearbyChains]
    .map((chainId) => planShopping(recipes, byType, { kind: "one", chainId }, finder))
    .sort((a, b) => a.total - b.total || b.saving - a.saving);
  const many = planShopping(recipes, byType, { kind: "many" }, finder);
  const first = single[0];
  return {
    single,
    many,
    recommended: first && first.store.kind === "one" ? first.store.chainId : null,
  };
}
