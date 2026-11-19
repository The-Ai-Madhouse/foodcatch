/**
 * "Dine basisvarer" (docs/ui.md §15): staples the user picks once (stored in a cookie), shown at
 * the top of the offers page whenever one of them is on offer or cleared nearby. Pure.
 */

import type { ListingDeal } from "./deals";
import { STATUS_RANK } from "./deals";
import type { FoodWasteItem } from "./foodwaste";
import { typeIdOf } from "./meals";

export const STAPLES_COOKIE = "fc_staples";

export interface StapleOption {
  id: string;
  /** Danish label in the picker and the section. */
  label: string;
  /** Taxonomy type ids that count as this staple. */
  types: readonly string[];
}

/**
 * Staples that can be picked: breakfast and everyday basics among the types the pipeline
 * recognizes. Bread, coffee and fruit are not recognized yet and therefore not offered.
 */
export const STAPLE_OPTIONS: readonly StapleOption[] = [
  { id: "aeg", label: "Æg", types: ["æg"] },
  { id: "havregryn", label: "Havregryn", types: ["havregryn"] },
  { id: "maelk", label: "Mælk", types: ["mælk"] },
  { id: "skyr", label: "Skyr", types: ["skyr"] },
  { id: "yoghurt", label: "Yoghurt", types: ["yoghurt", "græsk_yoghurt"] },
  { id: "ymer", label: "A38/ymer", types: ["a38_ymer"] },
  { id: "smoer", label: "Smør", types: ["smør", "smørbar"] },
  { id: "ost", label: "Ost", types: ["fast_ost"] },
  { id: "hytteost", label: "Hytteost", types: ["hytteost"] },
  { id: "kaernemaelk", label: "Kærnemælk", types: ["kærnemælk"] },
];

const BY_ID = new Map(STAPLE_OPTIONS.map((o) => [o.id, o]));

/** Parse the cookie (comma-separated ids): known ids in catalogue order, no duplicates. */
export function parseStaples(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = new Set(value.split(",").map((s) => s.trim()));
  return STAPLE_OPTIONS.filter((o) => ids.has(o.id)).map((o) => o.id);
}

/** The cookie value for a selection (only known ids). */
export function serializeStaples(ids: readonly unknown[]): string {
  return parseStaples(ids.filter((i): i is string => typeof i === "string").join(",")).join(",");
}

/** At most this many offers and clearances are shown per staple. */
export const MAX_OFFERS_PER_STAPLE = 3;
export const MAX_CLEARANCES_PER_STAPLE = 2;

export interface StapleMatches {
  staple: StapleOption;
  /** Offers with a variant of the staple, best verdict and lowest unit price first. */
  offers: ListingDeal[];
  /** Clearances of the staple nearby, largest discount first. */
  clearances: FoodWasteItem[];
  /** All matches before the per-staple limits. */
  offerCount: number;
  clearanceCount: number;
}

const unitPrice = (l: ListingDeal) =>
  l.offer.unitPriceMin ?? l.offer.unitPriceMax ?? Number.POSITIVE_INFINITY;

/**
 * The chosen staples with their offers and clearances. Offers that are cheaper elsewhere are
 * left out: the section is about staples worth buying now.
 */
export function stapleMatches(
  selected: readonly string[],
  listings: readonly ListingDeal[],
  foodWaste: readonly FoodWasteItem[],
): StapleMatches[] {
  return selected.flatMap((id) => {
    const staple = BY_ID.get(id);
    if (!staple) return [];
    const types = new Set(staple.types);
    const offers = listings
      .filter(
        (l) => l.status !== "cheaper_elsewhere" && l.variants.some((v) => types.has(v.typeId)),
      )
      .sort(
        (a, b) =>
          STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          unitPrice(a) - unitPrice(b) ||
          a.offer.price - b.offer.price,
      );
    const clearances = foodWaste
      .filter((w) => {
        const t = typeIdOf(w.classKey);
        return t != null && types.has(t);
      })
      .sort((a, b) => (b.discountPct ?? 0) - (a.discountPct ?? 0) || a.distanceKm - b.distanceKm);
    return [
      {
        staple,
        offers: offers.slice(0, MAX_OFFERS_PER_STAPLE),
        clearances: clearances.slice(0, MAX_CLEARANCES_PER_STAPLE),
        offerCount: offers.length,
        clearanceCount: clearances.length,
      },
    ];
  });
}
