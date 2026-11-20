"use client";

import type { Route } from "next";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChainDot } from "@/components/ChainDot";
import { CloseIcon } from "@/components/Icons";
import { ExternalLink } from "@/components/SourceLink";
import { sideMapVisible, useMapFocus } from "@/components/map/MapFocus";
import { chainName } from "@/lib/chains";
import { formatDistance } from "@/lib/format";
import { storeMapsLink } from "@/lib/sources";
import { storeAddress, type StorePin } from "@/lib/stores";

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 300;
const LONG_PRESS_MS = 450;
const GAP_PX = 6;
const EDGE_PX = 8;
const MAX_WIDTH_PX = 300;

/** Closes the popover that is open now, so only one is open at a time. */
let current: { owner: object; close: () => void } | null = null;

/**
 * Where an item can be bought, on demand (docs/ui.md §20): the store (or chain) name is a
 * button; a tap, a long press, or holding the mouse over it shows the store's address and
 * distance with a link to Google Maps and to the store on our map. For a chain-wide offer it
 * lists the chain's nearest stores.
 *
 * Uses the Popover API (top layer), so the card is never clipped by a scrolling list.
 */
export function StoreInfo({
  chainId,
  stores,
  total = stores.length,
  children,
  className = "",
}: {
  chainId: string;
  /** The store, or the chain's nearest stores, nearest first. Empty: no store nearby. */
  stores: readonly StorePin[];
  /** All of the chain's stores within the radius (for "Alle … på kortet"). */
  total?: number;
  /** The visible trigger (store or chain name). */
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const pinned = useRef(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const pressTimer = useRef<number | undefined>(undefined);
  const pressFired = useRef(false);
  const [owner] = useState(() => ({}));
  const focus = useMapFocus();
  const chain = chainName(chainId);
  const single = stores.length === 1 && total <= 1 ? stores[0] : null;

  const isOpen = () => popRef.current?.matches(":popover-open") ?? false;

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const pop = popRef.current;
    if (!trigger || !pop) return;
    const r = trigger.getBoundingClientRect();
    const width = Math.min(MAX_WIDTH_PX, window.innerWidth - 2 * EDGE_PX);
    pop.style.width = `${width}px`;
    const left = Math.min(Math.max(EDGE_PX, r.left), window.innerWidth - width - EDGE_PX);
    const height = pop.offsetHeight;
    const below = r.bottom + GAP_PX;
    const above = r.top - GAP_PX - height;
    const top = below + height > window.innerHeight - EDGE_PX && above >= EDGE_PX ? above : below;
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(EDGE_PX, top)}px`;
  }, []);

  const close = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    pinned.current = false;
    const pop = popRef.current;
    if (pop?.matches(":popover-open")) pop.hidePopover();
    triggerRef.current?.setAttribute("aria-expanded", "false");
    if (current?.owner === owner) current = null;
  }, [owner]);

  const open = useCallback(() => {
    const pop = popRef.current;
    if (!pop) return;
    if (current && current.owner !== owner) current.close();
    current = { owner, close };
    if (!pop.matches(":popover-open")) pop.showPopover();
    triggerRef.current?.setAttribute("aria-expanded", "true");
    place();
  }, [close, owner, place]);

  // While open: follow the trigger on scroll/resize; close on an outside press or Escape.
  useEffect(() => {
    function onDown(event: PointerEvent) {
      if (!isOpen()) return;
      const target = event.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && isOpen()) {
        close();
        triggerRef.current?.focus();
      }
    }
    function onMove() {
      if (isOpen()) place();
    }
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.clearTimeout(hoverTimer.current);
      window.clearTimeout(pressTimer.current);
      if (current?.owner === owner) current = null;
    };
  }, [close, owner, place]);

  function hoverIn(event: React.PointerEvent) {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(hoverTimer.current);
    if (!isOpen()) hoverTimer.current = window.setTimeout(open, HOVER_OPEN_MS);
  }
  function hoverOut(event: React.PointerEvent) {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(hoverTimer.current);
    if (!pinned.current) hoverTimer.current = window.setTimeout(close, HOVER_CLOSE_MS);
  }
  function pressStart(event: React.PointerEvent) {
    if (event.pointerType === "mouse") return;
    pressFired.current = false;
    window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      pressFired.current = true;
      pinned.current = true;
      open();
    }, LONG_PRESS_MS);
  }
  function pressEnd() {
    window.clearTimeout(pressTimer.current);
  }
  function onClick(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (pressFired.current) {
      // The long press already opened it; the click that follows must not close it again.
      pressFired.current = false;
      return;
    }
    window.clearTimeout(hoverTimer.current);
    if (isOpen() && pinned.current) close();
    else {
      pinned.current = true;
      open();
    }
  }
  function showChainOnMap(event: React.MouseEvent) {
    if (focus && sideMapVisible()) {
      event.preventDefault();
      focus.setChain(chainId);
      close();
    }
  }

  const label = single ? single.name : `${chain} i nærheden`;

  return (
    <span className="inline-flex max-w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded="false"
        aria-controls={id}
        onClick={onClick}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onPointerDown={pressStart}
        onPointerUp={pressEnd}
        onPointerCancel={pressEnd}
        onPointerMove={(e) => {
          if (e.pointerType !== "mouse" && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4))
            pressEnd();
        }}
        onContextMenu={(e) => {
          // A long press on a phone opens the card instead of the browser's menu.
          if (pressFired.current) e.preventDefault();
        }}
        className={`inline-flex max-w-full cursor-pointer items-center gap-1 rounded text-left underline decoration-ink-3/60 decoration-dotted underline-offset-2 select-none [-webkit-touch-callout:none] hover:decoration-solid ${className}`}
      >
        {children}
        <span className="sr-only"> – vis adresse</span>
      </button>
      <span
        ref={popRef}
        id={id}
        popover="manual"
        role="dialog"
        aria-label={label}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") window.clearTimeout(hoverTimer.current);
        }}
        onPointerLeave={hoverOut}
        style={{ position: "fixed", inset: "auto", margin: 0 }}
        className="rounded-xl border border-line-strong bg-surface p-0 text-meta text-ink shadow-lg"
      >
        <span className="flex items-center gap-2 border-b border-line py-1 pr-1 pl-3">
          <ChainDot chainId={chainId} size="sm" />
          <span className="min-w-0 flex-1 truncate font-semibold">
            {single ? single.name : stores.length ? `Nærmeste ${chain}` : chain}
          </span>
          <button
            type="button"
            onClick={close}
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-ink-2 hover:bg-surface-2"
          >
            <CloseIcon size={16} />
            <span className="sr-only">Luk</span>
          </button>
        </span>
        {stores.length === 0 ? (
          <span className="block px-3 py-2 text-ink-2">Ingen {chain} inden for din afstand.</span>
        ) : (
          <span className="block max-h-[60vh] divide-y divide-line overflow-y-auto">
            {stores.map((store) => (
              <StoreBlock key={store.id} store={store} showName={!single} onNavigate={close} />
            ))}
          </span>
        )}
        {total > stores.length || (!single && stores.length > 0) ? (
          <span className="block border-t border-line px-3">
            <Link
              href={`/kort?kaede=${encodeURIComponent(chainId)}` as Route}
              onClick={showChainOnMap}
              className="inline-flex min-h-11 items-center"
            >
              {`Alle ${total} ${chain}-butikker på kortet`}
            </Link>
          </span>
        ) : null}
      </span>
    </span>
  );
}

function StoreBlock({
  store,
  showName,
  onNavigate,
}: {
  store: StorePin;
  showName: boolean;
  onNavigate: () => void;
}) {
  const address = storeAddress(store);
  return (
    <span className="block px-3 py-2">
      {showName ? <span className="block font-medium text-ink">{store.name}</span> : null}
      <span className="block text-ink-2">
        {address ?? "Adresse ukendt"}
        <span className="whitespace-nowrap tabular"> · {formatDistance(store.distanceKm)}</span>
      </span>
      <span className="mt-1 flex flex-wrap gap-x-4">
        <ExternalLink href={storeMapsLink(store)} iconSize={14} className="min-h-9">
          Åbn i Google Maps
        </ExternalLink>
        <Link
          href={`/kort?butik=${encodeURIComponent(store.id)}` as Route}
          onClick={onNavigate}
          className="inline-flex min-h-9 items-center"
        >
          Vis på kort
        </Link>
      </span>
    </span>
  );
}
