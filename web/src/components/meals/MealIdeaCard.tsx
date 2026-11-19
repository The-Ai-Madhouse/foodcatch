import type { Route } from "next";
import Link from "next/link";
import { Badge, MemberBadge } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { ChevronIcon } from "@/components/Icons";
import { ExternalLink, SourceLink } from "@/components/SourceLink";
import { chainName } from "@/lib/chains";
import { foodWastePackSize } from "@/lib/foodwaste";
import {
  displayTitle,
  formatDistance,
  formatDkk,
  formatEnd,
  formatPercent,
  formatQuantity,
  packSize,
} from "@/lib/format";
import type { FilledSlot, MealIdea, MealItem } from "@/lib/meals";
import { productPath } from "@/lib/routes";
import { sourceLink, storeMapsLink } from "@/lib/sources";
import { shortStoreName, storeDisplayName, type NearbyStore } from "@/lib/stores";

export interface MealContext {
  /** Stores of each chain within the radius, nearest first (offers are chain-wide). */
  storesByChain: ReadonlyMap<string, readonly NearbyStore[]>;
  now: Date;
}

const sep = <span aria-hidden="true"> · </span>;

/** One of the three numbers at the top of a card. */
function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string | null;
  tone?: "good";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-ink-3">{label}</dt>
      <dd
        className={`font-bold tabular ${tone === "good" ? "text-good-fg" : "text-ink"} text-body`}
      >
        {value}
      </dd>
      {note ? <dd className="text-micro text-ink-3 tabular">{note}</dd> : null}
    </div>
  );
}

/** The store an item is bought in, linking to Google Maps in a new tab. */
function Where({ item, ctx }: { item: MealItem; ctx: MealContext }) {
  if (item.kind === "foodwaste") {
    const w = item.item;
    const name = storeDisplayName(w.storeName, w.chainId);
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <ChainDot chainId={w.chainId} size="xs" />
        <ExternalLink href={storeMapsLink({ ...w, name })} iconSize={14} className="min-h-11">
          {name}
        </ExternalLink>
        <span className="whitespace-nowrap tabular">· {formatDistance(w.distanceKm)}</span>
      </span>
    );
  }
  const chainId = item.deal.chainId;
  const nearest = ctx.storesByChain.get(chainId)?.[0];
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ChainDot chainId={chainId} size="xs" />
      {nearest ? (
        <>
          <ExternalLink href={storeMapsLink(nearest)} iconSize={14} className="min-h-11">
            {chainName(chainId)} {shortStoreName(nearest.name, chainId)}
          </ExternalLink>
          <span className="whitespace-nowrap tabular">· {formatDistance(nearest.distanceKm)}</span>
        </>
      ) : (
        <span>{chainName(chainId)}</span>
      )}
    </span>
  );
}

/** One cheap item: what it is, its price against the normal price, the saving, and where. */
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
  const pct =
    item.saving != null && item.saving > 0 && item.normalPrice
      ? (item.saving / item.normalPrice) * 100
      : null;

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-micro font-medium text-ink-3 uppercase">{slot.label}</p>
          <p className="font-medium text-ink">{title}</p>
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
              ({isWaste ? "før" : "normalt"} <s>{formatDkk(item.normalPrice)}</s>)
            </span>
          </>
        ) : null}
        {sep}
        <span className={size.origin === "unknown" ? "text-ink-3" : undefined}>{size.text}</span>
        {pct != null && item.saving != null ? (
          <>
            {sep}
            <span className="font-medium whitespace-nowrap text-good-fg tabular">
              spar {formatDkk(item.saving)} ({formatPercent(pct)})
            </span>
          </>
        ) : item.saving == null ? (
          <>
            {sep}
            <span className="text-ink-3">godt køb, normalpris ukendt</span>
          </>
        ) : null}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-meta text-ink-2">
        <Where item={item} ctx={ctx} />
        <span className="flex items-center gap-3">
          {!isWaste && item.deal.memberOnly ? <MemberBadge chainId={item.deal.chainId} /> : null}
          {isWaste && item.item.validTo ? (
            <span className="text-micro text-ink-3">{formatEnd(item.item.validTo, ctx.now)}</span>
          ) : null}
          {productKey ? (
            <Link
              href={productPath(productKey) as Route}
              className="inline-flex min-h-11 items-center text-micro text-ink-3"
            >
              Prishistorik
            </Link>
          ) : null}
          {link ? <SourceLink link={link} className="min-h-11" /> : null}
        </span>
      </div>
    </li>
  );
}

