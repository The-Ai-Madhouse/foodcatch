import { DiscountPill } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { ChevronIcon } from "@/components/Icons";
import { SourceLink } from "@/components/SourceLink";
import { cleanClassLabel } from "@/lib/deals";
import {
  foodWastePackSize,
  foodWasteUnitPrice,
  shownDiscount,
  type FoodWasteItem,
} from "@/lib/foodwaste";
import {
  displayTitle,
  formatDistance,
  formatDkk,
  formatEnd,
  formatRelative,
  formatStock,
  formatUnitPrice,
} from "@/lib/format";
import { FOOD_WASTE_SOURCE_TEXT, openFoodFactsLink } from "@/lib/sources";
import { storeDisplayName } from "@/lib/stores";

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

/**
 * One clearance (docs/ui.md §6.2): photo, sentence-case name, price before and after, pack size,
 * stock and end. Expands to the evidence: a larger photo, EAN, the Open Food Facts weight link and
 * when the stock was seen. Renders in server and client components alike.
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
  const off = size.origin === "off" ? openFoodFactsLink(item.ean) : null;
  const facts = [stock, item.validTo ? formatEnd(item.validTo, nowDate) : null].filter(Boolean);

  return (
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
          {showStore ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-meta text-ink-2">
              <ChainDot chainId={item.chainId} size="xs" />
              {storeDisplayName(item.storeName, item.chainId)}
              {sep}
              <span className="tabular">{formatDistance(item.distanceKm)}</span>
            </span>
          ) : null}
        </span>
      </summary>
      <div className="space-y-1 pb-4 pl-[68px] text-meta text-ink-2">
        {item.imageUrl ? <Thumb item={item} size="lg" /> : null}
        <p>{cleanClassLabel(item.classLabel)}</p>
        {item.ean ? <p className="tabular">EAN {item.ean}</p> : null}
        {off ? (
          <p>
            <SourceLink link={off} />
          </p>
        ) : null}
        {item.lastSeenAt ? <p>Sidst set {formatRelative(item.lastSeenAt, nowDate)}</p> : null}
        <p className="text-ink-3">{FOOD_WASTE_SOURCE_TEXT}</p>
      </div>
    </details>
  );
}
