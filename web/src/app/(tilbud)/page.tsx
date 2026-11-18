import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/Notice";
import { Segmented } from "@/components/Segmented";
import { DealCard, type DealContext } from "@/components/deals/DealCard";
import { OpenLocationButton } from "@/components/location/LocationControl";
import { MapFocusProvider } from "@/components/map/MapFocus";
import { SideMap } from "@/components/map/SideMap";
import {
  evaluateDeals,
  filterListings,
  groupByListing,
  groupListings,
  parseDealFilter,
  referenceListingIds,
} from "@/lib/deals";
import { formatDistance } from "@/lib/format";
import { nearestByChain, shortStoreName, toMapStore, type NearbyStore } from "@/lib/stores";
import { getUserLocation } from "@/server/location";
import {
  getCurrentNettoDeals,
  getNearbyStores,
  getNearestStore,
  getReferenceDetails,
} from "@/server/queries";

export const metadata: Metadata = { title: "Ugens tilbud i Netto" };

export default async function HomePage({ searchParams }: PageProps<"/">) {
  const filter = parseDealFilter((await searchParams).vis);
  const location = await getUserLocation();
  const [stores, rows] = await Promise.all([getNearbyStores(location), getCurrentNettoDeals()]);
  const storesByChain = nearestByChain(stores);
  const nearbyChains = new Set(storesByChain.keys());
  const [details, nettoOutside] = await Promise.all([
    getReferenceDetails(referenceListingIds(rows)),
    nearbyChains.has("netto") ? Promise.resolve(null) : getNearestStore(location, "netto"),
  ]);

  const listings = groupByListing(evaluateDeals(rows, nearbyChains));
  const goodCount = listings.filter((l) => l.status === "good_deal").length;
  const groups = groupListings(filterListings(listings, filter));
  const ctx: DealContext = {
    nearbyChains,
    storesByChain,
    nearestOutside: new Map<string, NearbyStore | null>([["netto", nettoOutside]]),
    radiusKm: location.radiusKm,
    details,
    now: new Date(),
  };
  const legend = [...storesByChain.entries()].map(([chainId, list]) => ({
    chainId,
    nearestKm: list[0]?.distanceKm ?? 0,
  }));

  return (
    <MapFocusProvider>
      <div className="lg:grid lg:grid-cols-[minmax(0,640px)_minmax(0,1fr)] lg:gap-8">
        <div className="min-w-0">
          <h1 className="text-title font-bold text-ink">Ugens tilbud i Netto</h1>
          <div className="mt-3">
            <Segmented
              label="Vis tilbud"
              items={[
                { href: "/", label: `Gode køb (${goodCount})`, active: filter === "gode" },
                {
                  href: "/?vis=alle",
                  label: `Alle (${listings.length})`,
                  active: filter === "alle",
                },
              ]}
            />
          </div>

          {!nearbyChains.has("netto") ? (
            <div className="mt-4">
              <Notice tone="warn">
                Der er ingen Netto inden for {location.radiusKm} km.
                {nettoOutside
                  ? ` Nærmeste er ${shortStoreName(nettoOutside.name, "netto")}, ${formatDistance(nettoOutside.distanceKm)}.`
                  : ""}
                <div>
                  <OpenLocationButton>Skift afstand</OpenLocationButton>
                </div>
              </Notice>
            </div>
          ) : null}

          <div className="mt-4 space-y-8">
            {listings.length === 0 ? (
              <Notice title="Ingen tilbud lige nu">
                Vi har ingen aktuelle Netto-tilbud på sunde basisvarer. Se{" "}
                <Link href="/status">Datastatus</Link> for, hvornår data sidst blev hentet.
              </Notice>
            ) : groups.length === 0 ? (
              <Notice title="Ingen sikre gode køb i denne uge">
                Ingen af ugens {listings.length} tilbud er dokumenteret billigere end samme vare i
                nærheden.
                <div>
                  <Link
                    href="/?vis=alle"
                    className="mt-2 inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-4 font-medium text-ink no-underline hover:bg-surface-2"
                  >
                    Se alle tilbud
                  </Link>
                </div>
              </Notice>
            ) : (
              groups.map((group) => (
                <section key={group.groupName} aria-labelledby={`gruppe-${group.groupName}`}>
                  <h2
                    id={`gruppe-${group.groupName}`}
                    className="mb-2 text-meta font-semibold text-ink-3"
                  >
                    {group.groupName}
                  </h2>
                  <ul className="space-y-3">
                    {group.listings.map((listing) => (
                      <li key={listing.listingId}>
                        <DealCard listing={listing} ctx={ctx} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>

          <details className="mt-8 rounded-xl border border-line bg-surface px-4">
            <summary className="flex h-11 items-center gap-1 font-medium text-ink">
              Sådan læser du tilbuddene
            </summary>
            <ul className="list-disc space-y-1.5 pb-4 pl-5 text-meta text-ink-2">
              <li>
                <strong className="text-ink">Godt køb</strong> betyder, at Nettos pris er
                dokumenteret mindst lige så lav som præcis samme vare i butikkerne omkring dig.
              </li>
              <li>
                Vi sammenligner kun præcis samme vare: type, fedtprocent, økologi, laktosefri og
                forarbejdning.
              </li>
              <li>Nettos dyreste pakning sammenlignes med den billigste pris andre steder.</li>
              <li>
                Andre kæders priser tæller kun, hvis kæden har en butik inden for din afstand.
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
