"use client";

import {
  AttributionControl,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
} from "maplibre-gl";
import type { Feature, Polygon } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { CrosshairIcon } from "@/components/Icons";
import { chainName, chainStyle } from "@/lib/chains";
import { formatDistance } from "@/lib/format";
import { boundingBox, type Coordinates } from "@/lib/geo";
import type { MapStore } from "@/lib/stores";

/** OpenFreeMap vector styles (no API key, no cookies; attribution from the TileJSON). */
const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const DESKTOP_QUERY = "(min-width: 1024px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export interface StoreMapProps {
  stores: readonly MapStore[];
  user: Coordinates;
  radiusKm: number;
  selectedId?: string | null;
  /** Chain to emphasise; the others are dimmed. */
  highlightChain?: string | null;
  /** Store to emphasise (e.g. while its list group is hovered). */
  highlightStoreId?: string | null;
  /** Chains to show at full strength; null shows all. */
  filters?: ReadonlySet<string> | null;
  onSelect?: (id: string | null) => void;
  /** `foodwaste` shows each store's clearance count on its marker. */
  mode?: "stores" | "foodwaste";
  /** Extra padding (px) for overlays such as a bottom sheet. */
  padding?: Partial<MapPadding>;
  className?: string;
}

/** Padding in pixels on each side of the map. */
export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const matches = (query: string): boolean => window.matchMedia(query).matches;

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** A 64-point polygon approximating the radius circle. */
function circlePolygon(center: Coordinates, radiusKm: number): Feature<Polygon> {
  const box = boundingBox(center, radiusKm);
  const dLat = (box.maxLat - box.minLat) / 2;
  const dLon = (box.maxLon - box.minLon) / 2;
  const ring: [number, number][] = [];
  for (let i = 0; i <= 64; i += 1) {
    const a = (i / 64) * 2 * Math.PI;
    ring.push([center.lon + dLon * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

function radiusBounds(center: Coordinates, radiusKm: number): LngLatBoundsLike {
  const box = boundingBox(center, radiusKm);
  return [
    [box.minLon, box.minLat],
    [box.maxLon, box.maxLat],
  ];
}

function fullPadding(extra: Partial<MapPadding> | undefined): MapPadding {
  return {
    top: 24 + (extra?.top ?? 0),
    right: 24 + (extra?.right ?? 0),
    bottom: 24 + (extra?.bottom ?? 0),
    left: 24 + (extra?.left ?? 0),
  };
}

/** Show place names in Danish where OpenStreetMap has them (the styles default to English). */
function danishLabels(map: MapLibreMap) {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== "symbol") continue;
    const field = map.getLayoutProperty(layer.id, "text-field");
    if (field == null || !JSON.stringify(field).includes("name")) continue;
    // Road shields and house numbers use other fields ("ref", "housenumber"); leave those.
    if (JSON.stringify(field).includes("ref") || JSON.stringify(field).includes("housenumber"))
      continue;
    map.setLayoutProperty(layer.id, "text-field", [
      "coalesce",
      ["get", "name:da"],
      ["get", "name"],
    ]);
  }
}

/** Add (or update) the radius ring; called again after a style change. */
function drawRadius(map: MapLibreMap, user: Coordinates, radiusKm: number) {
  const ring = circlePolygon(user, radiusKm);
  const ringSource = map.getSource<GeoJSONSource>("fc-radius");
  if (ringSource) {
    ringSource.setData(ring);
    return;
  }
  const colour = cssVar("--map-user", "#2a78d6");
  map.addSource("fc-radius", { type: "geojson", data: ring });
  map.addLayer({
    id: "fc-radius-fill",
    type: "fill",
    source: "fc-radius",
    paint: { "fill-color": colour, "fill-opacity": 0.12 },
  });
  map.addLayer({
    id: "fc-radius-line",
    type: "line",
    source: "fc-radius",
    paint: { "line-color": colour, "line-width": 1, "line-dasharray": [3, 2] },
  });
}

/**
 * The user's position: an HTML marker above the store markers (a map layer would be hidden
 * under them, and the nearest store is usually right next to the user). It ignores pointer
 * events, so the stores around it stay tappable.
 */
function createUserMarker(user: Coordinates): Marker {
  const element = document.createElement("div");
  element.className = "user-marker";
  element.setAttribute("aria-hidden", "true");
  element.title = "Din placering";
  return new Marker({ element }).setLngLat([user.lon, user.lat]);
}

interface MarkerEntry {
  marker: Marker;
  button: HTMLButtonElement;
  count: HTMLSpanElement;
}

function createMarker(store: MapStore, onClick: (id: string) => void): MarkerEntry {
  const style = chainStyle(store.chainId);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "store-marker";
  button.dataset.storeId = store.id;
  const dot = document.createElement("span");
  dot.className = "store-marker__dot";
  dot.style.background = style.fill;
  dot.style.color = style.text;
  dot.textContent = style.monogram;
  dot.setAttribute("aria-hidden", "true");
  const count = document.createElement("span");
  count.className = "store-marker__count";
  count.setAttribute("aria-hidden", "true");
  dot.appendChild(count);
  button.appendChild(dot);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(store.id);
  });
  const marker = new Marker({ element: button }).setLngLat([store.lon, store.lat]);
  return { marker, button, count };
}

