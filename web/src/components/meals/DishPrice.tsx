"use client";

import { checklistTotals, type ChecklistPriceRow } from "@/lib/checklist";
import { formatDkk } from "@/lib/format";
import { portions } from "@/lib/people";
import { useChecklistState } from "./checklist-state";

/**
 * The card's headline (docs/ui.md §23, §25): the purchase price first, then what the dish costs
 * and per person. Follows the shopping list: ticking "har jeg" or removing an ingredient changes
 * it. Server rendering shows the defaults (basics at home, nothing removed).
 */
export function DishPrice({
  recipeId,
  rows,
  servings,
  people = null,
  children,
}: {
  recipeId: string;
  rows: readonly (ChecklistPriceRow & { defaultHave: boolean })[];
  servings: number;
  /** How many people the user cooks for; null shows the price per person. */
  people?: number | null;
  /** Shown next to the purchase price (the saving tag). */
  children?: React.ReactNode;
}) {
  const defaults = rows.filter((r) => r.defaultHave).map((r) => r.key);
  const { have, removed } = useChecklistState(recipeId, defaults);
  const t = checklistTotals(rows, have, removed);
  const ca = t.dishApprox ? "ca. " : "";
  const share = people != null && people !== servings ? portions(servings, people, t.dishKr) : null;
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-ink">
          <span className="text-meta text-ink-2">Indkøb </span>
          <span className="text-price shelf">
            {t.purchaseApprox ? <span className="text-title">ca. </span> : null}
            {formatDkk(t.purchaseKr)}
          </span>
        </span>
        {children}
      </div>
      <p className="mt-0.5 text-meta text-ink-2 tabular">
        Retten {ca}
        {formatDkk(t.dishKr)}
        {share?.days != null ? (
          <>
            {" "}
            · rækker til{" "}
            <strong className="font-semibold text-ink">
              {share.days} {share.days === 1 ? "dag" : "dage"}
            </strong>{" "}
            for {people === 1 ? "1 person" : `${people} pers.`} · {ca}
            {formatDkk(share.perDayKr)} pr. dag
          </>
        ) : share?.times != null ? (
          <>
            {" "}
            · til {servings} pers. – lav den {String(share.times).replace(".", ",")} gange til{" "}
            {people}: {ca}
            {formatDkk(share.perDayKr)} (indkøbet ovenfor er til én gang)
          </>
        ) : (
          <> · {formatDkk(t.dishKr / Math.max(1, servings))} pr. pers.</>
        )}
        <span className="text-ink-3">
          {t.removed > 0
            ? ` – ${t.removed} ${t.removed === 1 ? "ingrediens" : "ingredienser"} fjernet`
            : share
              ? ""
              : " – det, retten bruger af varerne"}
        </span>
      </p>
      {share?.freeze ? (
        <p className="text-micro text-ink-3">Frys en del: rester bør spises inden for 2–3 dage.</p>
      ) : null}
    </>
  );
}
