"use client";

import { useActionState, useState, useTransition } from "react";
import {
  importRecipeAction,
  quoteRecipeAction,
  readIngredientAction,
  type EditorIngredient,
  type ImportState,
  type PricesResult,
  type QuoteView,
} from "@/app/opskrift/actions";
import { ChainDot } from "@/components/ChainDot";
import { ChevronIcon } from "@/components/Icons";
import { SourcedPrice } from "@/components/SourcedPrice";
import { displayTitle, formatDistance, formatDkk } from "@/lib/format";

const INITIAL: ImportState = {
  status: "idle",
  message: "",
  url: "",
  title: null,
  servings: null,
  ingredients: [],
  seq: 0,
};

const KIND: Readonly<Record<string, string>> = {
  regular: "Normalpris",
  offer: "Tilbud",
  clearance: "Madspild",
};

/**
 * "Fra link" (docs/ui.md §27): paste a recipe link, check the ingredients we read (remove, add,
 * tick what you have), then see what it costs in each store nearby and combined.
 */
export function RecipeImporter() {
  const [state, importAction, importing] = useActionState(importRecipeAction, INITIAL);
  return (
    <div>
      <form
        action={importAction}
        className="mt-4 rounded-xl border border-line bg-surface p-3 lg:p-4"
      >
        <label htmlFor="opskrift-url" className="font-medium text-ink">
          1. Indsæt link til en opskrift
        </label>
        <p className="text-micro text-ink-3">
          Fx fra Valdemarsro, Arla, HelloFresh, Mummum, DR eller en madblog.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            id="opskrift-url"
            name="url"
            type="url"
            inputMode="url"
            required
            defaultValue={state.url}
            placeholder="https://…"
            autoComplete="off"
            className="h-11 min-w-0 flex-1 rounded-[10px] border border-line-strong bg-surface px-3 text-ink placeholder:text-ink-3"
          />
          <button
            type="submit"
            disabled={importing}
            className="inline-flex h-11 shrink-0 items-center rounded-[10px] bg-brand px-4 font-semibold text-page hover:opacity-90 disabled:opacity-60"
          >
            {importing ? "Henter …" : "Hent"}
          </button>
        </div>
        {state.status === "error" ? (
          <p role="alert" className="mt-2 text-meta text-bad-fg">
            {state.message}
          </p>
        ) : null}
      </form>
      {state.status !== "idle" ? (
        // Remount on every import, so the editor starts from the new list.
        <Editor key={state.seq} state={state} />
      ) : null}
    </div>
  );
}

function Editor({ state }: { state: ImportState }) {
  const [items, setItems] = useState<EditorIngredient[]>(state.ingredients);
  const [have, setHave] = useState<ReadonlySet<string>>(
    () => new Set(state.ingredients.filter((i) => i.atHome).map((i) => i.id)),
  );
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<PricesResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [adding, startAdding] = useTransition();

  const toggleHave = (id: string) => {
    const next = new Set(have);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHave(next);
    setResult(null);
  };
  const remove = (id: string) => {
    setItems(items.filter((i) => i.id !== id));
    setResult(null);
  };
  const add = () => {
    const line = draft.trim();
    if (!line) return;
    startAdding(async () => {
      const item = await readIngredientAction(line, items.length + (Date.now() % 1000));
      setItems((cur) => [...cur, item]);
      setDraft("");
      setResult(null);
    });
  };
  const toBuy = items.filter((i) => !have.has(i.id));
  const quote = () =>
    startTransition(async () => {
      setResult(await quoteRecipeAction(toBuy.map((i) => i.line)));
    });

  return (
    <>
      <section
        aria-labelledby="trin-ingredienser"
        className="mt-4 rounded-xl border border-line bg-surface p-3 lg:p-4"
      >
        <h2 id="trin-ingredienser" className="font-medium text-ink">
          2. Tjek ingredienserne
        </h2>
        {state.title ? (
          <p className="text-meta text-ink-2">
            <strong className="text-ink">{state.title}</strong>
            {state.servings ? ` · ${state.servings} pers.` : ""} · {items.length} ingredienser
          </p>
        ) : null}
        <p className="text-micro text-ink-3">
          Fjern det, du ikke vil bruge, sæt hak ved det, du har, og tilføj det, der mangler.
        </p>
        <ul className="mt-2 divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 py-2">
              <input
                type="checkbox"
                checked={have.has(item.id)}
                onChange={() => toggleHave(item.id)}
                aria-label={`Har jeg: ${item.line}`}
                className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
              />
              <span className="min-w-0 flex-1">
                <span className={have.has(item.id) ? "text-ink-3 line-through" : "text-ink"}>
                  {item.line}
                </span>
                <span className="block text-micro text-ink-3">
                  {have.has(item.id) ? "Har jeg – købes ikke" : `Søges som: ${item.lookFor}`}
                </span>
              </span>
              <button
                type="button"
                onClick={() => remove(item.id)}
                className="min-h-9 shrink-0 text-micro font-medium text-link underline-offset-2 hover:underline"
              >
                Fjern<span className="sr-only"> {item.line}</span>
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          className="mt-2 flex gap-2"
        >
          <label htmlFor="ny-ingrediens" className="sr-only">
            Tilføj ingrediens
          </label>
          <input
            id="ny-ingrediens"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Tilføj, fx 500 g kartofler"
            className="h-11 min-w-0 flex-1 rounded-[10px] border border-line-strong bg-surface px-3 text-ink placeholder:text-ink-3"
          />
          <button
            type="submit"
            disabled={adding || !draft.trim()}
            className="inline-flex h-11 shrink-0 items-center rounded-[10px] border border-line-strong px-3 font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
          >
            Tilføj
          </button>
        </form>
        <button
          type="button"
          onClick={quote}
          disabled={pending || toBuy.length === 0}
          className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-[10px] bg-brand px-4 font-semibold text-page hover:opacity-90 disabled:opacity-60"
        >
          {pending
            ? "Finder priser …"
            : `Videre: find priser på ${toBuy.length} ${toBuy.length === 1 ? "vare" : "varer"}`}
        </button>
      </section>
      {result ? <Prices result={result} /> : null}
    </>
  );
}

