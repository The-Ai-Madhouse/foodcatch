"use client";

import type { Route } from "next";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChainDot } from "@/components/ChainDot";
import { ChevronIcon, CloseIcon } from "@/components/Icons";
import { ExternalLink, SourceLink } from "@/components/SourceLink";
import { SourcedPrice } from "@/components/SourcedPrice";
import { FoodWasteItemRow } from "@/components/foodwaste/FoodWasteItemRow";
import { OpenLocationButton } from "@/components/location/LocationControl";
import { chainName } from "@/lib/chains";
import type { FoodWasteItem } from "@/lib/foodwaste";
import { formatDistance } from "@/lib/format";
import type { Coordinates } from "@/lib/geo";
import {
  routeLink,
  storePageLink,
  type PriceSource,
  type SourceLink as SourceLinkData,
} from "@/lib/sources";
import { storeAddress, type MapStore } from "@/lib/stores";
import { LazyStoreMap } from "./LazyStoreMap";
import { useIsDesktop } from "./MapFocus";

/** An offer of another chain that a store's chain has cheaper, prepared on the server. */
export interface CheaperRow {
  key: string;
  title: string;
  /** `cheaper`: clearly cheaper; `maybe`: depends on the offer's pack size. */
  verdict: "cheaper" | "maybe";
  /** The chain that has it cheaper ("REMA 1000"). */
  chain: string;
  /** The product name at that chain, when known. */
  name: string | null;
  /** "500 g · 20,00 kr. · 40,00 kr./kg" (pack size, pack price, unit price). */
  facts: string;
  /** The chain whose offer it is ("Netto"). */
  offerChain: string;
  /** The offer's unit price (range). */
  offerPrice: string;
  link: SourceLinkData | null;
  /** Where the cheaper price can be checked. */
  source: PriceSource | null;
  /** Where the offer's own price can be checked. */
  offerSource: PriceSource | null;
}

type Snap = "peek" | "half" | "full";

const PEEK_PX = 88;
const MAX_FOOD_WASTE_ROWS = 5;

/** Keep `?kaede=` and `?butik=` in the address bar without a server round trip. */
function syncUrl(chains: ReadonlySet<string> | null, storeId: string | null) {
  const params = new URLSearchParams();
  if (chains && chains.size > 0) params.set("kaede", [...chains].join(","));
  if (storeId) params.set("butik", storeId);
  const query = params.toString();
  window.history.replaceState(null, "", query ? `/kort?${query}` : "/kort");
}

/**
 * /kort (docs/ui.md §6.3): every nearby store on the map, coloured by chain, with a chain filter
 * and a store list. Selecting a store shows its food waste, its chain's good buys this week,
 * and what is cheaper there than this week's offers of other chains. Phones: full-screen map with a bottom sheet; desktop: sidebar and map.
 */
