import type { Metadata, Route } from "next";
import Link from "next/link";
import { CollapsibleCategory } from "@/components/CategoryOverview";
import { Notice } from "@/components/Notice";
import { Segmented } from "@/components/Segmented";
import { ChainChips } from "@/components/deals/ChainChips";
import { DealCard, type DealContext } from "@/components/deals/DealCard";
import { FoodWasteItemRow } from "@/components/foodwaste/FoodWasteItemRow";
import { ChevronIcon } from "@/components/Icons";
import { OpenLocationButton } from "@/components/location/LocationControl";
import { MapFocusProvider } from "@/components/map/MapFocus";
import { SideMap } from "@/components/map/SideMap";
import {
  dealsHref,
  evaluateDeals,
  filterListings,
  groupByListing,
  groupListings,
  groupUpcoming,
  isUpcoming,
  nearbyDeals,
  parseChainFilter,
  parseDealFilter,
  referenceListingIds,
} from "@/lib/deals";
import { formatDayDate } from "@/lib/format";
import { groupSlug } from "@/lib/groups";
import { nearestByChain, toMapStore } from "@/lib/stores";
import { stapleMatches, textStapleTerms } from "@/lib/staples";
import { clearanceSaving, listingSaving, savedAmount } from "@/lib/savings";
import { getUserLocation, getUserStaples } from "@/server/location";
import {
  getCurrentDeals,
  getFoodWasteNear,
  getNearbyStores,
  getOffersMatching,
  getReferenceDetails,
} from "@/server/queries";

export const metadata: Metadata = { title: "Tilbud" };

/** Clearances shown in the bonus block. */
const BONUS_CLEARANCES = 3;

/**
 * "Tilbud" (docs/ui.md §21): products to cook from that are cheap near the user this week, by
 * category with the biggest real saving first; then upcoming offers and, as a bonus, the best
 * food waste nearby.
 */
