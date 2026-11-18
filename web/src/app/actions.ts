"use server";

import { cookies } from "next/headers";
import { normalizeQuery } from "@/lib/geocode";
import {
  LOCATION_COOKIE,
  clampRadius,
  defaultLocation,
  parseLocationCookie,
  serializeLocation,
} from "@/lib/location";
import { GeocodingError, geocodeAddress } from "@/server/geocode";

export interface LocationFormState {
  status: "idle" | "saved" | "error";
  message: string;
}

const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

/**
 * Save the user's location and radius in a cookie. An address is geocoded with Nominatim; an
 * empty address keeps the current coordinates and only changes the radius.
 */
export async function saveLocation(
  _previous: LocationFormState,
  formData: FormData,
): Promise<LocationFormState> {
  const store = await cookies();
  const current =
    parseLocationCookie(store.get(LOCATION_COOKIE)?.value) ??
    defaultLocation(process.env.FOODCATCH_DEFAULT_LOCATION);
  const radiusKm = clampRadius(formData.get("radius"));
  const rawAddress = formData.get("address");
  const address = typeof rawAddress === "string" ? normalizeQuery(rawAddress) : "";

  let next = { lat: current.lat, lon: current.lon, label: current.label, radiusKm };
  if (address) {
    try {
      const hit = await geocodeAddress(address);
      if (!hit) {
        return {
          status: "error",
          message: `Vi kunne ikke finde “${address}”. Prøv med vejnavn, husnummer og postnummer.`,
        };
      }
      next = { lat: hit.lat, lon: hit.lon, label: hit.label || address, radiusKm };
    } catch (error) {
      if (error instanceof GeocodingError) {
        console.error("Geocoding failed", error);
        return {
          status: "error",
          message: "Adresseopslaget virker ikke lige nu. Prøv igen om lidt.",
        };
      }
      throw error;
    }
  }

  store.set(LOCATION_COOKIE, serializeLocation(next), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  });
  return {
    status: "saved",
    message: address
      ? `Placering sat til ${next.label} (${radiusKm} km).`
      : `Radius sat til ${radiusKm} km.`,
  };
}

/** Forget the chosen location and fall back to the default. */
export async function resetLocation(): Promise<void> {
  const store = await cookies();
  store.delete(LOCATION_COOKIE);
}
