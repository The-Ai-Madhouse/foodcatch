/**
 * The localStorage backup of the location (docs/ui.md §5.1). Every access is guarded: storage
 * can be missing, full or blocked, and the app must work without it.
 */

import {
  LOCATION_STORAGE_KEY,
  parseStoredLocation,
  sameStoredLocation,
  type StoredLocation,
} from "@/lib/location";

export function readStoredLocation(): StoredLocation | null {
  try {
    return parseStoredLocation(window.localStorage.getItem(LOCATION_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Write the backup unless it already holds the same place, label and radius. */
export function writeStoredLocation(location: StoredLocation): void {
  try {
    if (sameStoredLocation(readStoredLocation(), location)) return;
    window.localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(location));
  } catch {
    // Storage unavailable: the cookie still holds the location.
  }
}

export function removeStoredLocation(): void {
  try {
    window.localStorage.removeItem(LOCATION_STORAGE_KEY);
  } catch {
    // Nothing to remove.
  }
}
