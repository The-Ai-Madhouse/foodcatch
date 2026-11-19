import type { Metadata } from "next";
import { MapExplorer, type CheaperRow } from "@/components/map/MapExplorer";
import { chainName } from "@/lib/chains";
import { cheaperByChain, evaluateDeals, groupByListing, referenceListingIds } from "@/lib/deals";
import type { FoodWasteItem } from "@/lib/foodwaste";
import { formatDkk, formatUnitPrice, formatUnitPriceRange, packSize } from "@/lib/format";
import { sourceLink } from "@/lib/sources";
import { nearestByChain, shortStoreName, toMapStore } from "@/lib/stores";
import { getUserLocation } from "@/server/location";
import {
  getCurrentDeals,
  getFoodWasteNear,
  getNearbyStores,
  getReferenceDetails,
} from "@/server/queries";

export const metadata: Metadata = { title: "Kort over butikker" };

function parseChains(value: string | string[] | undefined): string[] | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const chains = value
    .split(",")
    .map((c) => c.trim())
    .filter((c) => /^[a-z0-9]+$/.test(c));
  return chains.length ? chains : null;
}

export default async function MapPage({ searchParams }: PageProps<"/kort">) {
  const params = await searchParams;
  const location = await getUserLocation();
  const [stores, items, rows] = await Promise.all([
    getNearbyStores(location),
    getFoodWasteNear(location),
    getCurrentDeals("netto"),
  ]);
  const now = new Date();
  const nearbyChains = new Set(nearestByChain(stores).keys());
  const deals = evaluateDeals(rows, nearbyChains);
  const details = await getReferenceDetails(referenceListingIds(rows));
  const nettoGoodCount = groupByListing(deals).filter((l) => l.status === "good_deal").length;

  const cheaper: Record<string, CheaperRow[]> = {};
  for (const [chainId, list] of cheaperByChain(deals, nearbyChains)) {
    cheaper[chainId] = list.map(({ deal, ref }) => {
      const detail = ref.listing_id ? details.get(ref.listing_id) : undefined;
      const size = detail
        ? packSize({
            unit: detail.unit,
            sizeMin: detail.sizeMin,
            sizeMax: detail.sizeMax,
            source: detail.source,
            description: detail.description,
          }).text
        : "Vægt ukendt";
      return {
        key: `${deal.listingId}-${deal.variantIndex}`,
        title: deal.title,
        verdict: deal.status === "cheaper_elsewhere" ? "cheaper" : "maybe",
        chain: chainName(chainId),
        // Tjek titles often repeat the chain ("REMA 1000 Skiveost"); the chain is shown already.
        name: ref.title ? shortStoreName(ref.title, chainId) : null,
        facts: [
          size,
          detail?.price != null ? formatDkk(detail.price) : null,
          formatUnitPrice(ref.unit_price, ref.unit ?? deal.unit),
        ]
          .filter(Boolean)
          .join(" · "),
        netto:
          formatUnitPriceRange(deal.targetUnitPriceBest, deal.targetUnitPriceWorst, deal.unit) ??
          "ukendt",
        link: detail
          ? sourceLink(
              {
                source: detail.source,
                chainId: detail.chainId,
                sourceItemId: detail.sourceItemId,
                catalogId: detail.catalogId,
                validTo: detail.validTo,
              },
              now,
            )
          : null,
      };
    });
  }

  const foodWaste: Record<string, FoodWasteItem[]> = {};
  for (const item of items) (foodWaste[item.storeId] ??= []).push(item);
  const mapStores = stores.map((s) =>
    toMapStore(s, {
      foodWasteCount: foodWaste[s.id]?.length ?? 0,
      cheaperCount: cheaper[s.chainId]?.length ?? 0,
    }),
  );
  const butik = typeof params.butik === "string" ? params.butik : null;

  return (
    <>
      <h1 className="sr-only">Kort over butikker</h1>
      <MapExplorer
        stores={mapStores}
        user={{ lat: location.lat, lon: location.lon }}
        radiusKm={location.radiusKm}
        foodWaste={foodWaste}
        cheaper={cheaper}
        nettoGoodCount={nettoGoodCount}
        initialChains={parseChains(params.kaede)}
        initialStoreId={butik && mapStores.some((s) => s.id === butik) ? butik : null}
        now={now.toISOString()}
      />
    </>
  );
}
