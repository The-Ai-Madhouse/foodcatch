/**
 * What the user saves against the normal price (docs/ui.md §21): the one number every price in
 * the app is labelled with. Computed only from our own data; when we do not know the normal
 * price we say so, we never estimate it.
 *
 * - Offer: against the cheapest normal shelf price (`regular`) at a chain near the user, or
 *   Salling's EAN price (`ean_reference`), of exactly the same product, for the offer's pack.
 * - Clearance: against Salling's price before the markdown.
 */
import type { ListingDeal } from "./deals";
import type { FoodWasteItem } from "./foodwaste";
import { referenceCounts, toOre, type Reference, type ReferenceKind } from "./verdict";

/** Normal-price reference kinds. */
export const NORMAL_PRICE_KINDS: ReadonlySet<ReferenceKind> = new Set(["regular", "ean_reference"]);

export type SavingBasis = "shelf" | "ean" | "before";

export type Saving =
  /** Cheaper than the normal price by `amount` kr. (`percent` of the normal price, rounded down). */
  | {
      kind: "saving";
      amount: number;
      percent: number;
      normalPrice: number;
      normalChainId: string | null;
      basis: SavingBasis;
    }
  /** Only the bigger packs of a size range are cheaper than the normal price. */
  | { kind: "depends"; maxAmount: number; normalChainId: string | null; basis: SavingBasis }
  /** Not cheaper than the normal price. */
  | { kind: "none"; normalPrice: number; normalChainId: string | null; basis: SavingBasis }
  /** No normal price of exactly the same product is known. */
  | { kind: "unknown" };

const UNKNOWN: Saving = { kind: "unknown" };

/** Kroner rounded to whole øre. */
const roundKr = (value: number): number => toOre(value) / 100;

/** The offer fields a saving needs. */
export interface SavingOffer {
  price: number;
  unit: string | null;
  sizeMin: number | null;
  sizeMax: number | null;
  isExact: boolean;
  /** False when the price covers other products too; null before the deal is computed. */
  priceApplies: boolean | null;
  references: readonly Reference[];
}

/** The cheapest normal-price reference of exactly the same product, or null. */
export function normalReference(
  offer: Pick<SavingOffer, "isExact" | "unit" | "references">,
  nearbyChains: ReadonlySet<string>,
): Reference | null {
  if (!offer.isExact) return null;
  let best: Reference | null = null;
  for (const r of offer.references) {
    if (!NORMAL_PRICE_KINDS.has(r.kind) || !referenceCounts(r, nearbyChains)) continue;
    if (r.unit != null && r.unit !== offer.unit) continue;
    if (!Number.isFinite(r.unit_price) || r.unit_price <= 0) continue;
    if (!best || r.unit_price < best.unit_price) best = r;
  }
  return best;
}

function fromNormal(
  price: number,
  normalPrice: number,
  normalChainId: string | null,
  basis: SavingBasis,
): Saving {
  const amount = roundKr(normalPrice - price);
  if (amount <= 0) return { kind: "none", normalPrice, normalChainId, basis };
  return {
    kind: "saving",
    amount,
    percent: Math.floor((amount / normalPrice) * 100),
    normalPrice,
    normalChainId,
    basis,
  };
}

/**
 * The saving of an offer. For a size range ("250–400 g") it is computed for the smallest pack,
 * so it is never more than the user can count on; when only bigger packs save, it is `depends`.
 */
export function offerSaving(offer: SavingOffer, nearbyChains: ReadonlySet<string>): Saving {
  if (offer.priceApplies === false) return UNKNOWN;
  const ref = normalReference(offer, nearbyChains);
  const small = offer.sizeMin ?? offer.sizeMax;
  if (!ref || small == null || !(small > 0)) return UNKNOWN;
  const basis: SavingBasis = ref.kind === "ean_reference" ? "ean" : "shelf";
  const chain = ref.kind === "ean_reference" ? null : ref.chain_id;
  const saving = fromNormal(offer.price, roundKr(ref.unit_price * small), chain, basis);
  if (saving.kind !== "none") return saving;
  const big = offer.sizeMax ?? small;
  if (big > small) {
    const maxAmount = roundKr(ref.unit_price * big - offer.price);
    if (maxAmount > 0) return { kind: "depends", maxAmount, normalChainId: chain, basis };
  }
  return saving;
}

/** The saving of a clearance against Salling's price before the markdown. */
export function clearanceSaving(item: Pick<FoodWasteItem, "price" | "referencePrice">): Saving {
  const before = item.referencePrice;
  if (before == null || !Number.isFinite(before) || before <= 0) return UNKNOWN;
  return fromNormal(item.price, before, null, "before");
}

/** The amount saved, or 0 (for sorting: known savings first, biggest first). */
export function savedAmount(saving: Saving): number {
  return saving.kind === "saving" ? saving.amount : 0;
}

/**
 * The saving of a listing: its variant that saves the most, else its first variant's verdict
 * on the normal price ("none" before "unknown", so a known "no saving" is not hidden).
 */
export function listingSaving(listing: ListingDeal, nearbyChains: ReadonlySet<string>): Saving {
  const rank = (x: Saving) =>
    x.kind === "saving" ? 3 : x.kind === "depends" ? 2 : x.kind === "none" ? 1 : 0;
  let best: Saving = { kind: "unknown" };
  for (const v of listing.variants) {
    const x = offerSaving(v, nearbyChains);
    if (
      rank(x) > rank(best) ||
      (x.kind === "saving" && best.kind === "saving" && x.amount > best.amount)
    ) {
      best = x;
    }
  }
  return best;
}
