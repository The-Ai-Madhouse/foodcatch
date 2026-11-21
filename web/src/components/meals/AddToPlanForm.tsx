"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { addToPlanFromCatalogue, type AddToPlanState } from "@/app/actions";

const INITIAL: AddToPlanState = { status: "idle", seq: 0 };

/** "Føj til madplan" with a confirmation, so the click visibly does something. */
export function AddToPlanForm({
  recipeId,
  name,
  days,
}: {
  recipeId: string;
  name: string;
  days: readonly { date: string; label: string }[];
}) {
  const [state, action, pending] = useActionState(addToPlanFromCatalogue, INITIAL);
  const label = days.find((d) => d.date === state.date)?.label ?? state.date;
  const box = useRef<HTMLDivElement>(null);
  // A click before the page has hydrated submits natively and reloads it with the card closed;
  // reopen the card and bring the answer into view so the add never looks like it did nothing.
  useEffect(() => {
    if (state.status === "idle" || !box.current) return;
    const card = box.current.closest("details");
    if (card && !card.open) card.open = true;
    box.current.scrollIntoView({ block: "nearest" });
  }, [state.status, state.seq]);
  return (
    <div ref={box} className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
      <form action={action} className="flex flex-wrap items-center gap-2 text-meta">
        <input type="hidden" name="ret" value={recipeId} />
        <label className="flex items-center gap-2 text-ink-2">
          Føj til madplan:
          <select
            name="dato"
            className="h-10 rounded-[10px] border border-line-strong bg-surface px-2 text-ink"
          >
            {days.map((d) => (
              <option key={d.date} value={d.date}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-[10px] bg-brand px-4 font-medium text-page disabled:opacity-60"
        >
          {pending ? "Tilføjer …" : "Tilføj"}
        </button>
      </form>
      <p aria-live="polite" className="mt-1 min-h-5 text-micro">
        {state.status === "added" ? (
          <span key={state.seq} className="font-medium text-good-fg">
            ✓ {name} er lagt på {label?.toLocaleLowerCase("da-DK")} ({state.count}{" "}
            {state.count === 1 ? "ret" : "retter"} den dag).{" "}
            <Link href="/madideer/madplan">Se madplanen →</Link>
          </span>
        ) : state.status === "full" ? (
          <span className="text-bad-fg">
            {label} har allerede {state.count} retter – fjern en i madplanen først.
          </span>
        ) : state.status === "error" ? (
          <span className="text-bad-fg">Det gik ikke. Prøv igen.</span>
        ) : null}
      </p>
    </div>
  );
}
