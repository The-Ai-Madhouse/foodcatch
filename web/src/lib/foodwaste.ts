/**
 * Food-waste clearances (`api.food_waste_near`) as shown on /madspild and /kort: pack size,
 * unit price and the facts behind them (docs/ui.md §5.3 and §6.2). Pure and unit tested.
 */

import { packSize, type PackSize } from "./format";

/** One row of `api.food_waste_near` with its distance from the user. */
export interface FoodWasteItem {
  listingId: string;
  storeId: string;
  chainId: string;
  storeName: string;
  street: string | null;
  zip: string | null;
  city: string | null;
  lat: number;
  lon: number;
  distanceKm: number;
  title: string;
  ean: string | null;
  price: number;
  referencePrice: number | null;
  discountPct: number | null;
  unit: string | null;
  unitPrice: number | null;
  validTo: string | null;
  stock: number | null;
  stockUnit: string | null;
  typeLabel: string;
  classLabel: string;
  isExact: boolean;
  /** Net size parsed from the Salling name, in `unit`. */
  size: number | null;
  /** Salling's product photo; null for the placeholder. */
  imageUrl: string | null;
  productQuantityText: string | null;
  productNetQuantity: number | null;
  productNetUnit: string | null;
  /** When the latest food-waste run last saw the clearance (stock snapshot time). */
  lastSeenAt: string | null;
}

/** The pack size of a clearance: from the Salling name, Open Food Facts, or unknown. */
export function foodWastePackSize(item: FoodWasteItem): PackSize {
  return packSize({
    unit: item.unit,
    sizeMin: item.size,
    sizeMax: item.size,
    source: "salling_food_waste",
    stockUnit: item.stockUnit,
    offNetQuantity: item.productNetQuantity,
    offNetUnit: item.productNetUnit,
    offQuantityText: item.productQuantityText,
  });
}

/**
 * The unit price of a clearance, only when its size came from the Salling name (an Open Food
 * Facts size may describe another pack and is never used for a price).
 */
export function foodWasteUnitPrice(item: FoodWasteItem): number | null {
  return foodWastePackSize(item).origin === "source" ? item.unitPrice : null;
}

/** The discount to show as a pill (whole percent, at least 1 %), or null. */
export function shownDiscount(discountPct: number | null): number | null {
  if (discountPct == null || !Number.isFinite(discountPct)) return null;
  const rounded = Math.round(discountPct);
  return rounded >= 1 ? rounded : null;
}

/** The newest `lastSeenAt` of the items: when the shown stock was last observed. */
export function latestSeen(items: readonly Pick<FoodWasteItem, "lastSeenAt">[]): string | null {
  let best: number | null = null;
  for (const item of items) {
    const t = item.lastSeenAt ? Date.parse(item.lastSeenAt) : Number.NaN;
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}
