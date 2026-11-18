import type { Route } from "next";
import Link from "next/link";
import { MemberBadge, MemberPriceTag, VerdictBadge } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { ChevronIcon } from "@/components/Icons";
import { SourceLink } from "@/components/SourceLink";
import { chainName } from "@/lib/chains";
import {
  REFERENCE_KIND_LABELS,
  cleanClassLabel,
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
import { classPath } from "@/lib/routes";
import { sourceLink } from "@/lib/sources";
import { shortStoreName, type NearbyStore } from "@/lib/stores";
import { LOCATION_INDEPENDENT_KINDS } from "@/lib/verdict";
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

/** One Netto offer: price, size, where, verdict and the comparison (docs/ui.md §5.6). */
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
      chainId: "netto",
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
              <VerdictBadge status={listing.status} memberOnly={offer.memberOnly} />
            ) : null}
            {/* Required: a member price may only be "Godt køb" when marked (lib/deals.ts). */}
            {offer.memberOnly ? <MemberBadge /> : null}
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

      <ChainWhere chainId="netto" ctx={ctx} />

      <p className="text-meta text-ink-3">
        {upcoming ? "Kommer: " : ""}
        {formatShortPeriod(offer.validFrom, offer.validTo)}
        {offer.maxPerCustomer ? ` · Max ${offer.maxPerCustomer} pr. kunde` : ""}
      </p>

      {several ? (
        <ul className="mt-3 space-y-2 border-t border-line pt-3" aria-label="Varer i tilbuddet">
          {variants.map((v) => (
            <li key={v.variantIndex} className="flex items-start justify-between gap-3">
              <span className="min-w-0 text-meta text-ink-2">{cleanClassLabel(v.classLabel)}</span>
              <VerdictBadge status={v.status} memberOnly={v.memberOnly} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-meta text-ink-2">
          {verdictReason(variants[0] as EvaluatedDeal, ctx.nearbyChains, nearestKm)}
        </p>
      )}

      {hasReferences || link ? (
        <div className="relative mt-3 border-t border-line">
          {hasReferences ? (
            <details className="group">
              <summary className="flex h-11 items-center gap-1 pr-44 text-meta font-medium text-ink">
                Sammenlign ({counted})
                <ChevronIcon className="details-chevron text-ink-3" />
              </summary>
              <div className="space-y-4 pb-1">
                {variants.map((v) =>
                  v.status === "pending" ? null : (
                    <Comparison key={v.variantIndex} deal={v} ctx={ctx} labelled={several} />
                  ),
                )}
              </div>
            </details>
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

/** The comparison list of one variant: counted rows, then the ones that do not count. */
function Comparison({
  deal,
  ctx,
  labelled,
}: {
  deal: EvaluatedDeal;
  ctx: DealContext;
  labelled: boolean;
}) {
  const views = referenceViews(deal, ctx.nearbyChains);
  const counted = views.filter((r) => r.counts);
  const ignored = views.filter((r) => !r.counts);
  return (
    <section aria-label={cleanClassLabel(deal.classLabel)}>
      {labelled ? (
        <h4 className="text-meta font-semibold text-ink">{cleanClassLabel(deal.classLabel)}</h4>
      ) : null}
      {counted.length > 0 ? (
        <ul className="divide-y divide-line">
          {counted.map((ref, i) => (
            <ReferenceRow
              key={`${ref.listing_id ?? ""}-${i}`}
              refView={ref}
              deal={deal}
              ctx={ctx}
            />
          ))}
        </ul>
      ) : (
        <p className="py-2 text-meta text-ink-3">Ingen sammenligning tæller med.</p>
      )}
      {ignored.length > 0 ? (
        <details className="mt-1">
          <summary className="flex min-h-11 items-center gap-1 text-meta text-ink-2">
            {ignored.length} tæller ikke med – ingen butik inden for {ctx.radiusKm} km
            <ChevronIcon className="details-chevron text-ink-3" />
          </summary>
          <ul className="divide-y divide-line opacity-80">
            {ignored.map((ref, i) => (
              <ReferenceRow
                key={`${ref.listing_id ?? ""}-${i}`}
                refView={ref}
                deal={deal}
                ctx={ctx}
              />
            ))}
          </ul>
        </details>
      ) : null}
      <p className="mt-1">
        <Link href={classPath(deal.classKey) as Route} className="text-meta">
          Prishistorik →
        </Link>
      </p>
    </section>
  );
}

function ReferenceRow({
  refView: ref,
  deal,
  ctx,
}: {
  refView: ReferenceView;
  deal: EvaluatedDeal;
  ctx: DealContext;
}) {
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
    REFERENCE_KIND_LABELS[ref.kind],
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
  return (
    <li className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5 text-meta">
          <ChainDot chainId={ref.chain_id} size="xs" />
          <span className={ref.isCheapest ? "font-semibold text-ink" : "text-ink"}>
            {chainName(ref.chain_id)}
          </span>
          {km != null ? <span className="text-ink-3 tabular">· {formatDistance(km)}</span> : null}
        </span>
        <span
          className={`text-meta whitespace-nowrap tabular ${ref.isCheapest ? "font-bold text-ink" : "text-ink-2"}`}
        >
          {formatUnitPrice(ref.unit_price, ref.unit ?? deal.unit)}
          {ref.isCheapest ? <span className="font-semibold"> billigst</span> : null}
        </span>
      </div>
      {ref.title ? <p className="truncate text-meta text-ink-2">{ref.title}</p> : null}
      <p className="text-meta text-ink-3">
        {facts.join(" · ")}
        {ref.member_only ? (
          <span className="ml-1.5 align-middle">
            <MemberPriceTag />
          </span>
        ) : null}
      </p>
      <SourceLink link={link} />
    </li>
  );
}