/** The full recipe, opened on demand: ingredients with amounts and the method. */
function RecipeDetails({ idea }: { idea: MealIdea }) {
  const { recipe } = idea;
  const cheap = new Set(idea.filled.map((f) => f.slot));
  return (
    <details className="group/recipe border-t border-line">
      <summary className="flex h-11 items-center gap-1 text-meta font-medium text-link">
        <span className="group-open/recipe:hidden">Vis opskrift</span>
        <span className="hidden group-open/recipe:inline">Skjul opskrift</span>
        <ChevronIcon className="details-chevron" />
      </summary>
      <div className="pb-3 text-meta text-ink-2">
        <h3 className="font-semibold text-ink">Ingredienser ({recipe.servings} pers.)</h3>
        <ul className="mt-1 space-y-0.5">
          {recipe.slots.map((slot) => (
            <li key={slot.label}>
              <span className="tabular">{formatQuantity(slot.amount, slot.amount, slot.unit)}</span>{" "}
              {slot.label.toLocaleLowerCase("da-DK")}
              {cheap.has(slot) ? <span className="text-good-fg"> · billig nu</span> : null}
            </li>
          ))}
          {recipe.pantry.map((p) => (
            <li key={p.name}>
              <span className="tabular">{p.amount}</span> {p.name}
            </li>
          ))}
        </ul>
        <h3 className="mt-3 font-semibold text-ink">Sådan gør du</h3>
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          {recipe.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
    </details>
  );
}

/** One dish (docs/ui.md §13): the numbers, the cheap items, the rest, and the recipe. */
export function MealIdeaCard({ idea, ctx }: { idea: MealIdea; ctx: MealContext }) {
  const { recipe } = idea;
  const headingId = `ide-${recipe.id}`;
  const rest = [
    ...idea.missing.map((s) => ({
      name: s.label.toLocaleLowerCase("da-DK"),
      kr: s.estimateKr,
    })),
    ...recipe.pantry.map((p) => ({ name: p.name, kr: p.estimateKr })),
  ];
  const savingValue =
    idea.totalSaving > 0
      ? `${formatDkk(idea.totalSaving)}${idea.unknownSavings > 0 ? " +" : ""}`
      : "ukendt";
  return (
    <article
      aria-labelledby={headingId}
      className="rounded-xl border border-line bg-surface p-4 lg:p-5"
    >
      <h3 id={headingId} className="text-heading font-semibold text-ink">
        {recipe.name}
      </h3>
      <p className="mt-0.5 text-meta text-ink-2">{recipe.description}</p>

      <dl className="mt-3 grid grid-cols-3 gap-3 rounded-lg bg-surface-2 p-3">
        <Stat
          label="Indkøb"
          value={formatDkk(idea.purchasePrice)}
          note={`${idea.filled.length} ${idea.filled.length === 1 ? "vare" : "varer"}`}
        />
        <Stat
          label="Du sparer"
          value={savingValue}
          note={idea.savingPct != null ? formatPercent(idea.savingPct) : null}
          tone={idea.totalSaving > 0 ? "good" : undefined}
        />
        <Stat
          label="Retten koster ca."
          value={formatDkk(Math.round(idea.dishCost))}
          note={`${formatDkk(Math.round(idea.costPerServing))} pr. pers.`}
        />
      </dl>

      <ul className="mt-2 divide-y divide-line" aria-label={`Billige varer til ${recipe.name}`}>
        {idea.filled.map((f) => (
          <Ingredient key={`${f.item.kind}-${f.item.id}`} filled={f} ctx={ctx} />
        ))}
      </ul>

      {rest.length > 0 ? (
        <p className="border-t border-line py-3 text-meta text-ink-2">
          <span className="font-medium text-ink">Du skal også bruge:</span>{" "}
          {rest.map((r) => r.name).join(", ")}
          <span className="text-ink-3 tabular">
            {" "}
            (ca. {formatDkk(Math.round(rest.reduce((sum, r) => sum + r.kr, 0)))})
          </span>
        </p>
      ) : null}

      <RecipeDetails idea={idea} />
    </article>
  );
}
