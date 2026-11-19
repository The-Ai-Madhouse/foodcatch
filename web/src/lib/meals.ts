/**
 * Meal ideas ("Madideer", docs/ui.md §13): the dish catalogue (`recipes.ts`) matched against
 * this week's offers and the food-waste clearances near the user, with what the matched items
 * cost, what buying them saves, and a rough estimate of what the dish costs. Pure and unit
 * tested.
 *
 * Savings are only ever computed from our own data, never guessed:
 *
 * - Clearance: Salling's price before the markdown minus the clearance price, per pack.
 * - Offer: the cheapest normal price of exactly the same product (a `regular` shelf price of a
 *   chain near the user, or Salling's EAN price) times the smallest pack of the offer, minus the
 *   offer price. An offer without such a normal price saves an unknown amount (`null`) and adds
 *   nothing to the total.
 *
 * Offers are only used when they are a documented good deal or cheaper than the normal price;
 * an offer that is cheaper elsewhere is never suggested.
 */

import type { EvaluatedDeal } from "./deals";
import { foodWasteUnitPrice, type FoodWasteItem } from "./foodwaste";
import { RECIPES, type Meal, type Recipe, type RecipeSlot } from "./recipes";
import { referenceCounts, toOre, type ReferenceKind } from "./verdict";

export { RECIPES, type Meal, type Recipe, type RecipeSlot } from "./recipes";

/** Normal-price reference kinds an offer's saving is computed against. */
const NORMAL_PRICE_KINDS: ReadonlySet<ReferenceKind> = new Set(["regular", "ean_reference"]);

/** A cheap item that can fill a recipe slot. */
export type MealItem =
  | {
      kind: "offer";
      /** Listing id (one offer can fill only one slot per dish). */
      id: string;
      typeId: string;
      price: number;
      /** What the same pack costs at the normal price, or null when unknown. */
      normalPrice: number | null;
      /** `normalPrice - price`, or null when no normal price is known. */
      saving: number | null;
      deal: EvaluatedDeal;
    }
  | {
      kind: "foodwaste";
      id: string;
      typeId: string;
      price: number;
      normalPrice: number | null;
      saving: number | null;
      item: FoodWasteItem;
    };

/** The taxonomy type id of a class key (`hakket_oksekød|fedt=8-12%|…` -> `hakket_oksekød`). */
export function typeIdOf(classKey: string | null | undefined): string | null {
  const id = classKey?.split("|")[0]?.trim();
  return id ? id : null;
}

/** Kroner rounded to whole øre (as the verdict compares them). */
const roundKr = (value: number): number => toOre(value) / 100;

/**
 * The cheapest normal unit price of exactly the same product for this user: a nearby chain's
 * shelf price or Salling's EAN price, in the offer's unit. Null when there is none.
 */
