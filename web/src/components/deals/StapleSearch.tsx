"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { addStaple } from "@/app/actions";
import {
  MAX_STAPLES,
  MIN_TEXT_LENGTH,
  normalizeStapleText,
  searchStaples,
} from "@/lib/staple-catalogue";

function AddButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex min-h-11 w-full items-center gap-2 rounded-[10px] px-2 text-left text-ink hover:bg-surface-2 disabled:opacity-60"
    >
      <span aria-hidden="true" className="font-semibold text-brand">
        +
      </span>
      {children}
    </button>
  );
}

/**
 * "Find flere basisvarer" (docs/ui.md §18): search every recognized product type, or follow the
 * typed text as a free-text staple. Each hit is a small form posting to the `addStaple` server
 * action, which updates the cookie and re-renders the page.
 */
export function StapleSearch({ selected }: { selected: readonly string[] }) {
  const [query, setQuery] = useState("");
  const hits = searchStaples(query, selected);
  const text = normalizeStapleText(query);
  const exact = hits.some((h) => h.label.toLocaleLowerCase("da-DK") === text);
  const followed = text != null && selected.includes(`q:${text}`);
  const full = selected.length >= MAX_STAPLES;

  async function add(formData: FormData) {
    await addStaple(formData);
    setQuery("");
  }

  return (
    <div className="border-t border-line py-3">
      <label htmlFor="basisvare-soeg" className="text-meta font-medium text-ink">
        Find flere basisvarer
      </label>
      <input
        id="basisvare-soeg"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Fx kylling, linser eller rugbrød"
        autoComplete="off"
        disabled={full}
        className="mt-1 h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-ink placeholder:text-ink-3"
      />
      {full ? (
        <p className="mt-1 text-micro text-ink-3">
          Du følger {MAX_STAPLES} basisvarer, som er det højeste antal. Fjern nogle ovenfor først.
        </p>
      ) : query.trim() ? (
        <ul aria-label="Forslag" className="mt-1">
          {hits.map((h) => (
            <li key={h.id}>
              <form action={add}>
                <input type="hidden" name="basisvare" value={h.id} />
                <AddButton>
                  <span>{h.label}</span>
                  <span className="text-micro text-ink-3">{h.group}</span>
                </AddButton>
              </form>
            </li>
          ))}
          {text && !exact && !followed ? (
            <li>
              <form action={add}>
                <input type="hidden" name="fritekst" value={text} />
                <AddButton>
                  <span>
                    Følg “{text}” som fritekst
                    <span className="block text-micro text-ink-3">
                      Alle tilbud, hvor navnet indeholder “{text}”, uden prisdom
                    </span>
                  </span>
                </AddButton>
              </form>
            </li>
          ) : null}
          {hits.length === 0 && !text ? (
            <li className="py-2 text-micro text-ink-3">Skriv mindst {MIN_TEXT_LENGTH} tegn.</li>
          ) : null}
          {followed && hits.length === 0 ? (
            <li className="py-2 text-micro text-ink-3">Du følger allerede “{text}”.</li>
          ) : null}
        </ul>
      ) : (
        <p className="mt-1 text-micro text-ink-3">
          Søg blandt alle varetyper, vi genkender. Finder du ikke varen (fx rugbrød eller kaffe),
          kan du følge den som fritekst: så ser du tilbud, hvis navnet indeholder ordet, men uden
          prisdom.
        </p>
      )}
    </div>
  );
}