export function MapExplorer({
  stores,
  user,
  radiusKm,
  foodWaste,
  cheaper,
  goodCounts,
  initialChains,
  initialStoreId,
  now,
}: {
  stores: MapStore[];
  user: Coordinates;
  radiusKm: number;
  foodWaste: Record<string, FoodWasteItem[]>;
  cheaper: Record<string, CheaperRow[]>;
  /** This week's good buys per chain. */
  goodCounts: Record<string, number>;
  initialChains: string[] | null;
  initialStoreId: string | null;
  now: string;
}) {
  const desktop = useIsDesktop();
  const [filters, setFilters] = useState<ReadonlySet<string> | null>(
    initialChains ? new Set(initialChains) : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(initialStoreId);
  // Open far enough to show the selected store, or "Skift afstand" when there are no stores.
  const [snap, setSnap] = useState<Snap>(initialStoreId || stores.length === 0 ? "half" : "peek");
  // The map area's height, so the map can keep the selected store above the bottom sheet.
  const mapAreaRef = useRef<HTMLDivElement>(null);
  const [mapAreaHeight, setMapAreaHeight] = useState(0);
  useEffect(() => {
    const element = mapAreaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setMapAreaHeight(Math.round(entry.contentRect.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const chains = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of stores) if (!seen.has(s.chainId)) seen.set(s.chainId, s.distanceKm);
    return [...seen.keys()];
  }, [stores]);
  const listed = useMemo(
    () => (filters ? stores.filter((s) => filters.has(s.chainId)) : stores),
    [stores, filters],
  );
  const selected = selectedId ? (stores.find((s) => s.id === selectedId) ?? null) : null;

  function select(id: string | null) {
    setSelectedId(id);
    if (id) setSnap((s) => (s === "peek" ? "half" : s));
    syncUrl(filters, id);
  }

  function toggleChain(chainId: string | null) {
    let next: Set<string> | null;
    if (chainId == null) next = null;
    else {
      next = new Set(filters ?? []);
      if (next.has(chainId)) next.delete(chainId);
      else next.add(chainId);
      if (next.size === 0) next = null;
    }
    setFilters(next);
    syncUrl(next, selectedId);
  }

  const chips =
    chains.length > 0 ? (
      <ChainChips chains={chains} filters={filters} onToggle={toggleChain} />
    ) : null;
  const panel = selected ? (
    <StoreDetail
      store={selected}
      items={foodWaste[selected.id] ?? []}
      cheaper={cheaper[selected.chainId] ?? []}
      goodCount={goodCounts[selected.chainId] ?? 0}
      now={now}
      onClose={() => select(null)}
    />
  ) : (
    <StoreList stores={listed} onSelect={select} radiusKm={radiusKm} />
  );
  const sheetHeight =
    snap === "peek" ? `${PEEK_PX}px` : snap === "half" ? "50%" : "calc(100% - 64px)";
  const sheetPx =
    snap === "peek"
      ? PEEK_PX
      : snap === "half"
        ? Math.round(mapAreaHeight / 2)
        : Math.max(mapAreaHeight - 64, 0);

  return (
    <div
      data-fullscreen-map
      className="fixed inset-x-0 top-12 bottom-tabbar z-0 md:top-14 md:bottom-0 lg:static lg:grid lg:h-[calc(100dvh-112px)] lg:min-h-[480px] lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-4"
    >
      {desktop ? (
        <aside
          aria-label="Butikker"
          className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface"
        >
          <div className="border-b border-line p-3">
            <p className="mb-2 text-meta text-ink-2">
              {listed.length} {listed.length === 1 ? "butik" : "butikker"} inden for {radiusKm} km
            </p>
            {chips}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{panel}</div>
        </aside>
      ) : null}

      <div ref={mapAreaRef} className="relative h-full min-h-0">
        <LazyStoreMap
          stores={stores}
          user={user}
          radiusKm={radiusKm}
          selectedId={selectedId}
          filters={filters}
          onSelect={select}
          padding={desktop ? undefined : { top: 52, bottom: sheetPx }}
          className="h-full lg:rounded-xl lg:border lg:border-line"
        />

        {!desktop ? (
          <>
            <div className="absolute inset-x-0 top-0 z-10 px-3 pt-2">{chips}</div>
            <section
              aria-label={selected ? selected.name : "Butikker"}
              className="absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-2xl border-t border-line bg-surface shadow-[0_-4px_16px_rgba(0,0,0,0.12)] transition-[height] motion-reduce:transition-none"
              style={{ height: sheetHeight }}
            >
              <button
                type="button"
                onClick={() =>
                  setSnap(snap === "peek" ? "half" : snap === "half" ? "full" : "peek")
                }
                aria-label={snap === "full" ? "Gør listen mindre" : "Vis mere af listen"}
                className="flex h-6 w-full shrink-0 items-center justify-center"
              >
                <span className="h-1 w-10 rounded-full bg-line-strong" />
              </button>
              {!selected ? (
                <button
                  type="button"
                  onClick={() => setSnap(snap === "peek" ? "half" : "peek")}
                  className="flex min-h-11 shrink-0 items-center justify-between px-4 text-left font-semibold text-ink"
                >
                  {listed.length === 0
                    ? `Ingen butikker inden for ${radiusKm} km`
                    : `${listed.length} ${listed.length === 1 ? "butik" : "butikker"} inden for ${radiusKm} km`}
                  <ChevronIcon className={snap === "peek" ? "rotate-180" : ""} />
                </button>
              ) : null}
              {snap !== "peek" || selected ? (
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{panel}</div>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ChainChips({
  chains,
  filters,
  onToggle,
}: {
  chains: readonly string[];
  filters: ReadonlySet<string> | null;
  onToggle: (chainId: string | null) => void;
}) {
  const chip =
    "flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-meta font-medium whitespace-nowrap shadow-sm aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-page border-line bg-surface text-ink";
  return (
    <ul
      aria-label="Kæder"
      className="-mx-3 flex [scrollbar-width:none] gap-1.5 overflow-x-auto px-3 pb-1 lg:mx-0 lg:flex-wrap lg:px-0"
    >
      <li>
        <button
          type="button"
          aria-pressed={filters == null}
          onClick={() => onToggle(null)}
          className={chip}
        >
          Alle
        </button>
      </li>
      {chains.map((chainId) => (
        <li key={chainId}>
          <button
            type="button"
            aria-pressed={filters?.has(chainId) ?? false}
            onClick={() => onToggle(chainId)}
            className={`${chip} pl-1.5`}
          >
            <ChainDot chainId={chainId} />
            {chainName(chainId)}
          </button>
        </li>
      ))}
    </ul>
  );
}

function StoreList({
  stores,
  onSelect,
  radiusKm,
}: {
  stores: readonly MapStore[];
  onSelect: (id: string) => void;
  radiusKm: number;
}) {
  if (stores.length === 0) {
    return (
      <div className="p-4 text-meta text-ink-2">
        Ingen kendte butikker inden for {radiusKm} km.
        <div>
          <OpenLocationButton>Skift afstand</OpenLocationButton>
        </div>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line">
      {stores.map((store) => {
        const facts = [
          store.foodWasteCount > 0 ? `${store.foodWasteCount} madspild` : null,
          store.cheaperCount > 0 ? `${store.cheaperCount} billigere end tilbud` : null,
        ].filter(Boolean);
        return (
          <li key={store.id}>
            <button
              type="button"
              onClick={() => onSelect(store.id)}
              className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-2"
            >
              <ChainDot chainId={store.chainId} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{store.name}</span>
                {facts.length > 0 ? (
                  <span className="block text-meta text-ink-2">{facts.join(" · ")}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-meta text-ink-3 tabular">
                {formatDistance(store.distanceKm)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function StoreDetail({
  store,
  items,
  cheaper,
  goodCount,
  now,
  onClose,
}: {
  store: MapStore;
  items: readonly FoodWasteItem[];
  cheaper: readonly CheaperRow[];
  goodCount: number;
  now: string;
  onClose: () => void;
}) {
  const address = storeAddress(store);
  const page = storePageLink(store);
  const salling = store.source === "salling";
  const chain = chainName(store.chainId);
  const sorted = [...items].sort(
    (a, b) => (b.discountPct ?? -1) - (a.discountPct ?? -1) || a.title.localeCompare(b.title),
  );

  return (
    <div className="px-4 pb-6">
      <div className="flex items-start gap-3 pt-2">
        <ChainDot chainId={store.chainId} size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="text-heading font-semibold text-ink">{store.name}</h2>
          <p className="text-meta text-ink-2">
            {address ? `${address} · ` : ""}
            <span className="tabular">{formatDistance(store.distanceKm)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mt-1 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-[10px] text-ink-2 hover:bg-surface-2"
        >
          <CloseIcon />
          <span className="sr-only">Luk</span>
        </button>
      </div>
      <p className="mt-2 flex flex-wrap gap-2">
        <ExternalLink
          href={routeLink(store.lat, store.lon)}
          className="h-11 rounded-[10px] border border-line-strong px-3 text-meta font-medium text-ink no-underline hover:bg-surface-2"
        >
          Rute
        </ExternalLink>
        {page?.href ? (
          <ExternalLink
            href={page.href}
            className="h-11 rounded-[10px] border border-line-strong px-3 text-meta font-medium text-ink no-underline hover:bg-surface-2"
          >
            {page.label}
          </ExternalLink>
        ) : null}
      </p>

      {salling ? (
        <section className="mt-5" aria-labelledby={`madspild-${store.id}`}>
          <h3 id={`madspild-${store.id}`} className="text-meta font-semibold text-ink-3">
            Madspild her ({items.length})
          </h3>
          {items.length > 0 ? (
            <>
              <ul className="divide-y divide-line">
                {sorted.slice(0, MAX_FOOD_WASTE_ROWS).map((item) => (
                  <li key={item.listingId}>
                    <FoodWasteItemRow item={item} now={now} />
                  </li>
                ))}
              </ul>
              {items.length > MAX_FOOD_WASTE_ROWS ? (
                <Link href="/madspild" className="mt-1 inline-flex h-11 items-center text-meta">
                  Se alle på Madspild →
                </Link>
              ) : null}
            </>
          ) : (
            <p className="mt-1 text-meta text-ink-2">Ingen madspild her lige nu.</p>
          )}
        </section>
      ) : null}

      <section className="mt-5" aria-labelledby={`tilbud-${store.id}`}>
        <h3 id={`tilbud-${store.id}`} className="text-meta font-semibold text-ink-3">
          Ugens tilbud i {chain}
        </h3>
        <Link
          href={`/tilbud?kaede=${encodeURIComponent(store.chainId)}` as Route}
          className="mt-1 inline-flex min-h-11 items-center"
        >
          {goodCount > 0
            ? `${goodCount} ${goodCount === 1 ? "godt køb gælder" : "gode køb gælder"} også her →`
            : `Se ugens tilbud i ${chain} →`}
        </Link>
      </section>

      <section className="mt-5" aria-labelledby={`billigere-${store.id}`}>
        <h3 id={`billigere-${store.id}`} className="text-meta font-semibold text-ink-3">
          Billigere her end ugens tilbud
        </h3>
        {cheaper.length > 0 ? (
          <ul className="divide-y divide-line">
            {cheaper.map((row) => (
              <li key={row.key} className="py-2">
                <p className="font-medium text-ink">{row.title}</p>
                <p className="text-meta text-ink">
                  <span className="font-semibold">{row.chain}:</span>{" "}
                  {row.name ? <span className="text-ink-2">{row.name} · </span> : null}
                  <SourcedPrice source={row.source} className="tabular">
                    {row.facts}
                  </SourcedPrice>
                </p>
                <p className="text-meta text-ink-2">
                  Tilbud i {row.offerChain}:{" "}
                  <SourcedPrice source={row.offerSource} className="tabular">
                    {row.offerPrice}
                  </SourcedPrice>
                  {row.verdict === "maybe" ? " · afhænger af pakningen" : ""}
                </p>
                <SourceLink link={row.link} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-meta text-ink-2">
            Ingen af ugens sammenlignede tilbud er billigere her.
          </p>
        )}
      </section>
    </div>
  );
}
