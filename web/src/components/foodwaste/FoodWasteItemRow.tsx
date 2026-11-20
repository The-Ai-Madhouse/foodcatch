import type { Route } from "next";
import Link from "next/link";
import { Badge, DiscountPill, MemberPriceTag } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { ChevronIcon } from "@/components/Icons";
import { SourceLink } from "@/components/SourceLink";
import { chainName } from "@/lib/chains";
import { cleanClassLabel, referenceKindLabel } from "@/lib/deals";
import {
  competitorBadge,
  foodWastePackSize,
  foodWasteUnitPrice,
  shownDiscount,
  sortedReferences,
  type FoodWasteItem,
} from "@/lib/foodwaste";
import {
  displayTitle,
  formatDateTime,
  formatDistance,
  formatDkk,
  formatEnd,
  formatPercent,
  formatRelative,
  formatStock,
  formatUnitPrice,
} from "@/lib/format";
import { productPath } from "@/lib/routes";
import { FOOD_WASTE_SOURCE_TEXT, openFoodFactsProductLink } from "@/lib/sources";
import { storeDisplayName, storePin, type StorePin } from "@/lib/stores";
import { StoreInfo } from "@/components/StoreInfo";

/** The store of a clearance, for the store popover. */
export function itemStore(item: FoodWasteItem): StorePin {
  return storePin({ ...item, id: item.storeId, name: item.storeName });
}

const sep = <span aria-hidden="true"> · </span>;

