import type { Route } from "next";
import Link from "next/link";
import { MemberBadge, VerdictBadge } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { SourceLink } from "@/components/SourceLink";
import { chainName } from "@/lib/chains";
import {
  cleanClassLabel,
  referenceKindLabel,
  referenceViews,
  verdictReason,
  type EvaluatedDeal,
  type ListingDeal,
  type NearestDistance,
  type ReferenceDetail,
  type ReferenceView,
} from "@/lib/deals";
import {
  formatDistance,
  formatDkk,
  formatShortPeriod,
  formatUnitPrice,
  formatUnitPriceRange,
  packSize,
} from "@/lib/format";
import { classPath, productPath } from "@/lib/routes";
import { sourceLink } from "@/lib/sources";
import { shortStoreName, type NearbyStore } from "@/lib/stores";
import { LOCATION_INDEPENDENT_KINDS } from "@/lib/verdict";
import { Comparison, type ComparisonRow, type ComparisonSection } from "./Comparison";
import { WhereLine } from "./WhereLine";

/** What a card needs to know about the user's surroundings. */
export interface DealContext {
  nearbyChains: ReadonlySet<string>;
  /** Stores of each chain within the radius, nearest first. */
  storesByChain: ReadonlyMap<string, readonly NearbyStore[]>;
  /** Nearest store of a chain outside the radius (when it has none inside). */
  nearestOutside: ReadonlyMap<string, NearbyStore | null>;
  radiusKm: number;
  details: ReadonlyMap<string, ReferenceDetail>;
  now: Date;
}

const sep = <span aria-hidden="true"> · </span>;

