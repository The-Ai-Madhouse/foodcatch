import type { Metadata, Route } from "next";
import Link from "next/link";
import { SourcedPrice } from "@/components/SourcedPrice";
import { priceSource } from "@/lib/sources";
import { ChainDot } from "@/components/ChainDot";
import { Notice } from "@/components/Notice";
import { chainName } from "@/lib/chains";
import {
  displayTitle,
  formatDkk,
  formatShortPeriod,
  formatUnitPriceRange,
  packSize,
  unitLabel,
} from "@/lib/format";
import { productKindLabel } from "@/lib/product";
import { productPath } from "@/lib/routes";
import {
  MAX_RESULTS,
  MIN_QUERY_LENGTH,
  type SearchHit,
  groupHits,
  hitTiming,
  parseSearchQuery,
  searchTerms,
  sortHits,
} from "@/lib/search";
import { ChevronIcon } from "@/components/Icons";
import { SavingTag } from "@/components/SavingTag";
import { StoreInfo } from "@/components/StoreInfo";
import { cleanClassLabel, evaluateDeals, groupByListing } from "@/lib/deals";
import { listingSaving, type Saving } from "@/lib/savings";
import { chainPins, nearestByChain, type NearbyStore } from "@/lib/stores";
import { getUserLocation } from "@/server/location";
import { getCurrentDeals, getNearbyStores, searchProducts } from "@/server/queries";

export async function generateMetadata({ searchParams }: PageProps<"/soeg">): Promise<Metadata> {
  const q = parseSearchQuery((await searchParams).q);
  return { title: q ? `Søg: ${q}` : "Søg" };
}

const sep = <span aria-hidden="true"> · </span>;

/** What the search page knows about the user's surroundings. */
interface HitContext {
  now: Date;
  storesByChain: ReadonlyMap<string, readonly NearbyStore[]>;
  /** This week's offers by item key, for the saving against the normal price. */
  savings: ReadonlyMap<string, Saving>;
}

/** One item: name, where (store popover), price, size, unit price and the saving. */
function HitRow({ hit, ctx, cheapest }: { hit: SearchHit; ctx: HitContext; cheapest?: boolean }) {
  const timing = hitTiming(hit, ctx.now);
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
  const { pins, total } = chainPins(ctx.storesByChain, hit.chainId);
  const saving = hit.latestKind === "offer" ? ctx.savings.get(hit.productKey) : undefined;
  const source = priceSource(
    {
      source: hit.latestKind === "reference" ? "salling" : hit.latestSource,
      chainId: hit.chainId,
      sourceItemId: hit.latestSourceItemId ?? null,
      catalogId: hit.latestCatalogId ?? null,
      validTo: hit.latestValidTo,
      ean: hit.ean,
    },
    ctx.now,
  );
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="font-medium">
          <Link href={productPath(hit.productKey) as Route} className="text-ink">
            {displayTitle(hit.label)}
          </Link>
        </p>
        <p className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
          <StoreInfo chainId={hit.chainId} stores={pins} total={total}>
            <ChainDot chainId={hit.chainId} size="xs" />
            <span>{hit.chainName || chainName(hit.chainId)}</span>
          </StoreInfo>
          {pins.length === 0 ? <span className="text-ink-3">(ingen butik nær dig)</span> : null}
          {sep}
          <span>{size.text}</span>
          {hit.latestPrice != null ? (
            <>
              {sep}
              <SourcedPrice source={source} className="whitespace-nowrap tabular">
                {formatDkk(hit.latestPrice)}
              </SourcedPrice>
            </>
          ) : null}
        </p>
        <p className="text-micro text-ink-3">
          {hit.latestKind ? productKindLabel(hit.latestKind) : "Pris"}
          {period ? ` ${period}` : ""}
          {timing === "past" ? " (udløbet)" : ""}
          {sep}
          {hit.priceCount} {hit.priceCount === 1 ? "pris" : "priser"} i historikken
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {/* The unit price is what "cheapest" compares; the pack price is next to the size. */}
        {unitPrice ? (
          <SourcedPrice source={source} className="text-title shelf whitespace-nowrap text-ink">
            {unitPrice}
          </SourcedPrice>
        ) : hit.latestPrice != null ? (
          <SourcedPrice source={source} className="text-title shelf text-ink">
            {formatDkk(hit.latestPrice)}
          </SourcedPrice>
        ) : null}
        {cheapest ? (
          <span className="text-micro font-semibold text-good-fg">Billigst nær dig</span>
        ) : null}
        {saving ? <SavingTag saving={saving} size="sm" /> : null}
      </div>
    </div>
  );
}

