"use client";

import { ChainDot } from "@/components/ChainDot";
import { ExternalLink } from "@/components/SourceLink";
import { useMapFocus } from "@/components/map/MapFocus";
import { formatDistance } from "@/lib/format";
import { routeLink } from "@/lib/sources";

/**
 * A store with its clearances on /madspild: a sticky header (chain, name, distance, address,
 * "Rute") and the rows. On desktop, hovering the group highlights the store on the side map and
 * "Vis på kort" selects it there.
 */
export function StoreGroup({
  storeId,
  chainId,
  name,
  address,
  distanceKm,
  lat,
  lon,
  itemCount,
  children,
}: {
  storeId: string;
  chainId: string;
  name: string;
  address: string | null;
  distanceKm: number;
  lat: number;
  lon: number;
  itemCount: number;
  children: React.ReactNode;
}) {
  const focus = useMapFocus();
  const headingId = `butik-${storeId}-navn`;
  return (
    <section
      aria-labelledby={headingId}
      onMouseEnter={() => focus?.setStore(storeId)}
      onMouseLeave={() => focus?.setStore(null)}
      className="rounded-xl border border-line bg-surface"
    >
      <div
        id={`butik-${storeId}`}
        tabIndex={-1}
        className="sticky top-12 z-10 flex items-start gap-3 rounded-t-xl border-b border-line bg-surface px-4 py-3 md:top-14 lg:px-5"
      >
        <ChainDot chainId={chainId} size="md" />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-heading font-semibold text-ink">
            {name}
          </h2>
          <p className="text-meta text-ink-2">
            <span className="tabular">{formatDistance(distanceKm)}</span>
            {address ? ` · ${address}` : ""} · {itemCount} {itemCount === 1 ? "vare" : "varer"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {focus ? (
            <button
              type="button"
              onClick={() => focus.setSelected(focus.selected === storeId ? null : storeId)}
              aria-pressed={focus.selected === storeId}
              className="hidden h-11 items-center text-meta font-medium text-link lg:flex"
            >
              Vis på kort
            </button>
          ) : null}
          <ExternalLink
            href={routeLink(lat, lon)}
            className="flex h-11 items-center text-meta font-medium"
          >
            Rute
          </ExternalLink>
        </div>
      </div>
      {children}
    </section>
  );
}
