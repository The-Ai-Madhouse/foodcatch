import type { Metadata, Route } from "next";
import { CategoryOverview, CollapsibleCategory } from "@/components/CategoryOverview";
import { Notice } from "@/components/Notice";
import { Segmented } from "@/components/Segmented";
import { FoodWasteItemRow } from "@/components/foodwaste/FoodWasteItemRow";
import { StoreGroup } from "@/components/foodwaste/StoreGroup";
import { ChevronIcon } from "@/components/Icons";
import { OpenLocationButton } from "@/components/location/LocationControl";
import { MapFocusProvider } from "@/components/map/MapFocus";
import { SideMap } from "@/components/map/SideMap";
import { latestSeen, type FoodWasteItem } from "@/lib/foodwaste";
import { daysFromToday, formatClock, formatRelative } from "@/lib/format";
import { countByGroup, groupOfClassKey, groupSlug, parseGroupFilter } from "@/lib/groups";
import {
  compareByDiscount,
  groupByStore,
  storeAddress,
  storeDisplayName,
  type MapStore,
} from "@/lib/stores";
import { getUserLocation } from "@/server/location";
import { getFoodWasteNear, getLatestRun } from "@/server/queries";

export const metadata: Metadata = { title: "Madspild nær dig" };

/** Rows shown per store before "Vis {k} mere". */
const VISIBLE_PER_STORE = 4;

const DAY_MS = 86_400_000;

/** The page's URL with a sort order and a category (both optional). */
function foodWasteHref(sort: "afstand" | "rabat", category: string | null): string {
  const params = new URLSearchParams();
  if (sort === "rabat") params.set("sorter", "rabat");
  if (category) params.set("kategori", groupSlug(category));
  const query = params.toString();
  return query ? `/madspild?${query}` : "/madspild";
}

function parseSort(value: string | string[] | undefined): "afstand" | "rabat" {
  return value === "rabat" ? "rabat" : "afstand";
}

/** "opdateret kl. 13.37", "opdateret i går kl. 22.10", or relative (and stale) after 24 h. */
function updatedText(at: string | null, now: Date): { text: string; stale: boolean } | null {
  if (!at) return null;
  const age = now.getTime() - Date.parse(at);
  if (age > DAY_MS) return { text: `opdateret ${formatRelative(at, now)}`, stale: true };
  const day = daysFromToday(at, now) === 0 ? "" : "i går ";
  return { text: `opdateret ${day}kl. ${formatClock(at)}`, stale: false };
}

