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
import { STAPLES_COOKIE, parseStaples } from "@/lib/staples";
import { STAPLES_FOLDED_COOKIE } from "@/lib/staple-catalogue";

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

/** Whether the user folded "Dine basisvarer" away (remembered in a cookie). */
export async function getStaplesFolded(): Promise<boolean> {
  const store = await cookies();
  return store.get(STAPLES_FOLDED_COOKIE)?.value === "1";
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