export default async function OffersPage({ searchParams }: PageProps<"/tilbud">) {
  const params = await searchParams;
  const filter = parseDealFilter(params.vis);
  const [location, staples] = await Promise.all([getUserLocation(), getUserStaples()]);
  const [stores, allRows, foodWaste, textOffers] = await Promise.all([
    getNearbyStores(location),
    getCurrentDeals(),
    getFoodWasteNear(location),
    getOffersMatching(textStapleTerms(staples)),
  ]);
  const storesByChain = nearestByChain(stores);
  const nearbyChains = new Set(storesByChain.keys());
  // Only chains with a store within the radius; a filter on other chains is ignored.
  const nearbyRows = nearbyDeals(allRows, nearbyChains);
  const offerChains = [...storesByChain.keys()].filter((c) =>
    nearbyRows.some((r) => r.chainId === c),
  );
  const selected = parseChainFilter(params.kaede).filter((c) => offerChains.includes(c));
  const rows = nearbyDeals(nearbyRows, nearbyChains, selected);
  const details = await getReferenceDetails(referenceListingIds(rows));

  const now = new Date();
  const allListings = groupByListing(evaluateDeals(nearbyRows, nearbyChains));
  const chainListings = allListings.filter(
    (l) => selected.length === 0 || selected.includes(l.offer.chainId),
  );
  // Offers of leaflets published ahead of their week get their own section (docs/ui.md §17).
  const listings = chainListings.filter((l) => !isUpcoming(l, now));
  const upcoming = chainListings.filter((l) => isUpcoming(l, now));
  const upcomingShown = filterListings(upcoming, filter);
  const upcomingDays = groupUpcoming(upcomingShown);
  const goodCount = listings.filter((l) => l.status === "good_deal").length;
  // Staples ignore the chain filter: they are about the item, wherever it is cheap.
  const staplesFound = stapleMatches(
    staples,
    allListings,
    foodWaste,
    nearbyDeals(textOffers, nearbyChains),
    now,
  );
  // Within a category: the biggest known saving first (the sort is stable, so the verdict order
  // of groupListings decides among equal savings).
  const groups = groupListings(filterListings(listings, filter)).map((g) => ({
    ...g,
    listings: [...g.listings].sort(
      (a, b) =>
        savedAmount(listingSaving(b, nearbyChains)) - savedAmount(listingSaving(a, nearbyChains)),
    ),
  }));
  const stapleHits = staplesFound.filter((m) => m.offerCount + m.clearanceCount > 0);
  // The bonus: clearances with the biggest saving against Salling's price before.
  const bonus = [...foodWaste]
    .sort((a, b) => savedAmount(clearanceSaving(b)) - savedAmount(clearanceSaving(a)))
    .slice(0, BONUS_CLEARANCES);
  // Chips for chains with something to show in this view (and any selected one).
  const chainCounts = offerChains
    .map((chainId) => ({
      chainId,
      count: filterListings(
        allListings.filter((l) => l.offer.chainId === chainId),
        filter,
      ).length,
    }))
    .filter((c) => c.count > 0 || selected.includes(c.chainId))
    // Selected chains first, so they are visible in the scrolling row on a phone.
    .sort((a, b) => Number(selected.includes(b.chainId)) - Number(selected.includes(a.chainId)));
  const chainParam = selected.length ? selected.join(",") : null;
  const ctx: DealContext = {
    nearbyChains,
    storesByChain,
    nearestOutside: new Map(),
    radiusKm: location.radiusKm,
    details,
    now,
  };
  const legend = [...storesByChain.entries()].map(([chainId, list]) => ({
    chainId,
    nearestKm: list[0]?.distanceKm ?? 0,
  }));

  return (
    <MapFocusProvider>
      <div className="lg:grid lg:grid-cols-[minmax(0,640px)_minmax(0,1fr)] lg:gap-8">
        <div className="min-w-0">
          <h1 className="text-display shelf text-ink">Tilbud</h1>
          <p className="text-meta text-ink-2">
            Varer at lave mad af, der er billige inden for {location.radiusKm} km. Størst besparelse
            ift. normalprisen først.
          </p>
          <Link
            href="/mine-varer"
            className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-2 text-ink no-underline hover:bg-surface-2"
          >
            <span className="text-meta">
              <strong className="font-semibold">Mine varer: </strong>
              {staples.length === 0
                ? "vælg de varer, du altid køber, og se når de er billige"
                : stapleHits.length === 0
                  ? "ingen af dine varer er på tilbud lige nu"
                  : `${stapleHits.length} af ${staplesFound.length} er på tilbud nu`}
            </span>
            <ChevronIcon className="-rotate-90 text-ink-3" />
          </Link>
          <div className="mt-3">
            <Segmented
              label="Vis tilbud"
              items={[
                {
                  href: dealsHref("gode", chainParam) as Route,
                  label: `Gode køb (${goodCount})`,
                  active: filter === "gode",
                },
                {
                  href: dealsHref("alle", chainParam) as Route,
                  label: `Alle (${listings.length})`,
                  active: filter === "alle",
                },
              ]}
            />
          </div>
          {chainCounts.length > 1 || selected.length > 0 ? (
            <div className="mt-3">
              <ChainChips chains={chainCounts} selected={selected} filter={filter} />
            </div>
          ) : null}

          {allRows.length > 0 && nearbyRows.length === 0 ? (
            <div className="mt-4">
              <Notice tone="warn">
                Ingen af kæderne med tilbud har en butik inden for {location.radiusKm} km.
                <div>
                  <OpenLocationButton>Skift afstand</OpenLocationButton>
                </div>
              </Notice>
            </div>
          ) : null}

          <div className="mt-4 space-y-4">
            {allRows.length === 0 ? (
              <Notice title="Ingen tilbud lige nu">
                Vi har ingen aktuelle tilbud på sunde basisvarer. Se{" "}
                <Link href="/status">Datastatus</Link> for, hvornår data sidst blev hentet.
              </Notice>
            ) : listings.length === 0 ? null : groups.length === 0 ? (
              <Notice title="Ingen sikre gode køb i denne uge">
                Ingen af ugens {listings.length} tilbud er dokumenteret billigere end samme vare i
                nærheden.
                <div>
                  <Link
                    href={dealsHref("alle", chainParam) as Route}
                    className="mt-2 inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-4 font-medium text-ink no-underline hover:bg-surface-2"
                  >
                    Se alle tilbud
                  </Link>
                </div>
              </Notice>
            ) : (
              <>
                {groups.map((group) => (
                  <CollapsibleCategory
                    key={group.groupName}
                    id={`gruppe-${groupSlug(group.groupName)}`}
                    title={group.groupName}
                    count={group.listings.length}
                  >
                    <ul className="space-y-3">
                      {group.listings.map((listing) => (
                        <li key={listing.listingId}>
                          <DealCard listing={listing} ctx={ctx} />
                        </li>
                      ))}
                    </ul>
                  </CollapsibleCategory>
                ))}
              </>
            )}
          </div>

          {upcoming.length > 0 ? (
            <section aria-labelledby="kommende" className="mt-8">
              <h2 id="kommende" className="scroll-mt-28 text-heading font-semibold text-ink">
                Kommende tilbud
              </h2>
              <p className="text-meta text-ink-2">
                Fra aviser, der allerede er udkommet, men først gælder senere.
                {filter === "gode" && upcomingShown.length < upcoming.length ? (
                  <>
                    {" "}
                    {upcoming.length - upcomingShown.length} af {upcoming.length} er ikke
                    dokumenteret gode køb (endnu).{" "}
                    <Link href={`${dealsHref("alle", chainParam)}#kommende` as Route}>
                      Se alle kommende
                    </Link>
                  </>
                ) : null}
              </p>
              <div className="mt-2 space-y-4">
                {upcomingDays.map((day) => (
                  <CollapsibleCategory
                    key={day.day}
                    id={`kommende-${day.day}`}
                    title={`Fra ${formatDayDate(day.startsAt)}`}
                    count={day.listings.length}
                  >
                    <ul className="space-y-3">
                      {day.listings.map((listing) => (
                        <li key={listing.listingId}>
                          <DealCard listing={listing} ctx={ctx} />
                        </li>
                      ))}
                    </ul>
                  </CollapsibleCategory>
                ))}
              </div>
            </section>
          ) : null}

          {bonus.length > 0 ? (
            <section aria-labelledby="madspild-bonus" className="mt-8">
              <h2 id="madspild-bonus" className="text-heading font-semibold text-ink">
                Madspild – en heldig bonus
              </h2>
              <p className="text-meta text-ink-2">
                Nedsatte varer med kort holdbarhed i butikker nær dig. Udvalget skifter i løbet af
                dagen.
              </p>
              <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface px-4 lg:px-5">
                {bonus.map((item) => (
                  <li key={item.listingId}>
                    <FoodWasteItemRow item={item} now={now.toISOString()} showStore />
                  </li>
                ))}
              </ul>
              <Link href="/madspild" className="mt-1 inline-flex min-h-11 items-center text-meta">
                Se al madspild ({foodWaste.length})
              </Link>
            </section>
          ) : null}

          <details className="mt-8 rounded-xl border border-line bg-surface px-4">
            <summary className="flex h-11 items-center gap-1 font-medium text-ink">
              Sådan læser du tilbuddene
            </summary>
            <ul className="list-disc space-y-1.5 pb-4 pl-5 text-meta text-ink-2">
              <li>
                <strong className="text-ink">Spar</strong> er forskellen til den laveste normalpris
                på præcis samme vare i en butik nær dig, for tilbuddets mindste pakning. Kender vi
                ikke normalprisen, står der &quot;Normalpris ukendt&quot; – vi gætter aldrig.
              </li>
              <li>
                <strong className="text-ink">Godt køb</strong> betyder, at tilbudsprisen er
                dokumenteret mindst lige så lav som præcis samme vare i butikkerne omkring dig.
              </li>
              <li>
                Vi sammenligner kun præcis samme vare: type, fedtprocent, økologi, laktosefri og
                forarbejdning.
              </li>
              <li>Tilbuddets dyreste pakning sammenlignes med den billigste pris andre steder.</li>
              <li>
                Vi viser kun tilbud fra kæder med en butik inden for din afstand, og andre kæders
                priser tæller kun, hvis kæden har en butik der.
              </li>
              <li>
                Tilbudsaviser gælder i hele kæden. Vi viser de nærmeste butikker, men ved ikke, om
                de har varen på hylden.
              </li>
            </ul>
          </details>
        </div>

        <aside aria-label="Butikker i nærheden" className="hidden lg:block">
          <SideMap
            stores={stores.map((s) => toMapStore(s))}
            user={{ lat: location.lat, lon: location.lon }}
            radiusKm={location.radiusKm}
            mode="stores"
            legend={legend}
          />
        </aside>
      </div>
    </MapFocusProvider>
  );
}