/** The product photo, or a neutral square with the type's first letter. */
function Thumb({ item, size }: { item: FoodWasteItem; size: "sm" | "lg" }) {
  const dims = size === "sm" ? "size-14" : "size-60 max-w-full";
  if (!item.imageUrl) {
    return (
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-lg bg-surface-2 text-heading font-semibold text-ink-3 ${dims}`}
      >
        {item.typeLabel.charAt(0).toLocaleUpperCase("da-DK")}
      </span>
    );
  }
  return (
    // Plain <img>: next/image would proxy Salling's CDN through this server.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={item.imageUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className={`shrink-0 rounded-lg bg-white object-contain ${dims}`}
    />
  );
}

/** One fact of the "Kilde" list. */
function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-ink-3">{term}</dt>
      <dd className="min-w-0 break-words text-ink-2">{children}</dd>
    </div>
  );
}

/**
 * One clearance (docs/ui.md §6.2): photo, sentence-case name, price before and after, pack size,
 * stock, end and – when it is cheaper than every same-class price of the other chains – a badge.
 * Expands to "Kilde" (what Salling's API said, when it was fetched, EAN, product code and store)
 * and the competitor prices it was compared with. Below the row, always visible: the item on Open
 * Food Facts (when it has an EAN) and its price history. Renders in server and client components.
 */
export function FoodWasteItemRow({
  item,
  now,
  showStore = false,
}: {
  item: FoodWasteItem;
  /** ISO time of the request (stable between server and client rendering). */
  now: string;
  /** Show the store line (flat list sorted by discount). */
  showStore?: boolean;
}) {
  const nowDate = new Date(now);
  const size = foodWastePackSize(item);
  const unitPrice = foodWasteUnitPrice(item);
  const discount = shownDiscount(item.discountPct);
  const stock = formatStock(item.stock, item.stockUnit);
  const off = openFoodFactsProductLink(item.ean);
  const badge = competitorBadge(item);
  const references = sortedReferences(item);
  const facts = [stock, item.validTo ? formatEnd(item.validTo, nowDate) : null].filter(Boolean);

  return (
    <>
      <details className="group">
        <summary className="flex min-h-[72px] gap-3 py-3">
          <Thumb item={item} size="sm" />
          <span className="block min-w-0 flex-1">
            <span className="flex items-start justify-between gap-2">
              <span title={item.title} className="min-w-0 font-medium text-ink">
                {displayTitle(item.title)}
              </span>
              <ChevronIcon className="mt-0.5 details-chevron text-ink-3" />
            </span>
            <span className="flex flex-wrap items-center gap-x-2 text-meta text-ink-2">
              <span className="text-body font-bold text-ink tabular">{formatDkk(item.price)}</span>
              {item.referencePrice != null && item.referencePrice > item.price ? (
                <span className="tabular">
                  før <s>{formatDkk(item.referencePrice)}</s>
                </span>
              ) : null}
              {discount != null ? <DiscountPill percent={discount} /> : null}
            </span>
            <span className="block text-meta text-ink-2">
              <span className={size.origin === "unknown" ? "text-ink-3" : "text-ink"}>
                {size.text}
              </span>
              {unitPrice != null ? (
                <>
                  {sep}
                  <span className="whitespace-nowrap tabular">
                    {formatUnitPrice(unitPrice, item.unit)}
                  </span>
                </>
              ) : null}
              {facts.map((fact) => (
                <span key={fact}>
                  {sep}
                  <span className="whitespace-nowrap">{fact}</span>
                </span>
              ))}
            </span>
            {badge ? (
              <span className="mt-1 block">
                <Badge tone="good">{badge}</Badge>
              </span>
            ) : null}
            {showStore ? (
              <span className="mt-0.5 flex items-center gap-1.5 text-meta text-ink-2">
                <StoreInfo chainId={item.chainId} stores={[itemStore(item)]}>
                  <ChainDot chainId={item.chainId} size="xs" />
                  {storeDisplayName(item.storeName, item.chainId)}
                </StoreInfo>
                {sep}
                <span className="tabular">{formatDistance(item.distanceKm)}</span>
              </span>
            ) : null}
          </span>
        </summary>
        <div className="space-y-3 pb-3 pl-[68px] text-meta text-ink-2">
          {item.imageUrl ? <Thumb item={item} size="lg" /> : null}
          <p>{cleanClassLabel(item.classLabel)}</p>
          <section aria-label="Kilde">
            <h4 className="font-semibold text-ink">Kilde</h4>
            <dl className="mt-1 space-y-0.5">
              <Fact term="Pris nu">
                <span className="tabular">{formatDkk(item.price)}</span>
              </Fact>
              {item.referencePrice != null ? (
                <Fact term="Normalpris">
                  <span className="tabular">{formatDkk(item.referencePrice)}</span>
                </Fact>
              ) : null}
              {item.sallingPercentDiscount != null ? (
                <Fact term="Rabat">
                  <span className="tabular">{formatPercent(item.sallingPercentDiscount, 1)}</span>
                </Fact>
              ) : null}
              {item.sourceFetchedAt ? (
                <Fact term="Hentet">{formatDateTime(item.sourceFetchedAt)}</Fact>
              ) : null}
              {item.lastSeenAt ? (
                <Fact term="Lager set">{formatRelative(item.lastSeenAt, nowDate)}</Fact>
              ) : null}
              {item.ean ? (
                <Fact term="EAN">
                  <span className="tabular">{item.ean}</span>
                </Fact>
              ) : null}
              {item.productCode && item.productCode !== item.ean ? (
                <Fact term="Varekode">
                  <span className="tabular">{item.productCode}</span>
                </Fact>
              ) : null}
              {item.offerEan ? (
                <Fact term="Etiketkode">
                  <span className="tabular">{item.offerEan}</span>
                </Fact>
              ) : null}
              <Fact term="Butik">
                <StoreInfo chainId={item.chainId} stores={[itemStore(item)]}>
                  {storeDisplayName(item.storeName, item.chainId)}
                </StoreInfo>
                {item.sallingStoreId ? (
                  <span className="text-ink-3"> (Salling-id {item.sallingStoreId})</span>
                ) : null}
              </Fact>
            </dl>
            <p className="mt-1 text-ink-3">{FOOD_WASTE_SOURCE_TEXT}</p>
          </section>
          {references.length > 0 && unitPrice != null ? (
            <section aria-label="Sammenligning">
              <h4 className="font-semibold text-ink">
                {item.beatsCompetitors
                  ? `Billigere end ${references.length === 1 ? "samme vare" : `alle ${references.length} priser på samme vare`} i andre kæder`
                  : "Samme vare i andre kæder"}
              </h4>
              <p className="text-ink-3">
                Her: <span className="tabular">{formatUnitPrice(unitPrice, item.unit)}</span>
              </p>
              <ul className="mt-1 space-y-0.5">
                {references.map((ref, i) => (
                  <li
                    key={`${ref.listing_id ?? ref.chain_id}-${i}`}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ChainDot chainId={ref.chain_id} size="xs" />
                      <span className="text-ink">{chainName(ref.chain_id)}</span>
                      <span className="text-ink-3">
                        · {referenceKindLabel(ref.kind, item.chainId)}
                      </span>
                      {ref.member_only ? <MemberPriceTag /> : null}
                    </span>
                    <span className="whitespace-nowrap tabular">
                      {formatUnitPrice(ref.unit_price, ref.unit ?? item.unit)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </details>
      {off || item.productKey ? (
        <p className="-mt-2 flex flex-wrap items-center gap-x-4 pb-1 sm:pl-[68px]">
          {off ? <SourceLink link={off} className="min-h-11" /> : null}
          {item.productKey ? (
            <Link
              href={productPath(item.productKey) as Route}
              className="inline-flex min-h-11 items-center text-meta"
            >
              Prishistorik
            </Link>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