function Prices({ result }: { result: PricesResult }) {
  if (!result.combined || result.stores.length === 0) {
    return (
      <p className="mt-4 rounded-xl border border-line bg-surface p-4 text-meta text-ink-2">
        Vi fandt ingen af varerne i butikkerne nær dig. Prøv en større afstand.
      </p>
    );
  }
  const best = result.stores[0];
  return (
    <section aria-labelledby="trin-priser" className="mt-4">
      <h2 id="trin-priser" className="font-medium text-ink">
        3. Hvad det koster
      </h2>
      <p className="text-micro text-ink-3">
        Hele pakninger af det, du mangler, til dagens priser i butikkerne nær dig. Butikker med
        flest af varerne står først.
      </p>
      <div className="mt-2 space-y-3">
        <QuoteCard quote={result.combined} count={result.count} highlight />
        {result.stores.map((q) => (
          <QuoteCard key={q.chainId} quote={q} count={result.count} recommended={q === best} />
        ))}
      </div>
    </section>
  );
}

function QuoteCard({
  quote,
  count,
  highlight,
  recommended,
}: {
  quote: QuoteView;
  count: number;
  highlight?: boolean;
  recommended?: boolean;
}) {
  const found = count - quote.missing;
  return (
    <details
      className={`group/q rounded-xl border bg-surface ${highlight ? "border-brand" : "border-line"}`}
      open={highlight}
    >
      <summary className="flex cursor-pointer items-start gap-3 p-3 lg:p-4">
        {quote.chainId ? (
          <ChainDot chainId={quote.chainId} size="md" />
        ) : (
          <span className="flex -space-x-1">
            {quote.chains.slice(0, 3).map((c) => (
              <ChainDot key={c} chainId={c} size="sm" />
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 font-semibold text-ink">
            {quote.title}
            {recommended ? (
              <span className="rounded-md bg-good-bg px-1.5 py-px text-micro font-medium text-good-fg">
                Bedst i én butik
              </span>
            ) : null}
          </span>
          <span className="block text-micro text-ink-3">
            {quote.store ? `${quote.store} · ${formatDistance(quote.distanceKm ?? 0)} · ` : ""}
            {quote.chainId == null && quote.chains.length > 1
              ? `${quote.chains.length} butikker · `
              : ""}
            {quote.missing === 0
              ? count === 1
                ? "1 vare"
                : `alle ${count} varer`
              : `${found} af ${count} varer – mangler ${quote.missing}`}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-title shelf text-ink">{formatDkk(quote.totalKr)}</span>
          <ChevronIcon className="ml-auto details-chevron text-ink-3" />
        </span>
      </summary>
      <ul className="divide-y divide-line border-t border-line px-3 lg:px-4">
        {quote.lines.map((l, i) => (
          <li key={i} className="flex items-start justify-between gap-3 py-2 text-meta">
            <span className="min-w-0">
              <span className="block text-ink">{l.line}</span>
              {l.product ? (
                <span className="block text-micro text-ink-2">
                  <SourcedPrice source={l.source}>{displayTitle(l.product)}</SourcedPrice>
                  {" · "}
                  {quote.chainId == null && l.chain ? `${l.chain} · ` : ""}
                  {KIND[l.kind ?? ""] ?? ""}
                  {l.pack ? ` · ${l.pack}` : ""}
                  {l.onePack ? " · 1 pakning (mængden kunne ikke sammenlignes)" : ""}
                </span>
              ) : (
                <span className="block text-micro text-warn-fg">Ikke fundet i butikken</span>
              )}
            </span>
            <span className="shrink-0 font-medium text-ink tabular">
              {l.purchaseKr != null ? (
                <SourcedPrice source={l.source}>{formatDkk(l.purchaseKr)}</SourcedPrice>
              ) : (
                "–"
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
