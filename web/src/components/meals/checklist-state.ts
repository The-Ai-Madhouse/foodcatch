"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * What the user ticked ("har jeg") and removed from a dish, per recipe id, in this browser's
 * localStorage. Shared by the shopping list and the card's headline price, so both update
 * together. Without stored ticks the defaults (basics at home) apply.
 */

const haveKey = (id: string) => `fc_have:${id}`;
const removedKey = (id: string) => `fc_removed:${id}`;

function read(key: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** Stores the keys; null removes them (an empty list is kept: "none ticked" is not the default). */
function write(key: string, keys: readonly string[] | null): void {
  try {
    if (keys == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(keys));
  } catch {
    // Storage unavailable: the choices last until the page is left.
  }
}

interface Stored {
  /** Ticked as "har jeg", or null for the defaults. */
  have: string[] | null;
  removed: string[];
}

const listeners = new Set<() => void>();
/** In-memory copy (also when storage is unavailable), and stable snapshots per recipe. */
const cache = new Map<string, Stored>();

function load(id: string): Stored {
  let s = cache.get(id);
  if (!s) {
    s = { have: read(haveKey(id)), removed: read(removedKey(id)) ?? [] };
    cache.set(id, s);
  }
  return s;
}

function save(id: string, next: Stored) {
  cache.set(id, next);
  write(haveKey(id), next.have);
  write(removedKey(id), next.removed.length ? next.removed : null);
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SERVER: Stored = { have: null, removed: [] };

export interface ChecklistState {
  have: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  toggleHave: (key: string) => void;
  toggleRemoved: (key: string) => void;
  reset: () => void;
}

/** The ticks and removals of one recipe; `defaults` are the rows ticked until the user changes them. */
export function useChecklistState(recipeId: string, defaults: readonly string[]): ChecklistState {
  const stored = useSyncExternalStore(
    subscribe,
    () => load(recipeId),
    () => SERVER,
  );
  const have = new Set(stored.have ?? defaults);
  const removed = new Set(stored.removed);
  const toggleHave = useCallback(
    (key: string) => {
      const cur = load(recipeId);
      const next = new Set(cur.have ?? defaults);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      save(recipeId, { ...cur, have: [...next] });
    },
    [recipeId, defaults],
  );
  const toggleRemoved = useCallback(
    (key: string) => {
      const cur = load(recipeId);
      const next = new Set(cur.removed);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      save(recipeId, { ...cur, removed: [...next] });
    },
    [recipeId],
  );
  const reset = useCallback(() => save(recipeId, { have: null, removed: [] }), [recipeId]);
  return { have, removed, toggleHave, toggleRemoved, reset };
}