function HitList({
  hits,
  ctx,
  first,
}: {
  hits: readonly SearchHit[];
  ctx: HitContext;
  first?: boolean;
}) {
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
      {hits.map((hit, i) => (
        <li key={hit.productKey}>
          <HitRow hit={hit} ctx={ctx} cheapest={first && i === 0} />
        </li>
      ))}
    </ul>
  );
}

/**
 * "Søg" (docs/ui.md §21): find any item FoodCatch has a price for and see where it is cheapest
 * now – nearby chains, cheapest unit price first, with the saving of an offer against the normal
 * price – then upcoming offers, then older prices.
 */
export default async function SearchPage({ searchParams }: PageProps<"/soeg">) {
  const query = parseSearchQuery((await searchParams).q);
  const terms = searchTerms(query);
  const now = new Date();
  const location = await getUserLocation();
  const [found, stores, deals] = await Promise.all([
    searchProducts(terms),
    getNearbyStores(location),
    terms.length ? getCurrentDeals() : Promise.resolve([]),
  ]);
  const hits = sortHits(found, now);
  const storesByChain = nearestByChain(stores);
  const nearbyChains = new Set(storesByChain.keys());
  const savings = new Map<string, Saving>();
  for (const listing of groupByListing(evaluateDeals(deals, nearbyChains))) {
    const key = listing.offer.productKey;
    if (key) savings.set(key, listingSaving(listing, nearbyChains));
  }
  const ctx: HitContext = { now, storesByChain, savings };
  const nowHits = hits.filter((h) => hitTiming(h, now) === "now");
  const groups = groupHits(nowHits, nearbyChains);
  const later = hits.filter((h) => hitTiming(h, now) === "later");
  const past = hits.filter((h) => hitTiming(h, now) === "past");

  return (
    <div className="mx-auto max-w-[760px]">
      <h1 className="text-display shelf text-ink">Søg</h1>
      <p className="text-meta text-ink-2">
        Find en vare og se, hvor den er billigst lige nu – og om den snart kommer på tilbud.
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

      <div className="mt-4 space-y-6">
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
            {later.length > 0 ? (
              <section aria-labelledby="kommer">
                <h2 id="kommer" className="text-heading font-semibold text-ink">
                  Kommer på tilbud ({later.length})
                </h2>
                <p className="mb-2 text-meta text-ink-2">
                  Fra aviser, der allerede er udkommet. Måske værd at vente på.
                </p>
                <HitList hits={later} ctx={ctx} />
              </section>
            ) : null}
            {nowHits.length === 0 ? (
              <Notice>Ingen af varerne har en aktuel pris.</Notice>
            ) : (
              groups.map((group) => (
                <section key={group.key} aria-label={cleanClassLabel(group.label)}>
                  <h2 className="text-heading font-semibold text-ink">
                    {cleanClassLabel(group.label)}
                  </h2>
                  <p className="mb-2 text-meta text-ink-2">
                    {group.hits.length === 1
                      ? "Én aktuel pris."
                      : group.unit
                        ? `${group.hits.length} aktuelle priser, billigst pr. ${unitLabel(group.unit)} først.`
                        : `${group.hits.length} aktuelle priser.`}
                  </p>
                  <HitList hits={group.hits} ctx={ctx} first={group.cheapestNearby} />
                </section>
              ))
            )}
            {hits.length === MAX_RESULTS ? (
              <p className="text-meta text-ink-3">Viser de {MAX_RESULTS} nyeste varer.</p>
            ) : null}
            {past.length > 0 ? (
              <details className="group/past">
                <summary className="flex h-11 items-center gap-1 text-meta font-medium text-ink-2">
                  Tidligere priser ({past.length})
                  <ChevronIcon className="details-chevron" />
                </summary>
                <HitList hits={past} ctx={ctx} />
              </details>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