/** One offer of any chain: price, size, where, verdict and the comparison (docs/ui.md §5.6). */
export function DealCard({ listing, ctx }: { listing: ListingDeal; ctx: DealContext }) {
  const { offer, variants } = listing;
  const several = variants.length > 1;
  const headingId = `tilbud-${listing.listingId}`;
  const size = packSize({
    unit: offer.unit,
    sizeMin: offer.sizeMin,
    sizeMax: offer.sizeMax,
    source: offer.source,
    description: offer.description,
  });
  const unitPrice = formatUnitPriceRange(offer.unitPriceMin, offer.unitPriceMax, offer.unit);
  const nearestKm: NearestDistance = (chainId) =>
    ctx.storesByChain.get(chainId)?.[0]?.distanceKm ?? null;
  const upcoming = Date.parse(offer.validFrom) > ctx.now.getTime();
  const counted = variants.reduce(
    (sum, v) => sum + referenceViews(v, ctx.nearbyChains).filter((r) => r.counts).length,
    0,
  );
  const hasReferences = variants.some((v) => v.status !== "pending" && v.references.length > 0);
  const link = sourceLink(
    {
      source: offer.source,
      chainId: offer.chainId,
      sourceItemId: offer.sourceItemId,
      catalogId: offer.catalogId,
      validTo: offer.validTo,
    },
    ctx.now,
  );

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-xl border border-line bg-surface p-4 lg:p-5"
    >
      <div className="flex items-start gap-3">
        <h3 id={headingId} className="min-w-0 flex-1 text-heading font-semibold text-ink">
          {offer.title}
        </h3>
        {!several || offer.memberOnly ? (
          <div className="mt-0.5 flex shrink-0 flex-col items-end gap-1">
            {!several ? (
              <VerdictBadge
                status={listing.status}
                memberOnly={offer.memberOnly}
                chainId={offer.chainId}
              />
            ) : null}
            {/* Required: a member price may only be "Godt køb" when marked (lib/deals.ts). */}
            {offer.memberOnly ? <MemberBadge chainId={offer.chainId} /> : null}
          </div>
        ) : null}
      </div>

      <p className="mt-1 text-meta text-ink-2">
        <span className="text-price font-bold text-ink tabular">{formatDkk(offer.price)}</span>
        {sep}
        <span className={size.origin === "unknown" ? "text-ink-3" : "text-ink"}>{size.text}</span>
        {unitPrice ? (
          <>
            {sep}
            <span className="whitespace-nowrap tabular">{unitPrice}</span>
          </>
        ) : null}
      </p>

      <ChainWhere chainId={offer.chainId} ctx={ctx} />

      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3">
        <p className="text-meta text-ink-3">
          {upcoming ? "Kommer: " : ""}
          {formatShortPeriod(offer.validFrom, offer.validTo)}
          {offer.maxPerCustomer ? ` · Max ${offer.maxPerCustomer} pr. kunde` : ""}
        </p>
        {offer.productKey ? <HistoryLink productKey={offer.productKey} /> : null}
      </div>

      {several ? (
        <ul className="mt-3 space-y-2 border-t border-line pt-3" aria-label="Varer i tilbuddet">
          {variants.map((v) => (
            <li key={v.variantIndex} className="flex items-start justify-between gap-3">
              <span className="min-w-0 text-meta text-ink-2">{cleanClassLabel(v.classLabel)}</span>
              <VerdictBadge status={v.status} memberOnly={v.memberOnly} chainId={v.chainId} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-ink-2">
          {verdictReason(variants[0] as EvaluatedDeal, ctx.nearbyChains, nearestKm)}
        </p>
      )}

      {hasReferences || link ? (
        <div className="relative mt-3 border-t border-line">
          {hasReferences ? (
            <Comparison
              count={counted}
              radiusKm={ctx.radiusKm}
              reserveRight={link != null}
              sections={variants.flatMap((v) =>
                v.status === "pending" ? [] : [comparisonSection(v, ctx, several)],
              )}
            />
          ) : null}
          {link ? (
            <div
              className={`flex h-11 items-center ${hasReferences ? "absolute top-0 right-0" : "justify-end"}`}
            >
              <SourceLink link={link} />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** "Prishistorik": the price history of one item (`/produkt/[productKey]`). */
function HistoryLink({ productKey, className = "" }: { productKey: string; className?: string }) {
  return (
    <Link
      href={productPath(productKey) as Route}
      className={`inline-flex min-h-11 items-center text-meta ${className}`}
    >
      Prishistorik
    </Link>
  );
}

/** The chain's nearest store within the radius, or how far the nearest one is. */
function ChainWhere({ chainId, ctx }: { chainId: string; ctx: DealContext }) {
  const stores = ctx.storesByChain.get(chainId) ?? [];
  const nearest = stores[0];
  if (nearest) {
    return (
      <WhereLine
        chainId={chainId}
        nearestName={shortStoreName(nearest.name, chainId)}
        nearestDistance={formatDistance(nearest.distanceKm)}
        moreCount={stores.length - 1}
      />
    );
  }
  // The page explains it in a notice; the card only says where the nearest store is.
  const outside = ctx.nearestOutside.get(chainId);
  return (
    <p className="flex min-h-11 items-center gap-2 text-meta text-warn-fg">
      <ChainDot chainId={chainId} />
      <span>
        <span className="sr-only">
          Ingen {chainName(chainId)} inden for {ctx.radiusKm} km.
          {outside ? " Nærmeste butik: " : ""}
        </span>
        {outside ? (
          <>
            <strong className="font-semibold">{chainName(chainId)}</strong>{" "}
            {shortStoreName(outside.name, chainId)}
            <span className="whitespace-nowrap tabular">
              {" "}
              · {formatDistance(outside.distanceKm)}
            </span>
            <span aria-hidden="true"> · uden for din afstand</span>
          </>
        ) : (
          <span aria-hidden="true">
            Ingen {chainName(chainId)} inden for {ctx.radiusKm} km
          </span>
        )}
      </span>
    </p>
  );
}

/** The comparison of one variant as plain data for the client {@link Comparison}. */
function comparisonSection(
  deal: EvaluatedDeal,
  ctx: DealContext,
  labelled: boolean,
): ComparisonSection {
  const views = referenceViews(deal, ctx.nearbyChains);
  const rows = views.map((ref, i) => comparisonRow(ref, i, deal, ctx));
  return {
    key: String(deal.variantIndex),
    label: labelled ? cleanClassLabel(deal.classLabel) : null,
    counted: rows.filter((_, i) => views[i]?.counts),
    ignored: rows.filter((_, i) => !views[i]?.counts),
    classHref: classPath(deal.classKey),
  };
}

function comparisonRow(
  ref: ReferenceView,
  index: number,
  deal: EvaluatedDeal,
  ctx: DealContext,
): ComparisonRow {
  const detail = ref.listing_id ? ctx.details.get(ref.listing_id) : undefined;
  const km = LOCATION_INDEPENDENT_KINDS.has(ref.kind)
    ? null
    : (ctx.storesByChain.get(ref.chain_id)?.[0]?.distanceKm ?? null);
  const size = detail
    ? packSize({
        unit: detail.unit,
        sizeMin: detail.sizeMin,
        sizeMax: detail.sizeMax,
        source: detail.source,
        description: detail.description,
      })
    : null;
  const facts = [
    referenceKindLabel(ref.kind, deal.chainId),
    size && size.origin !== "unknown" ? size.text : null,
    detail?.price != null ? formatDkk(detail.price) : null,
    ref.valid_from || ref.valid_to ? formatShortPeriod(ref.valid_from, ref.valid_to) : null,
  ].filter(Boolean);
  const link = detail
    ? sourceLink(
        {
          source: detail.source,
          chainId: detail.chainId,
          sourceItemId: detail.sourceItemId,
          catalogId: detail.catalogId,
          validTo: detail.validTo,
        },
        ctx.now,
      )
    : null;
  return {
    key: `${ref.listing_id ?? ref.kind}-${index}`,
    chainId: ref.chain_id,
    chainName: chainName(ref.chain_id),
    distance: km != null ? formatDistance(km) : null,
    unitPrice: formatUnitPrice(ref.unit_price, ref.unit ?? deal.unit),
    isCheapest: ref.isCheapest,
    title: ref.title ?? null,
    facts: facts.join(" · "),
    memberOnly: ref.member_only === true,
    link,
    historyHref: detail?.productKey ? productPath(detail.productKey) : null,
  };
}
