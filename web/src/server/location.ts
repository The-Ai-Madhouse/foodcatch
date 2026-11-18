import "server-only";

import { cookies } from "next/headers";
import {
  LOCATION_COOKIE,
  defaultLocation,
  parseLocationCookie,
  type UserLocation,
} from "@/lib/location";

/** The location from the request cookie, or the configured default (`FOODCATCH_DEFAULT_LOCATION`). */
export async function getUserLocation(): Promise<UserLocation> {
  const store = await cookies();
  return (
    parseLocationCookie(store.get(LOCATION_COOKIE)?.value) ??
    defaultLocation(process.env.FOODCATCH_DEFAULT_LOCATION)
  );
}
