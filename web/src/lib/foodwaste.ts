/**
 * Food-waste clearances (`api.food_waste_near`) as shown on /madspild and /kort: pack size,
 * unit price and the facts behind them (docs/ui.md §5.3 and §6.2). Pure and unit tested.
 */

import { chainName } from "./chains";
import { genitive } from "./deals";
import { packSize, type PackSize } from "./format";
import type { Reference } from "./verdict";

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
  /** The item's key in `api.product_price_history` (its price history page). */
  productKey: string | null;
  /** `{salling store}:{label ean}`. */
  sourceItemId: string | null;
  /** Salling's own store id. */
  sallingStoreId: string | null;
  /** When the latest Salling response carrying the clearance was fetched. */
  sourceFetchedAt: string | null;
  /** Salling's `percentDiscount` as sent. */
  sallingPercentDiscount: number | null;
  /** The clearance label code (Salling `offer.ean`). */
  offerEan: string | null;
  /** The product code as Salling sent it (`ean` is set only for real GTINs). */
  productCode: string | null;
  classKey: string | null;
  /** Same-class prices of other chains (offers and shelf prices), in the deal shape. */
  references: Reference[];
  /** Cheaper than every reference; null when it cannot be judged. */
  beatsCompetitors: boolean | null;
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

/** The references of a clearance, cheapest first. */
export function sortedReferences(item: Pick<FoodWasteItem, "references">): Reference[] {
  return [...item.references].sort((a, b) => a.unit_price - b.unit_price);
}

/**
 * The badge of a clearance that is cheaper than every same-class price of the other chains
 * (`beats_competitors`): "Billigere end REMA 1000s normalpris" for one chain and kind,
 * "Billigere end Lidls tilbud", "Billigere end MENY", or "Billigst blandt kæderne" when several
 * chains were compared. Nothing when it is not cheaper or cannot be judged.
 */
export function competitorBadge(
  item: Pick<FoodWasteItem, "beatsCompetitors" | "references">,
): string | null {
  if (item.beatsCompetitors !== true || item.references.length === 0) return null;
  const chains = new Set(item.references.map((r) => r.chain_id));
  if (chains.size > 1) return "Billigst blandt kæderne";
  const chain = chainName(item.references[0]?.chain_id ?? "");
  const kinds = new Set(item.references.map((r) => r.kind));
  if (kinds.size === 1 && kinds.has("regular"))
    return `Billigere end ${genitive(chain)} normalpris`;
  if (kinds.size === 1 && kinds.has("offer")) return `Billigere end ${genitive(chain)} tilbud`;
  return `Billigere end ${chain}`;
}
