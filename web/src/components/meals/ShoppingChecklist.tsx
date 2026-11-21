"use client";

import { useEffect, useState } from "react";
import { SourcedPrice } from "@/components/SourcedPrice";
import { formatDkk } from "@/lib/format";
import type { PriceSource } from "@/lib/sources";

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

const storageKey = (id: string) => `fc_have:${id}`;

function readHave(recipeId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(storageKey(recipeId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function writeHave(recipeId: string, keys: readonly string[] | null): void {
  try {
    if (keys == null) window.localStorage.removeItem(storageKey(recipeId));
    else window.localStorage.setItem(storageKey(recipeId), JSON.stringify(keys));
  } catch {
    // Storage unavailable: the ticks last until the page is left.
  }
}

/**
 * The shopping list of one dish: tick what you already have, and the total of what is left to
 * buy follows. Ticks are remembered per dish in this browser.
 */
export function ShoppingChecklist({
  recipeId,
  rows,
  groups = RECIPE_GROUPS,
}: {
  /** What the ticks are remembered under (a recipe id, or `madplan`). */
  recipeId: string;
  rows: readonly ChecklistRow[];
  groups?: readonly ChecklistGroup[];
}) {
  const defaults = rows.filter((r) => r.defaultHave).map((r) => r.key);
  const [have, setHave] = useState<ReadonlySet<string>>(() => new Set(defaults));

  useEffect(() => {
    const stored = readHave(recipeId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only
    if (stored) setHave(new Set(stored));
  }, [recipeId]);

  const toggle = (key: string) => {
    const next = new Set(have);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setHave(next);
    writeHave(recipeId, [...next]);
  };
  const reset = () => {
    setHave(new Set(defaults));
    writeHave(recipeId, null);
  };

  const toBuy = rows.filter((r) => !have.has(r.key));
  const total = toBuy.reduce((sum, r) => sum + r.payKr, 0);
  const approx = toBuy.some((r) => r.approx);

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
                const checked = have.has(r.key);
                return (
                  <li key={r.key} className="py-2">
                    <label className="flex min-h-11 cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(r.key)}
                        className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
                        aria-label={`Har jeg: ${r.label}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`font-medium ${checked ? "text-ink-3 line-through" : "text-ink"}`}
                        >
                          {r.label}
                        </span>{" "}
                        <span className="text-meta text-ink-3 tabular">{r.amount}</span>
                        {r.note ? (
                          <span className="block text-micro text-ink-3">{r.note}</span>
                        ) : null}
                      </span>
                      <span
                        className={`shrink-0 text-meta tabular ${checked ? "text-ink-3 line-through" : "font-medium text-ink"}`}
                      >
                        {r.approx ? "ca. " : ""}
                        <SourcedPrice source={r.source}>{formatDkk(r.payKr)}</SourcedPrice>
                      </span>
                    </label>
                    {r.detail && !checked ? <div className="pl-8">{r.detail}</div> : null}
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
        <p className="text-meta text-ink-2">
          {toBuy.length === 0 ? (
            <span className="font-medium text-good-fg">Du har det hele ✓</span>
          ) : (
            <>
              Mangler {toBuy.length} {toBuy.length === 1 ? "vare" : "varer"}:{" "}
              <strong className="text-ink tabular">
                {approx ? "ca. " : ""}
                {formatDkk(Math.round(total))}
              </strong>
            </>
          )}
        </p>
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
