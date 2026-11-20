/**
 * "Dine basisvarer" (docs/ui.md §15): staples the user picks once (stored in a cookie), shown at
 * the top of the offers page whenever one of them is on offer or cleared nearby. Pure.
 */

import type { DealStatus, ListingDeal } from "./deals";
import { STATUS_RANK } from "./deals";
import type { FoodWasteItem } from "./foodwaste";
import { typeIdOf } from "./meals";
import { resolveStaple, type Staple } from "./staple-catalogue";

export {
  STAPLES_COOKIE,
  STAPLE_OPTIONS,
  parseStaples,
  serializeStaples,
  type StapleOption,
} from "./staple-catalogue";

/**
 * A current or upcoming offer of any item (`api.product_price_history`, kind `offer`), for
 * free-text staples: no recognition, no verdict.
 */
export interface TextOffer {
  listingId: string;
  productKey: string | null;
  chainId: string;
  title: string;
  price: number | null;
  unit: string | null;
  unitPriceMin: number | null;
  unitPriceMax: number | null;
  sizeMin: number | null;
  sizeMax: number | null;
  validFrom: string;
  validTo: string | null;
  memberOnly: boolean;
  source: string | null;
}

/** The texts of the free-text staples in a selection (for the offer query). */
export function textStapleTerms(selected: readonly string[]): string[] {
  return selected.flatMap((id) => {
    const staple = resolveStaple(id);
    return staple?.kind === "text" ? [staple.text] : [];
  });
}

/** At most this many offers and clearances are shown per staple. */
export const MAX_OFFERS_PER_STAPLE = 3;
export const MAX_CLEARANCES_PER_STAPLE = 2;

export interface StapleMatches {
  staple: Staple;
  /** Offers with a variant of the staple, best verdict and lowest unit price first. */
  offers: ListingDeal[];
  /** Free-text staples: offers whose name contains the text, current and cheapest first. */
  textOffers: TextOffer[];
  /** Clearances of the staple nearby, largest discount first. */
  clearances: FoodWasteItem[];
  /** All matches before the per-staple limits. */
  offerCount: number;
  clearanceCount: number;
}

const textUnitPrice = (o: TextOffer) =>
  o.unitPriceMin ?? o.unitPriceMax ?? Number.POSITIVE_INFINITY;

const unitPrice = (l: ListingDeal) =>
  l.offer.unitPriceMin ?? l.offer.unitPriceMax ?? Number.POSITIVE_INFINITY;

/**
 * Verdicts worth showing among the staples: a documented good deal, or one that may be (it
 * depends on the pack). Offers without a comparison or cheaper elsewhere are left out: the
 * section is about staples worth buying now.
 */
const WORTH_SHOWING: ReadonlySet<DealStatus> = new Set(["good_deal", "undecided"]);

/**
 * The chosen staples with their offers worth buying and their clearances nearby; free-text
 * staples with the offers (`textOffers`, already limited to nearby chains) whose name contains
 * the text.
 */
export function stapleMatches(
  selected: readonly string[],
  listings: readonly ListingDeal[],
  foodWaste: readonly FoodWasteItem[],
  textOffers: readonly TextOffer[] = [],
  now: Date = new Date(),
): StapleMatches[] {
  return selected.flatMap((id): StapleMatches[] => {
    const staple = resolveStaple(id);
    if (!staple) return [];
    if (staple.kind === "text") {
      const started = (o: TextOffer) => Date.parse(o.validFrom) <= now.getTime();
      const offers = textOffers
        .filter((o) => o.title.toLocaleLowerCase("da-DK").includes(staple.text))
        .sort(
          (a, b) =>
            Number(started(b)) - Number(started(a)) ||
            textUnitPrice(a) - textUnitPrice(b) ||
            (a.price ?? Infinity) - (b.price ?? Infinity),
        );
      return [
        {
          staple,
          offers: [],
          textOffers: offers.slice(0, MAX_OFFERS_PER_STAPLE),
          clearances: [],
          offerCount: offers.length,
          clearanceCount: 0,
        },
      ];
    }
    const types = new Set(staple.types);
    const offers = listings
      .filter((l) => WORTH_SHOWING.has(l.status) && l.variants.some((v) => types.has(v.typeId)))
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
        textOffers: [],
        clearances: clearances.slice(0, MAX_CLEARANCES_PER_STAPLE),
        offerCount: offers.length,
        clearanceCount: clearances.length,
      },
    ];
  });
}
