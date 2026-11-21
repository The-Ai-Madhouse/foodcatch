import "server-only";

import { cookies } from "next/headers";
import {
  LOCATION_COOKIE,
  defaultLocation,
  parseLocationCookie,
  type UserLocation,
} from "@/lib/location";
import { LIKED_COOKIE, parseLiked } from "@/lib/meal-filters";
import { PLAN_COOKIE, parsePlan, todayInDenmark, type MealPlan } from "@/lib/meal-plan";
import { PEOPLE_COOKIE, parsePeople } from "@/lib/people";
import { STAPLES_COOKIE, parseStaples } from "@/lib/staples";

/** The location from the request cookie, or the configured default (`FOODCATCH_DEFAULT_LOCATION`). */
export async function getUserLocation(): Promise<UserLocation> {
  const store = await cookies();
  return (
    parseLocationCookie(store.get(LOCATION_COOKIE)?.value) ??
    defaultLocation(process.env.FOODCATCH_DEFAULT_LOCATION)
  );
}

/** The staples the user picked ("Dine basisvarer"), from the request cookie. */
export async function getUserStaples(): Promise<string[]> {
  const store = await cookies();
  return parseStaples(store.get(STAPLES_COOKIE)?.value);
}

/** How many people the user cooks for, or null when not chosen. */
export async function getPeople(): Promise<number | null> {
  const store = await cookies();
  return parsePeople(store.get(PEOPLE_COOKIE)?.value);
}

/** The dishes the user liked in "Madideer", from the request cookie. */
export async function getLikedRecipes(): Promise<string[]> {
  const store = await cookies();
  return parseLiked(store.get(LIKED_COOKIE)?.value);
}

/** The meal plan ("Madplan"), from the request cookie; past days are dropped. */
export async function getMealPlan(now: Date): Promise<MealPlan> {
  const store = await cookies();
  return parsePlan(store.get(PLAN_COOKIE)?.value, todayInDenmark(now));
}
