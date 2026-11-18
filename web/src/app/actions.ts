"use server";

import { cookies } from "next/headers";
import { isValidCoordinate } from "@/lib/geo";
import { normalizeQuery } from "@/lib/geocode";
import {
  LOCATION_COOKIE,
  MY_POSITION_LABEL,
  clampRadius,
  defaultLocation,
  parseLocationCookie,
  parseStoredLocation,
  serializeLocation,
  toStoredLocation,
  type StoredLocation,
  type UserLocation,
} from "@/lib/location";
import { GeocodingError, geocodeAddress } from "@/server/geocode";

/** The result of a location action, shown in the location sheet. */
export interface LocationActionState {
  status: "idle" | "saved" | "error";
  message: string;
  /** The submitted address text (kept in the input after an error). */
  address: string;
  /** Increments on every result, so the form remounts with the right values. */
  seq: number;
  /** The saved location, for the client's localStorage backup. */
  location?: StoredLocation;
}

const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

const NOT_FOUND = (address: string) =>
  `Vi kunne ikke finde “${address}”. Prøv med vejnavn, husnummer og postnummer.`;
const LOOKUP_FAILED = "Adresseopslaget virker ikke lige nu. Prøv igen om lidt.";

async function currentLocation(): Promise<UserLocation> {
  const store = await cookies();
  return (
    parseLocationCookie(store.get(LOCATION_COOKIE)?.value) ??
    defaultLocation(process.env.FOODCATCH_DEFAULT_LOCATION)
  );
}

/** Set the cookie (sliding one-year expiry) and return the stored form of the location. */
async function persist(loc: Omit<UserLocation, "isDefault">): Promise<StoredLocation> {
  const store = await cookies();
  store.set(LOCATION_COOKIE, serializeLocation(loc), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  });
  return toStoredLocation(loc, new Date());
}

/**
 * Save the address and radius from the location sheet. A changed address is geocoded with
 * Nominatim and saved under the text the user typed; the unchanged saved address (or an empty
 * field) only changes the radius.
 */
export async function saveLocation(
  previous: LocationActionState,
  formData: FormData,
): Promise<LocationActionState> {
  const seq = previous.seq + 1;
  const current = await currentLocation();
  const radiusKm = clampRadius(formData.get("radius"));
  const rawAddress = formData.get("address");
  const address = typeof rawAddress === "string" ? normalizeQuery(rawAddress) : "";
  const unchanged =
    !address ||
    (!current.isDefault &&
      address.toLocaleLowerCase("da-DK") === current.label.toLocaleLowerCase("da-DK"));

  if (unchanged) {
    const location = await persist({ ...current, radiusKm });
    return { status: "saved", message: `Afstand sat til ${radiusKm} km.`, address, seq, location };
  }

  try {
    const hit = await geocodeAddress(address);
    if (!hit) return { status: "error", message: NOT_FOUND(address), address, seq };
    const location = await persist({ lat: hit.lat, lon: hit.lon, label: address, radiusKm });
    return { status: "saved", message: `Gemt: ${location.label}.`, address, seq, location };
  } catch (error) {
    if (error instanceof GeocodingError) {
      console.error("Geocoding failed", error);
      return { status: "error", message: LOOKUP_FAILED, address, seq };
    }
    throw error;
  }
}

/**
 * Save coordinates from the browser's geolocation ("Brug min position"). No geocoding: the
 * coordinates are only validated and kept in the cookie, labelled "Min position".
 */
export async function saveCoordinates(input: {
  lat: number;
  lon: number;
  accuracyM?: number | null;
  radiusKm: number;
}): Promise<Omit<LocationActionState, "seq">> {
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  if (!isValidCoordinate(lat, lon)) {
    return {
      status: "error",
      message: "Vi fik ikke adgang til din position. Skriv en adresse i stedet.",
      address: "",
    };
  }
  const location = await persist({
    lat,
    lon,
    label: MY_POSITION_LABEL,
    radiusKm: clampRadius(input.radiusKm),
  });
  return { status: "saved", message: `Gemt: ${MY_POSITION_LABEL}.`, address: "", location };
}

/**
 * Restore a location from the client's localStorage backup when the cookie is gone. Validated
 * with the cookie's rules; no geocoding.
 */
export async function restoreLocation(entry: unknown): Promise<{ restored: boolean }> {
  const stored = parseStoredLocation(entry);
  if (!stored) return { restored: false };
  await persist({ lat: stored.lat, lon: stored.lon, label: stored.label, radiusKm: stored.r });
  return { restored: true };
}

/** Forget the chosen location and fall back to the default. */
export async function resetLocation(): Promise<void> {
  const store = await cookies();
  store.delete(LOCATION_COOKIE);
}
