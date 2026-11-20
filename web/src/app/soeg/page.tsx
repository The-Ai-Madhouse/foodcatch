import type { Metadata, Route } from "next";
import Link from "next/link";
import { ChainDot } from "@/components/ChainDot";
import { Notice } from "@/components/Notice";
import { chainName } from "@/lib/chains";
import {
  displayTitle,
  formatDkk,
  formatShortPeriod,
  formatUnitPriceRange,
  packSize,
} from "@/lib/format";
import { productKindLabel } from "@/lib/product";
import { productPath } from "@/lib/routes";
import {
  MAX_RESULTS,
  MIN_QUERY_LENGTH,
  type SearchHit,
  isCurrent,
  parseSearchQuery,
  searchTerms,
  sortHits,
} from "@/lib/search";
import { searchProducts } from "@/server/queries";

export async function generateMetadata({ searchParams }: PageProps<"/soeg">): Promise<Metadata> {
  const q = parseSearchQuery((await searchParams).q);
  return { title: q ? `Søg: ${q}` : "Søg vare" };
}

const sep = <span aria-hidden="true"> · </span>;

/** One item: name, chain, latest price and size, and how many prices its history holds. */
function HitRow({ hit, now }: { hit: SearchHit; now: Date }) {
  const current = isCurrent(hit, now);
  const size = packSize({
    unit: hit.latestUnit,
    sizeMin: hit.latestSizeMin,
    sizeMax: hit.latestSizeMax,
    source: hit.latestSource,
    description: null,
  });
  const unitPrice = formatUnitPriceRange(
    hit.latestUnitPriceMin,
    hit.latestUnitPriceMax,
    hit.latestUnit,
  );
  const period =
    hit.latestKind === "regular" && hit.latestValidTo == null
      ? null
      : formatShortPeriod(hit.latestValidFrom, hit.latestValidTo);
  return (
    <Link
      href={productPath(hit.productKey) as Route}
      className="flex items-start justify-between gap-3 px-4 py-3 text-ink no-underline hover:bg-surface-2"
    >
      <div className="min-w-0">
        <p className="font-medium text-ink">{displayTitle(hit.label)}</p>
        <p className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
          <ChainDot chainId={hit.chainId} size="xs" />
          <span>{hit.chainName || chainName(hit.chainId)}</span>
          {hit.latestPrice != null ? (
            <>
              {sep}
              <span className="font-bold text-ink tabular">{formatDkk(hit.latestPrice)}</span>
            </>
          ) : null}
          {sep}
          <span>{size.text}</span>
          {unitPrice ? (
            <>
              {sep}
              <span className="whitespace-nowrap tabular">{unitPrice}</span>
            </>
          ) : null}
        </p>
        <p className="text-micro text-ink-3">
          {hit.latestKind ? productKindLabel(hit.latestKind) : "Pris"}
          {period ? ` ${period}` : ""}
          {current ? "" : " (udløbet)"}
        </p>
      </div>
      <span className="shrink-0 text-meta whitespace-nowrap text-link">
        {hit.priceCount} {hit.priceCount === 1 ? "pris" : "priser"} →
      </span>
    </Link>
  );
}

/**
 * "Søg vare" (docs/ui.md §16): find any item FoodCatch has a price for, of every chain and also
 * outside the healthy staples, and open its price history.
 */
export default async function SearchPage({ searchParams }: PageProps<"/soeg">) {
  const query = parseSearchQuery((await searchParams).q);
  const terms = searchTerms(query);
  const now = new Date();
  const hits = sortHits(await searchProducts(terms), now);
  const currentCount = hits.filter((h) => isCurrent(h, now)).length;

  return (
    <div className="mx-auto max-w-[760px]">
      <h1 className="text-display shelf text-ink">Søg vare</h1>
      <p className="text-meta text-ink-2">
        Find en vilkårlig vare fra tilbudsaviser, REMA 1000-sortimentet og madspild, og se dens
        prishistorik.
      </p>
      <form action="/soeg" method="get" role="search" className="mt-3 flex gap-2">
        <label htmlFor="soeg-felt" className="sr-only">
          Varenavn
        </label>
        <input
          id="soeg-felt"
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Fx rugbrød, faxe kondi eller hakket oksekød"
          minLength={MIN_QUERY_LENGTH}
          maxLength={60}
          autoComplete="off"
          enterKeyHint="search"
          className="h-11 min-w-0 flex-1 rounded-[10px] border border-line-strong bg-surface px-3 text-ink placeholder:text-ink-3"
        />
        <button
          type="submit"
          className="inline-flex h-11 shrink-0 items-center rounded-[10px] bg-brand px-4 font-semibold text-page hover:opacity-90"
        >
          Søg
        </button>
      </form>

      <div className="mt-4">
        {query && terms.length === 0 ? (
          <Notice>Skriv mindst {MIN_QUERY_LENGTH} tegn.</Notice>
        ) : !query ? (
          <p className="text-meta text-ink-3">
            Alle ord skal indgå i varenavnet. Samme vare i forskellige pakningsstørrelser vises hver
            for sig.
          </p>
        ) : hits.length === 0 ? (
          <Notice title="Ingen varer fundet">
            Vi har ingen pris på en vare, der hedder noget med “{query}”. Prøv et kortere ord.
          </Notice>
        ) : (
          <>
            <p className="mb-2 text-meta text-ink-2" aria-live="polite">
              {hits.length === MAX_RESULTS ? `De ${MAX_RESULTS} nyeste` : hits.length}{" "}
              {hits.length === 1 ? "vare" : "varer"}, {currentCount} med en aktuel pris.
            </p>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {hits.map((hit) => (
                <li key={hit.productKey}>
                  <HitRow hit={hit} now={now} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
