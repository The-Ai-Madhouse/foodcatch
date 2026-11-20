"use server";

import { revalidatePath } from "next/cache";
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
import {
  STAPLES_COOKIE,
  parseStaples,
  serializeStaples,
  textStapleId,
  withStaple,
} from "@/lib/staple-catalogue";
import { LIKED_COOKIE, parseLiked, serializeLiked, toggleLiked } from "@/lib/meal-filters";
import {
  PLAN_COOKIE,
  addPlanDish,
  parsePlan,
  removePlanDish,
  serializePlan,
  todayInDenmark,
  togglePlanDay,
  type MealPlan,
} from "@/lib/meal-plan";
import { GeocodingError, geocodeAddress } from "@/server/geocode";

/** The result of a location action, shown in the location sheet. */
export interface LocationActionState {
  status: "idle" | "saved" | "error";
  message: string;
  /** The submitted address text (kept in the input after an error). */
  address: string;
  /** The submitted radius (kept selected after an error). */
  radiusKm?: number;
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
    if (!hit) return { status: "error", message: NOT_FOUND(address), address, radiusKm, seq };
    const location = await persist({ lat: hit.lat, lon: hit.lon, label: address, radiusKm });
    return { status: "saved", message: `Gemt: ${location.label}.`, address, seq, location };
  } catch (error) {
    if (error instanceof GeocodingError) {
      console.error("Geocoding failed", error);
      return { status: "error", message: LOOKUP_FAILED, address, radiusKm, seq };
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

/** Store the staples cookie (an empty value clears it). */
async function persistStaples(value: string): Promise<void> {
  const store = await cookies();
  if (value) {
    store.set(STAPLES_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_S,
    });
  } else {
    store.delete(STAPLES_COOKIE);
  }
  revalidatePath("/");
}

/** Save the staples picked on the offers page ("Dine basisvarer"); an empty pick clears them. */
export async function saveStaples(formData: FormData): Promise<void> {
  await persistStaples(serializeStaples(formData.getAll("basisvare")));
}

/**
 * Add one staple from the picker's search: a catalogue id (`basisvare`) or free text
 * (`fritekst`, stored as `q:<text>`). Invalid input changes nothing.
 */
export async function addStaple(formData: FormData): Promise<void> {
  const raw = formData.get("basisvare");
  const id = typeof raw === "string" && raw ? raw : textStapleId(formData.get("fritekst"));
  if (!id) return;
  const store = await cookies();
  const current = parseStaples(store.get(STAPLES_COOKIE)?.value);
  await persistStaples(serializeStaples(withStaple(current, id)));
}

/** Like or unlike a dish in "Madideer"; kept in a cookie for a year. */
export async function toggleLikedRecipe(id: string): Promise<{ liked: boolean }> {
  const store = await cookies();
  const next = toggleLiked(parseLiked(store.get(LIKED_COOKIE)?.value), id);
  const value = serializeLiked(next);
  if (value) {
    store.set(LIKED_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_S,
    });
  } else {
    store.delete(LIKED_COOKIE);
  }
  revalidatePath("/madideer");
  return { liked: next.includes(id) };
}

/** Read, change and store the meal plan cookie. */
async function changePlan(change: (plan: MealPlan) => MealPlan): Promise<void> {
  const store = await cookies();
  const today = todayInDenmark(new Date());
  const next = change(parsePlan(store.get(PLAN_COOKIE)?.value, today));
  const value = serializePlan(parsePlan(serializePlan(next), today));
  if (value) {
    store.set(PLAN_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_S,
    });
  } else {
    store.delete(PLAN_COOKIE);
  }
  revalidatePath("/madideer", "layout");
}

const text = (formData: FormData, name: string): string => {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
};

/** Add or remove a day of the meal plan. */
export async function togglePlanDayAction(formData: FormData): Promise<void> {
  await changePlan((plan) => togglePlanDay(plan, text(formData, "dato")));
}

/** Add a dish to a day of the meal plan. */
export async function addPlanDishAction(formData: FormData): Promise<void> {
  await changePlan((plan) => addPlanDish(plan, text(formData, "dato"), text(formData, "ret")));
}

/** Remove one dish from a day of the meal plan. */
export async function removePlanDishAction(formData: FormData): Promise<void> {
  await changePlan((plan) =>
    removePlanDish(plan, text(formData, "dato"), Number(text(formData, "nr"))),
  );
}

/** Empty the meal plan. */
export async function clearPlanAction(): Promise<void> {
  await changePlan(() => []);
}

/** The result of "Føj til madplan" in the catalogue, shown next to the button. */
export interface AddToPlanState {
  status: "idle" | "added" | "full" | "error";
  /** The day it was added to (`YYYY-MM-DD`). */
  date?: string;
  /** How many dishes that day now has. */
  count?: number;
  seq: number;
}

/** Add a dish from the catalogue and say whether it worked. */
export async function addToPlanFromCatalogue(
  previous: AddToPlanState,
  formData: FormData,
): Promise<AddToPlanState> {
  const seq = previous.seq + 1;
  const date = text(formData, "dato");
  const id = text(formData, "ret");
  const store = await cookies();
  const today = todayInDenmark(new Date());
  const before = parsePlan(store.get(PLAN_COOKIE)?.value, today);
  const after = addPlanDish(before, date, id);
  const day = after.find((d) => d.date === date);
  if (!day) return { status: "error", seq };
  if (after === before) return { status: "full", date, count: day.recipes.length, seq };
  await changePlan(() => after);
  return { status: "added", date, count: day.recipes.length, seq };
}
