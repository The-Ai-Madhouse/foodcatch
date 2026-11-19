import "server-only";

import { cookies } from "next/headers";
import {
  LOCATION_COOKIE,
  defaultLocation,
  parseLocationCookie,
  type UserLocation,
} from "@/lib/location";
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
