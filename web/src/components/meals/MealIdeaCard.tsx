import type { Route } from "next";
import Link from "next/link";
import { Badge, MemberBadge } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { SourceLink } from "@/components/SourceLink";
import { chainName } from "@/lib/chains";
import { cleanClassLabel } from "@/lib/deals";
import { foodWastePackSize } from "@/lib/foodwaste";
import { displayTitle, formatDistance, formatDkk, formatEnd, packSize } from "@/lib/format";
import type { FilledSlot, MealIdea, MealItem } from "@/lib/meals";
import { productPath } from "@/lib/routes";
import { sourceLink } from "@/lib/sources";
import { shortStoreName, storeDisplayName, type NearbyStore } from "@/lib/stores";

export interface MealContext {
  /** Stores of each chain within the radius, nearest first (offers are chain-wide). */
  storesByChain: ReadonlyMap<string, readonly NearbyStore[]>;
  now: Date;
}

const sep = <span aria-hidden="true"> · </span>;

/** "Spar 17,95 kr." in the good tone, or why the saving is unknown. */
function SavingBadge({ idea }: { idea: MealIdea }) {
  if (idea.totalSaving > 0) {
    return (
      <Badge tone="good" icon={null} className="text-meta tabular">
        Spar {formatDkk(idea.totalSaving)}
        {idea.unknownSavings > 0 ? " +" : ""}
      </Badge>
    );
  }
  return <Badge tone="neutral">Besparelse ukendt</Badge>;
}

/** Where to buy an item: the clearance's own store, or the offer chain's nearest store. */
function Where({ item, ctx }: { item: MealItem; ctx: MealContext }) {
  if (item.kind === "foodwaste") {
    const w = item.item;
    return (
      <span className="flex items-center gap-1.5">
        <ChainDot chainId={w.chainId} size="xs" />
        <span>
          {storeDisplayName(w.storeName, w.chainId)}
          <span className="whitespace-nowrap tabular"> · {formatDistance(w.distanceKm)}</span>
        </span>
      </span>
    );
  }
  const chainId = item.deal.chainId;
  const nearest = ctx.storesByChain.get(chainId)?.[0];
  return (
    <span className="flex items-center gap-1.5">
      <ChainDot chainId={chainId} size="xs" />
      <span>
        <strong className="font-semibold text-ink">{chainName(chainId)}</strong>
        {nearest ? (
          <>
            {" "}
            {shortStoreName(nearest.name, chainId)}
            <span className="whitespace-nowrap tabular">
              {" "}
              · {formatDistance(nearest.distanceKm)}
            </span>
          </>
        ) : null}
      </span>
    </span>
  );
}

/** One ingredient: what it is, where, its price against the normal price and the saving. */
function Ingredient({ filled, ctx }: { filled: FilledSlot; ctx: MealContext }) {
  const { slot, item } = filled;
  const isWaste = item.kind === "foodwaste";
  const title = isWaste ? displayTitle(item.item.title) : item.deal.title;
  const size = isWaste
    ? foodWastePackSize(item.item)
    : packSize({
        unit: item.deal.unit,
        sizeMin: item.deal.sizeMin,
        sizeMax: item.deal.sizeMax,
        source: item.deal.source,
        description: item.deal.description,
      });
  const productKey = isWaste ? item.item.productKey : item.deal.productKey;
  const link = isWaste
    ? null
    : sourceLink(
        {
          source: item.deal.source,
          chainId: item.deal.chainId,
          sourceItemId: item.deal.sourceItemId,
          catalogId: item.deal.catalogId,
          validTo: item.deal.validTo,
        },
        ctx.now,
      );
  const basis = isWaste ? "før" : "normalpris";

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-micro font-medium text-ink-3 uppercase">{slot.label}</p>
          <p className="font-medium text-ink">
            {title}
            {!isWaste && item.deal.classLabel ? (
              <span className="sr-only"> ({cleanClassLabel(item.deal.classLabel)})</span>
            ) : null}
          </p>
        </div>
        <Badge tone={isWaste ? "warn" : "neutral"} icon={null} className="mt-0.5 shrink-0">
          {isWaste ? "Madspild" : "Tilbud"}
        </Badge>
      </div>
      <p className="mt-0.5 text-meta text-ink-2">
        <span className="font-bold text-ink tabular">{formatDkk(item.price)}</span>
        {item.normalPrice != null ? (
          <>
            {" "}
            <span className="tabular">
              ({basis} <s>{formatDkk(item.normalPrice)}</s>)
            </span>
          </>
        ) : null}
        {sep}
        <span className={size.origin === "unknown" ? "text-ink-3" : undefined}>{size.text}</span>
        {item.saving != null && item.saving > 0 ? (
          <>
            {sep}
            <span className="font-medium whitespace-nowrap text-good-fg tabular">
              spar {formatDkk(item.saving)}
            </span>
          </>
        ) : item.saving == null ? (
          <>
            {sep}
            <span className="text-ink-3">godt køb, normalpris ukendt</span>
          </>
        ) : null}
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-meta text-ink-2">
        <Where item={item} ctx={ctx} />
        <span className="flex items-center gap-3">
          {!isWaste && item.deal.memberOnly ? <MemberBadge chainId={item.deal.chainId} /> : null}
          {isWaste && item.item.validTo ? (
            <span className="text-ink-3">{formatEnd(item.item.validTo, ctx.now)}</span>
          ) : null}
          {link ? <SourceLink link={link} /> : null}
          {!link && productKey ? (
            <Link
              href={productPath(productKey) as Route}
              className="inline-flex min-h-11 items-center"
            >
              Prishistorik
            </Link>
          ) : null}
        </span>
      </div>
    </li>
  );
}

/** One dish (docs/ui.md §13): what it is, the cheap items in it, the rest, and the saving. */
export function MealIdeaCard({ idea, ctx }: { idea: MealIdea; ctx: MealContext }) {
  const headingId = `ide-${idea.recipe.id}`;
  const rest = [
    ...idea.missing.map((s) => s.label.toLocaleLowerCase("da-DK")),
    ...idea.recipe.pantry,
  ];
  return (
    <article
      aria-labelledby={headingId}
      className="rounded-xl border border-line bg-surface p-4 lg:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="min-w-0 text-heading font-semibold text-ink">
          {idea.recipe.name}
        </h2>
        <span className="shrink-0">
          <SavingBadge idea={idea} />
        </span>
      </div>
      <p className="mt-1 text-meta text-ink-2">{idea.recipe.description}</p>

      <ul
        className="mt-2 divide-y divide-line border-t border-line"
        aria-label={`Billige varer til ${idea.recipe.name}`}
      >
        {idea.filled.map((f) => (
          <Ingredient key={`${f.item.kind}-${f.item.id}`} filled={f} ctx={ctx} />
        ))}
      </ul>

      {rest.length > 0 ? (
        <p className="border-t border-line pt-3 text-meta text-ink-2">
          <span className="font-medium text-ink">Du skal også bruge:</span> {rest.join(", ")}
        </p>
      ) : null}
    </article>
  );
}
