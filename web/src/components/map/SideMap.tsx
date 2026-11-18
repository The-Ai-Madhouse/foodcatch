"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { ChainDot } from "@/components/ChainDot";
import { chainName } from "@/lib/chains";
import { formatDistance } from "@/lib/format";
import type { Coordinates } from "@/lib/geo";
import type { MapStore } from "@/lib/stores";
import { LazyStoreMap } from "./LazyStoreMap";
import { useIsDesktop, useMapFocus } from "./MapFocus";

export interface ChainLegendEntry {
  chainId: string;
  nearestKm: number;
}

/**
 * The sticky map column of the desktop layouts (/ and /madspild). On `/` a marker opens the
 * store on /kort and the chain legend highlights a chain; on /madspild a marker scrolls the list
 * to the store's group.
 */
export function SideMap({
  stores,
  user,
  radiusKm,
  mode,
  legend,
}: {
  stores: readonly MapStore[];
  user: Coordinates;
  radiusKm: number;
  mode: "stores" | "foodwaste";
  legend?: readonly ChainLegendEntry[];
}) {
  const router = useRouter();
  const focus = useMapFocus();
  const desktop = useIsDesktop();

  function select(id: string | null) {
    if (mode === "stores") {
      if (id) router.push(`/kort?butik=${encodeURIComponent(id)}` as Route);
      else focus?.setChain(null);
      return;
    }
    focus?.setSelected(id);
    if (!id) return;
    const header = document.getElementById(`butik-${id}`);
    header?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    header?.focus({ preventScroll: true });
  }

  return (
    <div className="sticky top-[72px] flex h-[calc(100dvh-96px)] flex-col gap-3">
      {/* Only on desktop: phones never download MapLibre for a hidden column. */}
      {desktop ? (
        <LazyStoreMap
          stores={stores}
          user={user}
          radiusKm={radiusKm}
          mode={mode}
          selectedId={focus?.selected ?? null}
          highlightChain={focus?.chain ?? null}
          highlightStoreId={focus?.store ?? null}
          onSelect={select}
          className="min-h-0 flex-1 rounded-xl border border-line"
        />
      ) : null}
      {legend && legend.length > 0 ? (
        <ul aria-label="Kæder i nærheden" className="flex flex-wrap gap-1.5">
          {legend.map((entry) => {
            const active = focus?.chain === entry.chainId;
            return (
              <li key={entry.chainId}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => focus?.setChain(active ? null : entry.chainId)}
                  className="flex h-11 items-center gap-1.5 rounded-full border border-line bg-surface pr-3 pl-1.5 text-meta text-ink hover:bg-surface-2 aria-pressed:border-ink"
                >
                  <ChainDot chainId={entry.chainId} />
                  {chainName(entry.chainId)}
                  <span className="text-ink-3 tabular">{formatDistance(entry.nearestKm)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
