/**
 * Deal verdict (docs/architecture.md §6).
 *
 * Mirror of `pipeline/src/foodcatch/deals/verdict.py`; both implementations must pass the shared
 * cases in `fixtures/verdict_cases.json` at the repository root. Rules, in order:
 *
 * - `no_price` – Netto's worst unit price is unknown.
 * - `ambiguous_offer` – the offer price does not apply to this variant.
 * - `not_exact` – the variant has unknown key attributes.
 * - `no_reference` – no reference from a nearby chain (`history` and `ean_reference` count
 *   regardless of distance).
 * - `good_deal` – Netto's worst unit price <= the cheapest counted reference.
 * - `cheaper_elsewhere` – even Netto's best unit price > the cheapest counted reference.
 * - `undecided` – otherwise (Netto's pack sizes overlap the cheapest reference).
 *
 * The two comparisons use whole øre (half up, `toOre`): Rema publishes compare prices rounded to
 * øre (10 kr / 300 g -> 33.33) while Tjek unit prices have four decimals (33.3333), so an
 * identical price must not count as more expensive.
 */

export const VERDICTS = [
  "good_deal",
  "undecided",
  "cheaper_elsewhere",
  "no_reference",
  "not_exact",
  "ambiguous_offer",
  "no_price",
] as const;

export type Verdict = (typeof VERDICTS)[number];

export const REFERENCE_KINDS = ["offer", "regular", "history", "ean_reference"] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** Reference kinds that count no matter where the user is. */
export const LOCATION_INDEPENDENT_KINDS: ReadonlySet<ReferenceKind> = new Set([
  "history",
  "ean_reference",
]);

/** One same-class reference price (an element of `deal.references`). */
export interface Reference {
  kind: ReferenceKind;
  chain_id: string;
  unit_price: number;
  listing_id?: string | null;
  title?: string | null;
  unit?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
}

/** The verdict-relevant part of an `api.current_netto_deals` row. */
export interface DealInput {
  netto_unit_price_worst: number | null;
  netto_unit_price_best: number | null;
  price_applies: boolean;
  is_exact: boolean;
  references: readonly Reference[];
}

/** Verdict plus the facts behind it. */
export interface VerdictResult {
  verdict: Verdict;
  /** Cheapest counted reference unit price (null for the first four verdicts). */
  cheapest_unit_price: number | null;
  /** Number of references that counted (0 for the first four verdicts). */
  reference_count: number;
}

/** Whether a reference counts for a user whose nearby chains are `nearbyChains`. */
export function referenceCounts(ref: Reference, nearbyChains: ReadonlySet<string>): boolean {
  return LOCATION_INDEPENDENT_KINDS.has(ref.kind) || nearbyChains.has(ref.chain_id);
}

/**
 * `value` (kr.) in whole øre, rounded half up; mirrors `to_ore` in `verdict.py`.
 *
 * Unit prices have at most four decimals, so `value * 10000` is an integer up to float error;
 * integer arithmetic from there makes both implementations round identically.
 */
export function toOre(value: number): number {
  return Math.floor((Math.round(value * 10_000) + 50) / 100);
}

function none(verdict: Verdict): VerdictResult {
  return { verdict, cheapest_unit_price: null, reference_count: 0 };
}

/** Compute the verdict for `deal` given the chains that have a store near the user. */
export function verdict(deal: DealInput, nearbyChains: Iterable<string>): VerdictResult {
  const worst = deal.netto_unit_price_worst;
  if (worst == null) return none("no_price");
  if (!deal.price_applies) return none("ambiguous_offer");
  if (!deal.is_exact) return none("not_exact");

  const nearby = nearbyChains instanceof Set ? nearbyChains : new Set(nearbyChains);
  const counted = deal.references.filter((ref) => referenceCounts(ref, nearby));
  if (counted.length === 0) return none("no_reference");

  const cheapest = Math.min(...counted.map((ref) => ref.unit_price));
  const best = deal.netto_unit_price_best ?? worst;
  const result: Verdict =
    toOre(worst) <= toOre(cheapest)
      ? "good_deal"
      : toOre(best) > toOre(cheapest)
        ? "cheaper_elsewhere"
        : "undecided";
  return { verdict: result, cheapest_unit_price: cheapest, reference_count: counted.length };
}