export function normalUnitPrice(
  deal: EvaluatedDeal,
  nearbyChains: ReadonlySet<string>,
): number | null {
  if (!deal.isExact) return null;
  const prices = deal.references
    .filter(
      (r) =>
        NORMAL_PRICE_KINDS.has(r.kind) &&
        referenceCounts(r, nearbyChains) &&
        (r.unit == null || r.unit === deal.unit),
    )
    .map((r) => r.unit_price);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * An offer as a meal item, or null when it should not be suggested: not yet valid, its price
 * covers other products, it is cheaper elsewhere, or it is neither a good deal nor cheaper than
 * the normal price.
 *
 * The saving uses the offer's smallest pack (`sizeMin`), so for "250–400 g" it is what the
 * smallest pack would cost at the normal price: never more than the user can be sure of.
 */
export function offerItem(
  deal: EvaluatedDeal,
  nearbyChains: ReadonlySet<string>,
  now: Date,
): MealItem | null {
  if (Date.parse(deal.validFrom) > now.getTime()) return null;
  if (deal.priceApplies !== true) return null;
  if (deal.status === "cheaper_elsewhere" || deal.status === "pending") return null;
  const typeId = deal.typeId || typeIdOf(deal.classKey);
  if (!typeId) return null;
  const unitPrice = normalUnitPrice(deal, nearbyChains);
  const size = deal.sizeMin ?? deal.sizeMax;
  let normalPrice: number | null = null;
  let saving: number | null = null;
  if (unitPrice != null && size != null && size > 0) {
    normalPrice = roundKr(unitPrice * size);
    saving = Math.max(0, roundKr(normalPrice - deal.price));
  }
  if (deal.status !== "good_deal" && !(saving != null && saving > 0)) return null;
  return {
    kind: "offer",
    id: deal.listingId,
    typeId,
    price: deal.price,
    normalPrice,
    saving,
    deal,
  };
}

/** A clearance as a meal item; its saving is Salling's price before the markdown. */
export function foodWasteItem(item: FoodWasteItem): MealItem | null {
  const typeId = typeIdOf(item.classKey);
  if (!typeId) return null;
  const before = item.referencePrice;
  const known = before != null && Number.isFinite(before) && before > item.price;
  return {
    kind: "foodwaste",
    id: item.listingId,
    typeId,
    price: item.price,
    normalPrice: known ? before : null,
    saving: known ? roundKr(before - item.price) : null,
    item,
  };
}

/** Every suggestible item, grouped by taxonomy type id. */
export function mealItemsByType(
  deals: readonly EvaluatedDeal[],
  foodWaste: readonly FoodWasteItem[],
  nearbyChains: ReadonlySet<string>,
  now: Date,
): Map<string, MealItem[]> {
  const byType = new Map<string, MealItem[]>();
  const seen = new Set<string>();
  const add = (entry: MealItem | null) => {
    // One offer can have several variants of the same type; keep its first suggestible one.
    if (!entry || seen.has(`${entry.kind}:${entry.id}:${entry.typeId}`)) return;
    seen.add(`${entry.kind}:${entry.id}:${entry.typeId}`);
    const list = byType.get(entry.typeId);
    if (list) list.push(entry);
    else byType.set(entry.typeId, [entry]);
  };
  for (const deal of deals) add(offerItem(deal, nearbyChains, now));
  for (const item of foodWaste) add(foodWasteItem(item));
  for (const list of byType.values()) list.sort(compareItems);
  return byType;
}

/** The distance used to break ties: the clearance's store; offers are chain-wide. */
const itemDistance = (i: MealItem): number =>
  i.kind === "foodwaste" ? i.item.distanceKm : Number.POSITIVE_INFINITY;

/** Largest known saving first, then the cheaper pack, then the nearer clearance. */
function compareItems(a: MealItem, b: MealItem): number {
  return (
    (b.saving ?? 0) - (a.saving ?? 0) ||
    a.price - b.price ||
    itemDistance(a) - itemDistance(b) ||
    a.id.localeCompare(b.id)
  );
}

export interface FilledSlot {
  slot: RecipeSlot;
  item: MealItem;
  /**
   * What the part of the pack the dish uses costs (kr.): the slot's amount at the item's unit
   * price, at most the pack price. When the item's unit price is unknown, the slot's estimate,
   * again at most the pack price.
   */
  usedCost: number;
}

export interface MealIdea {
  recipe: Recipe;
  filled: FilledSlot[];
  /** Slots with nothing on offer or cleared: bought at the normal price. */
  missing: RecipeSlot[];
  /** What the cheap items cost as whole packs (kr.): the shopping-list price. */
  purchasePrice: number;
  /** Sum of the known savings of the filled slots (kr., whole øre). */
  totalSaving: number;
  /**
   * The saving in percent of the normal price of the items whose saving is known; null when no
   * saving is known.
   */
  savingPct: number | null;
  /** Number of filled slots whose saving is unknown (good deals without a normal price). */
  unknownSavings: number;
  /**
   * Rough cost of the dish itself (kr.): the used part of each cheap item, plus the estimates of
   * the missing slots and the pantry items. An estimate, always shown as "ca.".
   */
  dishCost: number;
  /** {@link dishCost} per serving. */
  costPerServing: number;
}

/** The unit price of an item in `unit` (kr. per kg, l or piece), or null when unknown. */
export function itemUnitPrice(item: MealItem, unit: string): number | null {
  if (item.kind === "offer") {
    const { deal } = item;
    const size = deal.sizeMin ?? deal.sizeMax;
    // The smallest pack's unit price: the worst case of a range.
    return deal.unit === unit && size != null && size > 0 ? deal.price / size : null;
  }
  const price = foodWasteUnitPrice(item.item);
  return item.item.unit === unit && price != null && price > 0 ? price : null;
}

/** What the part of `item` that `slot` uses costs (see {@link FilledSlot.usedCost}). */
export function usedCost(slot: RecipeSlot, item: MealItem): number {
  const unitPrice = itemUnitPrice(item, slot.unit);
  const cost = unitPrice != null ? slot.amount * unitPrice : slot.estimateKr;
  return roundKr(Math.min(item.price, cost));
}

/** A recipe filled with the best item per slot, or null when a core slot cannot be filled. */
export function fillRecipe(
  recipe: Recipe,
  byType: ReadonlyMap<string, readonly MealItem[]>,
): MealIdea | null {
  const used = new Set<string>();
  const filled: FilledSlot[] = [];
  const missing: RecipeSlot[] = [];
  for (const slot of recipe.slots) {
    const options = slot.types
      .flatMap((t) => byType.get(t) ?? [])
      .filter((i) => !used.has(`${i.kind}:${i.id}`))
      .sort(compareItems);
    const best = options[0];
    if (best) {
      used.add(`${best.kind}:${best.id}`);
      filled.push({ slot, item: best, usedCost: usedCost(slot, best) });
    } else if (slot.core) {
      return null;
    } else {
      missing.push(slot);
    }
  }
  if (filled.length === 0) return null;
  const sum = (values: number[]) => roundKr(values.reduce((a, b) => a + b, 0));
  const known = filled.filter((f) => f.item.saving != null && f.item.normalPrice != null);
  const totalSaving = sum(known.map((f) => f.item.saving ?? 0));
  const knownNormal = sum(known.map((f) => f.item.normalPrice ?? 0));
  const dishCost = sum([
    ...filled.map((f) => f.usedCost),
    ...missing.map((s) => s.estimateKr),
    ...recipe.pantry.map((p) => p.estimateKr),
  ]);
  return {
    recipe,
    filled,
    missing,
    purchasePrice: sum(filled.map((f) => f.item.price)),
    totalSaving,
    savingPct: knownNormal > 0 && totalSaving > 0 ? (totalSaving / knownNormal) * 100 : null,
    unknownSavings: filled.length - known.length,
    dishCost,
    costPerServing: roundKr(dishCost / recipe.servings),
  };
}

/** At most this many ideas are shown per meal. */
export const MAX_IDEAS = 5;

/** Best idea first: largest saving, then most ingredients covered, then using both sources. */
function compareIdeas(a: MealIdea, b: MealIdea): number {
  const mixed = (i: MealIdea) => new Set(i.filled.map((f) => f.item.kind)).size;
  return (
    b.totalSaving - a.totalSaving ||
    b.filled.length - a.filled.length ||
    mixed(b) - mixed(a) ||
    a.recipe.name.localeCompare(b.recipe.name, "da-DK")
  );
}

/** The main item of an idea: its first core slot (the item the dish is built around). */
function mainItemKey(idea: MealIdea): string {
  const main = idea.filled.find((f) => f.slot.core) ?? idea.filled[0];
  return main ? `${main.item.kind}:${main.item.id}` : idea.recipe.id;
}

/**
 * Up to {@link MAX_IDEAS} dishes for one meal from this week's cheap items, best saving first.
 * Each idea is built around a different main item, so five ideas never all hinge on the same
 * pack of mince.
 */
export function mealIdeas(
  deals: readonly EvaluatedDeal[],
  foodWaste: readonly FoodWasteItem[],
  nearbyChains: ReadonlySet<string>,
  now: Date,
  meal: Meal,
  recipes: readonly Recipe[] = RECIPES,
): MealIdea[] {
  const byType = mealItemsByType(deals, foodWaste, nearbyChains, now);
  const ideas = recipes
    .filter((r) => r.meal === meal)
    .map((r) => fillRecipe(r, byType))
    .filter((i): i is MealIdea => i != null)
    .sort(compareIdeas);
  const chosen: MealIdea[] = [];
  const mains = new Set<string>();
  for (const idea of ideas) {
    const main = mainItemKey(idea);
    if (mains.has(main)) continue;
    mains.add(main);
    chosen.push(idea);
    if (chosen.length === MAX_IDEAS) break;
  }
  return chosen;
}