export default async function FoodWastePage({ searchParams }: PageProps<"/madspild">) {
  const params = await searchParams;
  const sort = parseSort(params.sorter);
  const location = await getUserLocation();
  const [allItems, run] = await Promise.all([
    getFoodWasteNear(location),
    getLatestRun("salling-food-waste"),
  ]);
  const groupOf = (item: FoodWasteItem) => groupOfClassKey(item.classKey);
  const categories = countByGroup(allItems, groupOf);
  const category = parseGroupFilter(params.kategori, categories);
  const items = category ? allItems.filter((i) => groupOf(i) === category) : allItems;
  const now = new Date();
  const nowIso = now.toISOString();
  const groups = groupByStore(items);
  const updated = updatedText(run?.finishedAt ?? latestSeen(allItems), now);
  const mapStores: MapStore[] = groups.map((g) => {
    const first = g.items[0] as FoodWasteItem;
    return {
      id: g.storeId,
      chainId: first.chainId,
      name: storeDisplayName(first.storeName, first.chainId),
      street: first.street,
      zip: first.zip,
      city: first.city,
      lat: first.lat,
      lon: first.lon,
      distanceKm: g.distanceKm,
      foodWasteCount: g.items.length,
      cheaperCount: 0,
      source: "salling",
      sourceStoreId: null,
    };
  });

  return (
    <MapFocusProvider>
      <div className="lg:grid lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:gap-8">
        <div className="min-w-0">
          <h1 className="text-display shelf text-ink">Madspild nær dig</h1>
          {items.length > 0 ? (
            <p className="text-meta text-ink-2">
              {items.length} {items.length === 1 ? "vare" : "varer"} i {groups.length}{" "}
              {groups.length === 1 ? "butik" : "butikker"}
              {updated ? (
                <span className={updated.stale ? "text-warn-fg" : undefined}>
                  {" "}
                  · {updated.text}
                </span>
              ) : null}
            </p>
          ) : null}

          {allItems.length === 0 ? (
            <div className="mt-4">
              <Notice title={`Ingen madspild inden for ${location.radiusKm} km lige nu`}>
                Udvalget skifter i løbet af dagen. Prøv igen senere eller vælg en større afstand.
                <div>
                  <OpenLocationButton>Skift afstand</OpenLocationButton>
                </div>
              </Notice>
            </div>
          ) : (
            <>
              <div className="mt-3">
                <Segmented
                  label="Sortering"
                  items={[
                    {
                      href: foodWasteHref("afstand", category) as Route,
                      label: "Nærmest",
                      active: sort === "afstand",
                    },
                    {
                      href: foodWasteHref("rabat", category) as Route,
                      label: "Størst rabat",
                      active: sort === "rabat",
                    },
                  ]}
                />
              </div>

              {categories.length > 1 ? (
                <div className="mt-3">
                  <CategoryOverview
                    label="Kategorier"
                    links={[
                      {
                        label: "Alle",
                        count: allItems.length,
                        href: foodWasteHref(sort, null),
                        active: category == null,
                      },
                      ...categories.map((c) => ({
                        label: c.name,
                        count: c.count,
                        href: foodWasteHref(sort, c.name),
                        active: c.name === category,
                      })),
                    ]}
                  />
                </div>
              ) : null}

              {sort === "afstand" ? (
                <div className="mt-4 space-y-3">
                  {groups.map((group) => {
                    const first = group.items[0] as FoodWasteItem;
                    const visible = group.items.slice(0, VISIBLE_PER_STORE);
                    const more = group.items.slice(VISIBLE_PER_STORE);
                    return (
                      <StoreGroup
                        key={group.storeId}
                        storeId={group.storeId}
                        chainId={first.chainId}
                        name={storeDisplayName(first.storeName, first.chainId)}
                        address={storeAddress(first)}
                        addressParts={{ street: first.street, zip: first.zip, city: first.city }}
                        distanceKm={group.distanceKm}
                        lat={first.lat}
                        lon={first.lon}
                        itemCount={group.items.length}
                      >
                        <ul className="divide-y divide-line px-4 lg:px-5">
                          {visible.map((item) => (
                            <li key={item.listingId}>
                              <FoodWasteItemRow item={item} now={nowIso} />
                            </li>
                          ))}
                        </ul>
                        {more.length > 0 ? (
                          <details className="group/more border-t border-line">
                            <summary className="flex h-11 items-center gap-1 px-4 text-meta font-medium text-link lg:px-5">
                              <span className="group-open/more:hidden">Vis {more.length} mere</span>
                              <span className="hidden group-open/more:inline">Vis færre</span>
                              <ChevronIcon className="details-chevron" />
                            </summary>
                            <ul className="divide-y divide-line border-t border-line px-4 lg:px-5">
                              {more.map((item) => (
                                <li key={item.listingId}>
                                  <FoodWasteItemRow item={item} now={nowIso} />
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </StoreGroup>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  {countByGroup(items, groupOf).map((group) => (
                    <CollapsibleCategory
                      key={group.slug}
                      id={`kategori-${group.slug}`}
                      title={group.name}
                      count={group.count}
                    >
                      <ul className="divide-y divide-line rounded-xl border border-line bg-surface px-4 lg:px-5">
                        {items
                          .filter((item) => groupOf(item) === group.name)
                          .sort(compareByDiscount)
                          .map((item) => (
                            <li key={item.listingId}>
                              <FoodWasteItemRow item={item} now={nowIso} showStore />
                            </li>
                          ))}
                      </ul>
                    </CollapsibleCategory>
                  ))}
                </div>
              )}

              <p className="mt-4 text-meta text-ink-3">
                Lageret er et øjebliksbillede fra seneste opdatering. Varen kan være udsolgt.
              </p>
            </>
          )}
        </div>

        <aside aria-label="Butikker med madspild" className="hidden lg:block">
          <SideMap
            stores={mapStores}
            user={{ lat: location.lat, lon: location.lon }}
            radiusKm={location.radiusKm}
            mode="foodwaste"
          />
        </aside>
      </div>
    </MapFocusProvider>
  );
}
