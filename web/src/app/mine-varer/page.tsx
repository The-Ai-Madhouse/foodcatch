import type { Metadata } from "next";
import { StaplesSection } from "@/components/deals/StaplesSection";
import { evaluateDeals, groupByListing, nearbyDeals } from "@/lib/deals";
import { stapleMatches, textStapleTerms } from "@/lib/staples";
import { nearestByChain } from "@/lib/stores";
import { getUserLocation, getUserStaples } from "@/server/location";
import {
  getCurrentDeals,
  getFoodWasteNear,
  getNearbyStores,
  getOffersMatching,
} from "@/server/queries";

export const metadata: Metadata = { title: "Mine varer" };

/**
 * "Mine varer" (docs/ui.md §21): the user's watch list of staples. Each one shows whether it is
 * cheap now (with the saving against the normal price), when an upcoming offer starts, and food
 * waste nearby; the picker and the search for more items are below.
 */
export default async function MyItemsPage() {
  const [location, staples] = await Promise.all([getUserLocation(), getUserStaples()]);
  const [stores, allRows, foodWaste, textOffers] = await Promise.all([
    getNearbyStores(location),
    getCurrentDeals(),
    staples.length ? getFoodWasteNear(location) : Promise.resolve([]),
    getOffersMatching(textStapleTerms(staples)),
  ]);
  const storesByChain = nearestByChain(stores);
  const nearbyChains = new Set(storesByChain.keys());
  const now = new Date();
  const listings = groupByListing(evaluateDeals(nearbyDeals(allRows, nearbyChains), nearbyChains));
  const matches = stapleMatches(
    staples,
    listings,
    foodWaste,
    nearbyDeals(textOffers, nearbyChains),
    now,
  );

  return (
    <div className="mx-auto max-w-[720px] lg:mx-0">
      <h1 className="text-display shelf text-ink">Mine varer</h1>
      <p className="text-meta text-ink-2">
        De varer, du altid køber. Vi viser dem her, når de er billige inden for {location.radiusKm}{" "}
        km – også når et tilbud er på vej.
      </p>
      <StaplesSection
        selected={staples}
        matches={matches}
        now={now}
        storesByChain={storesByChain}
      />
    </div>
  );
}