/**
 * Nearby stores on an OpenFreeMap vector map (docs/ui.md §7). Markers are buttons in distance
 * order with the chain's colour and monogram; the same stores are always listed next to the map,
 * which stays the primary accessible path. Loaded only on the client (`LazyStoreMap`).
 */
export default function StoreMap({
  stores,
  user,
  radiusKm,
  selectedId = null,
  highlightChain = null,
  highlightStoreId = null,
  filters = null,
  onSelect,
  mode = "stores",
  padding,
  className = "",
}: StoreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef(new Map<string, MarkerEntry>());
  const userMarkerRef = useRef<Marker | null>(null);
  const onSelectRef = useRef(onSelect);
  const viewRef = useRef({ user, radiusKm, padding });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    onSelectRef.current = onSelect;
    viewRef.current = { user, radiusKm, padding };
  });

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setWorkerUrl(new URL("/maplibre-worker.mjs", window.location.origin).href);
    const desktop = matches(DESKTOP_QUERY);
    const { user: u, radiusKm: r, padding: p } = viewRef.current;
    const map = new MapLibreMap({
      container,
      style: matches(DARK_QUERY) ? STYLE_DARK : STYLE_LIGHT,
      bounds: radiusBounds(u, r),
      fitBoundsOptions: { padding: fullPadding(p) },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    // On phones the bottom sheet covers the bottom edge, so the attribution sits at the top
    // (below any overlay given as `padding.top`); it is never hidden.
    map.addControl(
      new AttributionControl({ compact: !desktop }),
      desktop ? "bottom-left" : "top-left",
    );
    if (desktop) map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    mapRef.current = map;
    const userMarker = createUserMarker(u).addTo(map);
    userMarkerRef.current = userMarker;

    let loaded = false;
    map.on("style.load", () => {
      const view = viewRef.current;
      danishLabels(map);
      drawRadius(map, view.user, view.radiusKm);
    });
    map.on("load", () => {
      loaded = true;
      setStatus("ready");
    });
    map.on("error", () => {
      if (!loaded) setStatus("error");
    });
    map.on("click", () => onSelectRef.current?.(null));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSelectRef.current?.(null);
    };
    container.addEventListener("keydown", onKey);

    const dark = window.matchMedia(DARK_QUERY);
    const onScheme = () => map.setStyle(dark.matches ? STYLE_DARK : STYLE_LIGHT);
    dark.addEventListener("change", onScheme);

    const markers = markersRef.current;
    return () => {
      dark.removeEventListener("change", onScheme);
      container.removeEventListener("keydown", onKey);
      markers.clear();
      userMarker.remove();
      userMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Markers: add, remove and keep them in distance order (the tab order).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const entries = markersRef.current;
    const ids = new Set(stores.map((s) => s.id));
    for (const [id, entry] of entries) {
      if (!ids.has(id)) {
        entry.marker.remove();
        entries.delete(id);
      }
    }
    const sorted = [...stores].sort((a, b) => a.distanceKm - b.distanceKm);
    for (const store of sorted) {
      let entry = entries.get(store.id);
      if (!entry) {
        entry = createMarker(store, (id) => onSelectRef.current?.(id));
        entry.marker.addTo(map);
        entries.set(store.id, entry);
      }
      entry.button.setAttribute(
        "aria-label",
        `${store.name}, ${chainName(store.chainId)}, ${formatDistance(store.distanceKm)}${
          mode === "foodwaste" && store.foodWasteCount > 0
            ? `, ${store.foodWasteCount} madspildsvarer`
            : ""
        }`,
      );
      entry.count.textContent = mode === "foodwaste" ? String(store.foodWasteCount) : "";
      entry.count.hidden = mode !== "foodwaste" || store.foodWasteCount === 0;
      // Re-append in distance order so keyboard focus moves outwards from the user.
      entry.button.parentElement?.appendChild(entry.button);
    }
  }, [stores, mode]);

  // Selection, highlight and filters.
  useEffect(() => {
    // Nearer stores are drawn above farther ones: the nearest store is the one most likely to
    // be wanted, and it would otherwise hide under its neighbours (the DOM is in distance order
    // for the tab order, so later = farther = on top by default).
    const rank = new Map(
      [...stores].sort((a, b) => a.distanceKm - b.distanceKm).map((s, i) => [s.id, i]),
    );
    for (const [id, entry] of markersRef.current) {
      const store = stores.find((s) => s.id === id);
      if (!store) continue;
      const selected = id === selectedId;
      const filteredOut = filters != null && !filters.has(store.chainId);
      const notHighlighted =
        (highlightChain != null && store.chainId !== highlightChain) ||
        (highlightStoreId != null && id !== highlightStoreId);
      const dimmed = !selected && (filteredOut || notHighlighted);
      entry.button.setAttribute("aria-pressed", String(selected));
      entry.button.setAttribute("data-dimmed", String(dimmed));
      entry.button.setAttribute("tabindex", dimmed ? "-1" : "0");
      const base = selected ? 3000 : dimmed ? 1000 : 2000;
      const z = selected ? base : base - Math.min(rank.get(id) ?? 999, 999);
      entry.marker.getElement().style.setProperty("z-index", String(z));
    }
  }, [stores, selectedId, highlightChain, highlightStoreId, filters]);

  // Keep a newly selected store in view, also when an overlay (the bottom sheet) grows.
  const paddingKey = padding ? `${padding.top ?? 0},${padding.bottom ?? 0}` : "";
  useEffect(() => {
    const map = mapRef.current;
    const store = selectedId ? stores.find((s) => s.id === selectedId) : null;
    if (!map || !store) return;
    const point = map.project([store.lon, store.lat]);
    const canvas = map.getCanvas();
    const pad = fullPadding(viewRef.current.padding);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    // The overlays cover (nearly) the whole map, e.g. the sheet at full height.
    if (pad.top + pad.bottom > height - 48) return;
    // Room for the (enlarged) marker itself.
    const margin = 24;
    const visible =
      point.x >= pad.left + margin &&
      point.x <= width - pad.right - margin &&
      point.y >= pad.top + margin &&
      point.y <= height - pad.bottom - margin;
    if (!visible) {
      map.easeTo({
        center: [store.lon, store.lat],
        padding: pad,
        duration: matches(REDUCED_MOTION_QUERY) ? 0 : 400,
      });
    }
  }, [selectedId, stores, paddingKey]);

  // A new location or radius: redraw the ring and refit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    userMarkerRef.current?.setLngLat([user.lon, user.lat]);
    if (!map.isStyleLoaded()) return;
    drawRadius(map, user, radiusKm);
    map.fitBounds(radiusBounds(user, radiusKm), {
      padding: fullPadding(viewRef.current.padding),
      duration: matches(REDUCED_MOTION_QUERY) ? 0 : 400,
    });
  }, [user, radiusKm]);

  function recentre() {
    mapRef.current?.fitBounds(radiusBounds(user, radiusKm), {
      padding: fullPadding(padding),
      duration: matches(REDUCED_MOTION_QUERY) ? 0 : 400,
    });
  }

  return (
    <div
      className={`relative overflow-hidden bg-surface-2 ${className}`}
      style={{ "--map-inset-top": `${padding?.top ?? 0}px` } as React.CSSProperties}
    >
      <div
        ref={containerRef}
        role="region"
        aria-label="Kort over butikker"
        // Inline: MapLibre's unlayered `.maplibregl-map { position: relative }` beats utilities.
        // `isolation` keeps the markers' z-indexes inside the map, below the page's overlays.
        style={{ position: "absolute", inset: 0, isolation: "isolate" }}
      />
      {status !== "ready" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-meta text-ink-2">
          {status === "error"
            ? "Kortet kunne ikke indlæses. Butikkerne står i listen."
            : "Indlæser kort…"}
        </div>
      ) : null}
      <button
        type="button"
        onClick={recentre}
        className="absolute top-3 right-3 z-10 flex size-11 items-center justify-center rounded-[10px] border border-line bg-surface text-ink shadow-sm hover:bg-surface-2"
        style={padding?.top ? { top: 12 + padding.top } : undefined}
      >
        <CrosshairIcon />
        <span className="sr-only">Centrér på mig</span>
      </button>
    </div>
  );
}
