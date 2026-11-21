"use client";

import { SourcedPrice } from "@/components/SourcedPrice";
import { formatDkk } from "@/lib/format";
import { checklistTotals } from "@/lib/checklist";
import { portions } from "@/lib/people";
import type { PriceSource } from "@/lib/sources";
import { useChecklistState } from "./checklist-state";

export interface ChecklistRow {
  key: string;
  /** Which {@link ChecklistGroup} it is listed under. */
  group: string;
  /** Danish name ("Hakket oksekød"). */
  label: string;
  /** Amount the dish uses ("500 g"). */
  amount: string;
  /** What the user pays for it if they buy it (kr.). */
  payKr: number;
  /**
   * What the amount the dish uses costs (kr.), shown instead of `payKr` when the item is ticked
   * as "har jeg". Without it a ticked row is simply struck through.
   */
  portionKr?: number;
  /** True when `payKr` is an estimate. */
  approx: boolean;
  /** Where `payKr` can be checked (the offer/clearance, or "skøn"). */
  source?: PriceSource | null;
  /** Short line under the name ("Tilbud i Netto", "normalpris"). */
  note?: string;
  /** Pre-ticked as "har jeg" (basics expected at home). */
  defaultHave: boolean;
  /** The prices: rendered on the server. */
  detail?: React.ReactNode;
}

export interface ChecklistGroup {
  group: string;
  /** Heading of the group (may hold a store popover). */
  title: React.ReactNode;
  hint?: string;
}

const RECIPE_GROUPS: readonly ChecklistGroup[] = [
  { group: "ingredient", title: "Ingredienser" },
  { group: "buy", title: "Også til retten" },
  { group: "basic", title: "Basisvarer", hint: "forventes at være i køkkenet" },
];

/**
 * The shopping list of one dish: tick what you already have, or remove an ingredient you do not
 * want in the dish (it stays listed and can be put back); the totals follow. Remembered per dish
 * in this browser.
 */
export function ShoppingChecklist({
  recipeId,
  rows,
  groups = RECIPE_GROUPS,
  servings,
  people = null,
  whole = "retten",
}: {
  /** What the ticks are remembered under (a recipe id, or `madplan`). */
  recipeId: string;
  rows: readonly ChecklistRow[];
  groups?: readonly ChecklistGroup[];
  /** Servings of the dish (or plan): shows what the food costs (and per person) under the total. */
  servings?: number;
  /** How many people the user cooks for: days the food lasts and the price per day instead. */
  people?: number | null;
  /** What a removed row is removed from ("retten", "madplanen"). */
  whole?: string;
}) {
  const defaults = rows.filter((r) => r.defaultHave).map((r) => r.key);
  const { have, removed, toggleHave, toggleRemoved, reset } = useChecklistState(recipeId, defaults);
  const totals = checklistTotals(rows, have, removed);
  const withPortions = rows.every((r) => r.portionKr != null);
  const share =
    servings && people != null && people < servings
      ? portions(servings, people, totals.dishKr)
      : null;

  return (
    <div>
      {groups.map(({ group, title, hint }) => {
        const list = rows.filter((r) => r.group === group);
        if (list.length === 0) return null;
        return (
          <section key={group} className="mt-3">
            <h4 className="text-micro font-semibold text-ink-3 uppercase">
              {title}
              {hint ? <span className="font-normal normal-case"> · {hint}</span> : null}
            </h4>
            <ul className="mt-1 divide-y divide-line">
              {list.map((r) => {
                const gone = removed.has(r.key);
                const checked = !gone && have.has(r.key);
                // At home: what the dish uses of it, instead of the pack price.
                const portion = checked && r.portionKr != null;
                return (
                  <li key={r.key} className={`py-2 ${gone ? "opacity-70" : ""}`}>
                    <div className="flex items-start gap-3">
                      <label
                        className={`flex min-h-11 min-w-0 flex-1 items-start gap-3 ${gone ? "" : "cursor-pointer"}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={gone}
                          onChange={() => toggleHave(r.key)}
                          className="mt-1 size-5 shrink-0 accent-[var(--brand)] disabled:opacity-40"
                          aria-label={`Har jeg: ${r.label}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={`font-medium ${gone || checked ? "text-ink-3 line-through" : "text-ink"}`}
                          >
                            {r.label}
                          </span>{" "}
                          <span className="text-meta text-ink-3 tabular">{r.amount}</span>
                          {gone ? (
                            <span className="block text-micro text-ink-3">
                              Fjernet fra {whole} – tæller ikke med
                            </span>
                          ) : r.note ? (
                            <span className="block text-micro text-ink-3">{r.note}</span>
                          ) : null}
                        </span>
                      </label>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        {gone ? (
                          <span className="text-meta text-ink-3 tabular line-through">
                            {formatDkk(r.payKr)}
                          </span>
                        ) : portion ? (
                          <span className="text-right text-meta text-ink-2 tabular">
                            {r.approx ? "ca. " : ""}
                            <SourcedPrice source={r.source}>
                              {formatDkk(r.portionKr ?? 0)}
                            </SourcedPrice>
                            <span className="block text-micro text-ink-3">retten bruger</span>
                          </span>
                        ) : (
                          <span className="text-meta font-medium text-ink tabular">
                            {r.approx ? "ca. " : ""}
                            <SourcedPrice source={r.source}>{formatDkk(r.payKr)}</SourcedPrice>
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleRemoved(r.key)}
                          aria-pressed={gone}
                          className="min-h-8 text-micro font-medium text-link underline-offset-2 hover:underline"
                        >
                          {gone ? "Fortryd" : "Fjern"}
                          <span className="sr-only">
                            {gone
                              ? ` – brug ${r.label} i ${whole} igen`
                              : ` ${r.label} fra ${whole}`}
                          </span>
                        </button>
                      </span>
                    </div>
                    {r.detail && !checked && !gone ? <div className="pl-8">{r.detail}</div> : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <div
        className="sticky bottom-16 mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 md:bottom-2"
        aria-live="polite"
      >
        <div className="text-meta text-ink-2">
          <p>
            {totals.toBuy === 0 ? (
              <span className="font-medium text-good-fg">Du har det hele ✓</span>
            ) : (
              <>
                Indkøb, {totals.toBuy} {totals.toBuy === 1 ? "vare" : "varer"}:{" "}
                <strong className="text-ink tabular">
                  {totals.purchaseApprox ? "ca. " : ""}
                  {formatDkk(totals.purchaseKr)}
                </strong>
              </>
            )}
          </p>
          {servings && withPortions ? (
            <p className="text-micro tabular">
              Retten {totals.dishApprox ? "ca. " : ""}
              {formatDkk(totals.dishKr)} ·{" "}
              {share?.days != null
                ? `${share.days} ${share.days === 1 ? "dag" : "dage"} for ${people === 1 ? "1 person" : `${people} pers.`} · ${formatDkk(share.perDayKr)} pr. dag`
                : `${formatDkk(totals.dishKr / Math.max(1, servings))} pr. pers.`}
              {totals.removed > 0 ? ` · ${totals.removed} fjernet` : ""}
            </p>
          ) : totals.removed > 0 ? (
            <p className="text-micro">
              {totals.removed} fjernet fra {whole}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={reset}
          className="min-h-9 shrink-0 text-micro text-link underline-offset-2 hover:underline"
        >
          Nulstil
        </button>
      </div>
    </div>
  );
}
