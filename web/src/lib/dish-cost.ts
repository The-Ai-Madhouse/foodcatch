/**
 * What a dish costs (docs/ui.md §23), in the order the user cares about:
 *
 * 1. the purchase price: what the items you still need cost at the till, in whole packs;
 * 2. the dish price: what the amounts the dish uses cost (a 2 kg bag of potatoes for a dish
 *    that uses 1 kg counts half).
 *
 * Every item is priced from a real product when we have one (the item on offer or cleared, else
 * the cheapest shelf price or offer near the user, `lib/pantry.ts`); only when we have none is the
 * recipe's rough estimate used, and the row and totals then say "ca.".
 */
import { itemChain, type MealIdea, type MealItem } from "./meals";
import type { FoundPrice, PriceFinder } from "./pantry";
import type { RecipeSlot } from "./recipes";
import { toOre } from "./verdict";

const roundKr = (value: number): number => toOre(value) / 100;

export interface DishLine {
  key: string;
  kind: "slot" | "pantry";
  /** `ingredient` (a recipe slot), `buy` (an extra item) or `basic` (expected at home). */
  group: "ingredient" | "buy" | "basic";
  label: string;
  /** The amount text ("500 g", "1 kg"). */
  amount: string;
  /** The cheap item (offer or clearance) of a slot. */
  item: MealItem | null;
  /** The real product for a slot not on offer or an extra item. */
  found: FoundPrice | null;
  /** What buying it costs (kr.). */
  purchaseKr: number;
  /** What the used amount costs (kr.). */
  portionKr: number;
  /** True when the prices are the recipe's estimate (no real product found). */
  estimate: boolean;
  /** Ticked as "har jeg" by default (basics). */
  basic: boolean;
}

export interface DishCost {
  lines: DishLine[];
  /** What the items not ticked by default cost at the till (kr.). */
  purchaseKr: number;
  purchaseApprox: boolean;
  /** What the used amounts of every item cost (kr.). */
  dishKr: number;
  dishApprox: boolean;
  /** `dishKr` per serving. */
  perServingKr: number;
  /** Lines priced from a real product (on offer, cleared, shelf price). */
  realCount: number;
}

const capital = (s: string) => s.charAt(0).toLocaleUpperCase("da-DK") + s.slice(1);

function slotLine(
  slot: RecipeSlot,
  amount: string,
  chosen: { item: MealItem; usedCost: number } | null,
  finder: PriceFinder | undefined,
): DishLine {
  const base = {
    key: `slot:${slot.label}`,
    kind: "slot" as const,
    group: "ingredient" as const,
    label: slot.label,
    amount,
    basic: false,
  };
  if (chosen) {
    return {
      ...base,
      item: chosen.item,
      found: null,
      purchaseKr: chosen.item.price,
      portionKr: Math.min(chosen.item.price, roundKr(chosen.usedCost)),
      estimate: false,
    };
  }
  const found = finder?.slot(slot) ?? null;
  return found
    ? {
        ...base,
        item: null,
        found,
        purchaseKr: found.purchaseKr,
        portionKr: found.portionKr,
        estimate: false,
      }
    : {
        ...base,
        item: null,
        found: null,
        purchaseKr: slot.estimateKr,
        portionKr: slot.estimateKr,
        estimate: true,
      };
}

/** The shopping lines and totals of a dish. */
export function dishCost(
  idea: MealIdea,
  finder: PriceFinder | undefined,
  formatAmount: (slot: RecipeSlot) => string,
): DishCost {
  const lines: DishLine[] = idea.rows.map((row) =>
    slotLine(row.slot, formatAmount(row.slot), row.chosen, finder),
  );
  for (const p of idea.recipe.pantry) {
    const found = finder?.pantry(p) ?? null;
    lines.push({
      key: `pantry:${p.name}`,
      kind: "pantry",
      group: p.basic ? "basic" : "buy",
      label: capital(p.name),
      amount: p.amount,
      item: null,
      found,
      purchaseKr: found ? found.purchaseKr : p.estimateKr,
      portionKr: found ? found.portionKr : p.estimateKr,
      estimate: !found,
      basic: Boolean(p.basic),
    });
  }
  const toBuy = lines.filter((l) => !l.basic);
  const dishKr = roundKr(lines.reduce((sum, l) => sum + l.portionKr, 0));
  return {
    lines,
    purchaseKr: roundKr(toBuy.reduce((sum, l) => sum + l.purchaseKr, 0)),
    purchaseApprox: toBuy.some((l) => l.estimate),
    dishKr,
    dishApprox: lines.some((l) => l.estimate),
    perServingKr: roundKr(dishKr / Math.max(1, idea.recipe.servings)),
    realCount: lines.filter((l) => !l.estimate).length,
  };
}

/** The chain a line is bought in, or null for an estimate. */
export function lineChain(line: DishLine): string | null {
  if (line.item) return itemChain(line.item);
  return line.found?.product.chainId ?? null;
}
