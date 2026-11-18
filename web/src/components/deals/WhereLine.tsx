"use client";

import type { Route } from "next";
import Link from "next/link";
import { ChainDot } from "@/components/ChainDot";
import { sideMapVisible, useMapFocus } from "@/components/map/MapFocus";
import { chainName } from "@/lib/chains";

/**
 * Where a chain-wide offer can be bought (docs/ui.md §5.5): the chain and its nearest store.
 * Opens the map filtered to the chain on phones; highlights the chain on the side map on desktop.
 */
export function WhereLine({
  chainId,
  nearestName,
  nearestDistance,
  moreCount,
}: {
  chainId: string;
  /** Nearest store's name without the chain prefix. */
  nearestName: string;
  nearestDistance: string;
  /** Further stores of the chain within the radius. */
  moreCount: number;
}) {
  const focus = useMapFocus();
  const chain = chainName(chainId);
  const href = `/kort?kaede=${encodeURIComponent(chainId)}` as Route;
  return (
    <Link
      href={href}
      onClick={(event) => {
        if (focus && sideMapVisible()) {
          event.preventDefault();
          focus.setChain(focus.chain === chainId ? null : chainId);
        }
      }}
      className="-mx-1 flex min-h-11 items-center gap-2 rounded-[10px] px-1 text-meta text-ink-2 no-underline hover:bg-surface-2"
    >
      <ChainDot chainId={chainId} />
      {/* One line on a phone: "Netto Rådhuspladsen · 80 m · +22 andre". */}
      <span className="min-w-0">
        <span className="sr-only">Nærmeste butik: </span>
        <strong className="font-semibold text-ink">{chain}</strong> {nearestName}
        <span className="whitespace-nowrap tabular"> · {nearestDistance}</span>
        {moreCount > 0 ? (
          <span className="whitespace-nowrap">
            {" "}
            · +{moreCount} {moreCount === 1 ? "anden" : "andre"}
            <span className="sr-only"> {chain}-butikker i nærheden</span>
          </span>
        ) : null}
      </span>
    </Link>
  );
}
