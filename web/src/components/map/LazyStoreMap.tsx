"use client";

import dynamic from "next/dynamic";
import type { StoreMapProps } from "./StoreMap";

/**
 * The store map, loaded on the client only, so MapLibre (~230 kB gzip) is fetched just on pages
 * that show a map.
 */
export const LazyStoreMap = dynamic<StoreMapProps>(() => import("./StoreMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-surface-2 text-meta text-ink-2">
      Indlæser kort…
    </div>
  ),
});
