"use client";

import { createContext, useContext, useMemo, useState, useSyncExternalStore } from "react";

interface MapFocus {
  /** Chain emphasised on the side map (others dimmed). */
  chain: string | null;
  setChain: (chainId: string | null) => void;
  /** Store emphasised on the side map (e.g. while its list group is hovered). */
  store: string | null;
  setStore: (storeId: string | null) => void;
  /** Store selected on the side map (a marker click or "Vis på kort"). */
  selected: string | null;
  setSelected: (storeId: string | null) => void;
}

const DESKTOP_QUERY = "(min-width: 1024px)";

const MapFocusContext = createContext<MapFocus | null>(null);

/** Shares what the list and the side map emphasise on desktop pages with a map column. */
export function MapFocusProvider({ children }: { children: React.ReactNode }) {
  const [chain, setChain] = useState<string | null>(null);
  const [store, setStore] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const value = useMemo(
    () => ({ chain, setChain, store, setStore, selected, setSelected }),
    [chain, store, selected],
  );
  return <MapFocusContext.Provider value={value}>{children}</MapFocusContext.Provider>;
}

/** The shared map focus, or null outside a {@link MapFocusProvider}. */
export function useMapFocus(): MapFocus | null {
  return useContext(MapFocusContext);
}

/** Whether the side map is shown (desktop layout, ≥ 1024 px). */
export function sideMapVisible(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function subscribeDesktop(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the desktop layout is active (false during server rendering). */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}
