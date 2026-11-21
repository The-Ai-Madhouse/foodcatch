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
import { normalReference } from "./savings";
import { toOre } from "./verdict";

export { RECIPES, type Meal, type Recipe, type RecipeSlot } from "./recipes";

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
  // One definition of "the normal price" for the whole app (lib/savings.ts).
  return normalReference(deal, nearbyChains)?.unit_price ?? null;
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

/** One ingredient slot of an idea, in recipe order: the chosen cheap item and every other one. */
export interface SlotRow {
  slot: RecipeSlot;
  /** The cheap item used, or null when the slot is bought at the normal price. */
  chosen: FilledSlot | null;
  /** Every cheap item that fits the slot, best first (the chosen one included). */
  options: readonly MealItem[];
}

/** Which store the user plans to shop in ("Butik" and "Kun én butik" on the page). */
export interface StoreChoice {
  /** The preferred chain: its items win a slot over other chains'. */
  chainId: string | null;
  /** Only items of one chain: `chainId`, or without it the chain that saves the most. */
  only: boolean;
  /**
   * Pick the cheapest pack instead of the biggest saving, and skip items dearer per unit than the
   * slot's normal-price estimate (buying them would raise the shopping total).
   */
  cheapest?: boolean;
}

export const ANY_STORE: StoreChoice = { chainId: null, only: false };

export interface MealIdea {
  recipe: Recipe;
  filled: FilledSlot[];
  /** Slots with nothing on offer or cleared (in the chosen store): bought at the normal price. */
  missing: RecipeSlot[];
  /** Every slot in recipe order, with all the cheap items that fit it. */
  rows: SlotRow[];
  /** The single chain the cheap items come from when the user wants one store, else null. */
  chainId: string | null;
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

/** The chain an item is bought in. */
export function itemChain(item: MealItem): string {
  return item.kind === "offer" ? item.deal.chainId : item.item.chainId;
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

/** What buying enough packs of `item` for `slot` costs (one pack when its size is unknown). */
export function slotPayCost(slot: RecipeSlot, item: MealItem): number {
  const unitPrice = itemUnitPrice(item, slot.unit);
  const packs = unitPrice
    ? Math.max(1, Math.ceil((slot.amount * unitPrice) / item.price - 1e-9))
    : 1;
  return roundKr(packs * item.price);
}

/**
 * Whether buying the item costs more than buying the slot at the normal price: its unit price
 * above the slot's estimated normal unit price. (Comparing the pack price with the estimate of
 * the used amount would wrongly skip a cheap 500 g pack for a dish that uses 350 g: the normal
 * price is a whole pack too.) Without a unit price, the pack price against the estimate.
 */
function dearerThanNormal(slot: RecipeSlot, item: MealItem): boolean {
  const unitPrice = itemUnitPrice(item, slot.unit);
  if (unitPrice == null) return slotPayCost(slot, item) > slot.estimateKr;
  return unitPrice > slot.estimateKr / slot.amount;
}

/**
 * A recipe filled with the best item per slot. With a preferred chain its items win; with
 * `only`, items of other chains are never chosen (they still show as options). Every recipe
 * gives an idea: slots without a cheap item are priced at their estimate. With `requireCore`,
 * null when a core slot cannot be filled.
 */
export function fillRecipe(
  recipe: Recipe,
  byType: ReadonlyMap<string, readonly MealItem[]>,
  store: StoreChoice = ANY_STORE,
  requireCore = false,
): MealIdea | null {
  const used = new Set<string>();
  const filled: FilledSlot[] = [];
  const missing: RecipeSlot[] = [];
  const rows: SlotRow[] = [];
  const preferred = (i: MealItem) => (store.chainId && itemChain(i) === store.chainId ? 1 : 0);
  for (const slot of recipe.slots) {
    const seen = new Set<string>();
    const options = slot.types
      .flatMap((t) => byType.get(t) ?? [])
      .filter((i) => {
        const key = `${i.kind}:${i.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(
        (a, b) =>
          preferred(b) - preferred(a) ||
          (store.cheapest ? slotPayCost(slot, a) - slotPayCost(slot, b) : 0) ||
          compareItems(a, b),
      );
    const best = options.find(
      (i) =>
        !used.has(`${i.kind}:${i.id}`) &&
        !(store.cheapest && dearerThanNormal(slot, i)) &&
        !(store.only && store.chainId && itemChain(i) !== store.chainId),
    );
    if (best) {
      used.add(`${best.kind}:${best.id}`);
      const chosen = { slot, item: best, usedCost: usedCost(slot, best) };
      filled.push(chosen);
      rows.push({ slot, chosen, options });
    } else {
      if (slot.core && requireCore) return null;
      missing.push(slot);
      rows.push({ slot, chosen: null, options });
    }
  }
  if (requireCore && filled.length === 0) return null;
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
    rows,
    chainId: store.only ? store.chainId : null,
    purchasePrice: sum(filled.map((f) => f.item.price)),
    totalSaving,
    savingPct: knownNormal > 0 && totalSaving > 0 ? (totalSaving / knownNormal) * 100 : null,
    unknownSavings: filled.length - known.length,
    dishCost,
    costPerServing: roundKr(dishCost / recipe.servings),
  };
}

/** More saved first, then the cheaper dish. */
function betterSingleStore(a: MealIdea, b: MealIdea): number {
  return (
    b.totalSaving - a.totalSaving || b.filled.length - a.filled.length || a.dishCost - b.dishCost
  );
}

/**
 * One idea per recipe for the catalogue ("Madideer"). With "only one store" and no chain chosen,
 * each dish gets the nearby chain where it saves the most.
 */
export function mealCatalogue(
  deals: readonly EvaluatedDeal[],
  foodWaste: readonly FoodWasteItem[],
  nearbyChains: ReadonlySet<string>,
  now: Date,
  store: StoreChoice = ANY_STORE,
  recipes: readonly Recipe[] = RECIPES,
): MealIdea[] {
  const byType = mealItemsByType(deals, foodWaste, nearbyChains, now);
  return recipes.map((recipe) => {
    if (!store.only || store.chainId) return fillRecipe(recipe, byType, store) as MealIdea;
    const chains = new Set<string>();
    for (const slot of recipe.slots)
      for (const t of slot.types) for (const i of byType.get(t) ?? []) chains.add(itemChain(i));
    const tries = [...chains]
      .map((chainId) => fillRecipe(recipe, byType, { chainId, only: true }) as MealIdea)
      .filter((i) => i.filled.length > 0)
      .sort(betterSingleStore);
    return tries[0] ?? (fillRecipe(recipe, byType, { chainId: null, only: true }) as MealIdea);
  });
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
    .map((r) => fillRecipe(r, byType, ANY_STORE, true))
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
