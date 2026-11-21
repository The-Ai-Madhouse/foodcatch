/**
 * The totals of a dish's shopping list (docs/ui.md §25), from what the user ticked as "har jeg"
 * and what they removed from the dish. Pure, so the card's headline and the list agree.
 *
 * - removed: not used in the dish at all; counts in neither total, but stays visible;
 * - at home ("har jeg"): not bought, but the amount the dish uses still counts in the dish price;
 * - otherwise: bought (the pack price), and its used amount counts in the dish price.
 */

export interface ChecklistPriceRow {
  key: string;
  /** What buying it costs (kr.). */
  payKr: number;
  /** What the amount the dish uses costs (kr.); `payKr` when unknown. */
  portionKr?: number;
  /** The prices are an estimate. */
  approx: boolean;
}

export interface ChecklistTotals {
  /** Rows still to buy. */
  toBuy: number;
  /** What they cost (kr.). */
  purchaseKr: number;
  purchaseApprox: boolean;
  /** What the used amounts of the rows not removed cost (kr.). */
  dishKr: number;
  dishApprox: boolean;
  /** Rows removed from the dish. */
  removed: number;
}

const roundKr = (value: number): number => Math.round(value * 100) / 100;

export function checklistTotals(
  rows: readonly ChecklistPriceRow[],
  have: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): ChecklistTotals {
  const kept = rows.filter((r) => !removed.has(r.key));
  const buy = kept.filter((r) => !have.has(r.key));
  return {
    toBuy: buy.length,
    purchaseKr: roundKr(buy.reduce((sum, r) => sum + r.payKr, 0)),
    purchaseApprox: buy.some((r) => r.approx),
    dishKr: roundKr(kept.reduce((sum, r) => sum + (r.portionKr ?? r.payKr), 0)),
    dishApprox: kept.some((r) => r.approx),
    removed: rows.length - kept.length,
  };
}
