import type { Metadata } from "next";
import { Badge } from "@/components/Badge";
import { LocationForm } from "@/components/LocationForm";
import { Notice } from "@/components/Notice";
import { PageHeader } from "@/components/PageHeader";
import { chainName } from "@/lib/chains";
import {
  formatDateTime,
  formatDistance,
  formatDkk,
  formatNumber,
  formatPercent,
  formatUnitPrice,
} from "@/lib/format";
import { getUserLocation } from "@/server/location";
import { getFoodWasteNear, type FoodWasteItem } from "@/server/queries";

export const metadata: Metadata = { title: "Madspild nær dig" };

export default async function FoodWastePage() {
  const location = await getUserLocation();
  const items = await getFoodWasteNear(location);
  const stores = new Set(items.map((i) => i.storeId)).size;

  return (
    <>
      <PageHeader
        title="Madspild nær dig"
        lead="Nedsatte sunde basisvarer med kort holdbarhed i Netto, føtex og Bilka inden for din radius. Største rabat først."
      />
      <LocationForm
        label={location.label}
        radiusKm={location.radiusKm}
        isDefault={location.isDefault}
      />

      <section aria-labelledby="madspild-liste" className="mt-8">
        <h2 id="madspild-liste" className="text-xl font-bold text-ink">
          {items.length > 0
            ? `${items.length} ${items.length === 1 ? "vare" : "varer"} i ${stores} ${stores === 1 ? "butik" : "butikker"}`
            : "Ingen varer lige nu"}
        </h2>
        {items.length === 0 ? (
          <div className="mt-3">
            <Notice>
              Vi kender ingen nedsatte sunde basisvarer inden for {location.radiusKm} km lige nu.
              Udvalget skifter i løbet af dagen – prøv igen senere eller med en større radius.
            </Notice>
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {items.map((item) => (
              <li key={item.listingId}>
                <FoodWasteCard item={item} />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-6 text-sm text-ink-3">
          Kun varer, vi genkender som sunde basisvarer, vises. Lageret er et øjebliksbillede fra
          sidste opdatering og kan være udsolgt.
        </p>
      </section>
    </>
  );
}

function FoodWasteCard({ item }: { item: FoodWasteItem }) {
  const address = [item.street, [item.zip, item.city].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return (
    <article className="h-full rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-ink">{item.title}</h3>
          <p className="text-sm text-ink-2">{item.classLabel}</p>
        </div>
        {item.discountPct != null ? (
          <Badge tone="good">
            <span className="sr-only">Rabat </span>−{formatPercent(item.discountPct)}
          </Badge>
        ) : null}
      </div>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-lg font-bold text-ink tabular">{formatDkk(item.price)}</span>
        {item.referencePrice != null ? (
          <span className="text-ink-3 tabular">
            før <s>{formatDkk(item.referencePrice)}</s>
          </span>
        ) : null}
        {item.unitPrice != null ? (
          <span className="text-ink-2 tabular">· {formatUnitPrice(item.unitPrice, item.unit)}</span>
        ) : null}
      </p>
      <dl className="mt-3 space-y-1 text-sm text-ink-2">
        <div>
          <dt className="sr-only">Butik</dt>
          <dd>
            <span className="font-medium text-ink">
              {item.storeName || chainName(item.chainId)}
            </span>{" "}
            · {formatDistance(item.distanceKm)}
            {address ? <span className="block text-xs text-ink-3">{address}</span> : null}
          </dd>
        </div>
        {item.stock != null ? (
          <div>
            <dt className="inline">På lager: </dt>
            <dd className="inline tabular">
              {formatNumber(item.stock, Number.isInteger(item.stock) ? 0 : 2)}{" "}
              {item.stockUnit === "kg" ? "kg" : "stk."}
            </dd>
          </div>
        ) : null}
        {item.validTo ? (
          <div>
            <dt className="inline">Tilbuddet gælder til: </dt>
            <dd className="inline">{formatDateTime(item.validTo)}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}
