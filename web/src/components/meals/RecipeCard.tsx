import type { Route } from "next";
import Link from "next/link";
import { Badge, MemberBadge } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { Disclosure } from "@/components/Disclosure";
import { ChevronIcon } from "@/components/Icons";
import { SourceLink } from "@/components/SourceLink";
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
import { itemChain, type MealIdea, type MealItem, type SlotRow } from "@/lib/meals";
import { productPath } from "@/lib/routes";
import { sourceLink } from "@/lib/sources";
import { chainPins, shortStoreName, storeDisplayName, type NearbyStore } from "@/lib/stores";
import { StoreInfo } from "@/components/StoreInfo";
import { itemStore } from "@/components/foodwaste/FoodWasteItemRow";
import { AddToPlanForm } from "./AddToPlanForm";
import { LikeButton } from "./LikeButton";
import { RecipeDetails } from "./RecipeDetails";
import { ShoppingChecklist, type ChecklistRow } from "./ShoppingChecklist";

export interface MealContext {
  /** Stores of each chain within the radius, nearest first (offers are chain-wide). */
  storesByChain: ReadonlyMap<string, readonly NearbyStore[]>;
  now: Date;
  /** Days a dish can be added to ("Føj til madplan"); none hides the form. */
  planDays?: readonly { date: string; label: string }[];
}

const sep = <span aria-hidden="true"> · </span>;

/** One of the three numbers in an opened card. */
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

/** The store an item is bought in; a tap or hover shows its address and Google Maps. */
function Where({ item, ctx }: { item: MealItem; ctx: MealContext }) {
  if (item.kind === "foodwaste") {
    const w = item.item;
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <StoreInfo chainId={w.chainId} stores={[itemStore(w)]} className="min-h-9">
          <ChainDot chainId={w.chainId} size="xs" />
          {storeDisplayName(w.storeName, w.chainId)}
        </StoreInfo>
        <span className="whitespace-nowrap tabular">· {formatDistance(w.distanceKm)}</span>
      </span>
    );
  }
  const chainId = item.deal.chainId;
  const nearest = ctx.storesByChain.get(chainId)?.[0];
  const { pins, total } = chainPins(ctx.storesByChain, chainId);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <StoreInfo chainId={chainId} stores={pins} total={total} className="min-h-9">
        <ChainDot chainId={chainId} size="xs" />
        {nearest
          ? `${chainName(chainId)} ${shortStoreName(nearest.name, chainId)}`
          : chainName(chainId)}
      </StoreInfo>
      {nearest ? (
        <span className="whitespace-nowrap tabular">· {formatDistance(nearest.distanceKm)}</span>
      ) : null}
    </span>
  );
}

/** One cheap item: title, price against the normal price, saving, where, and the sources. */
export function ItemLine({
  item,
  ctx,
  muted,
}: {
  item: MealItem;
  ctx: MealContext;
  muted?: boolean;
}) {
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
    <div className={`text-meta text-ink-2 ${muted ? "py-1.5" : "pt-0.5"}`}>
      <p className="flex items-start justify-between gap-2">
        <span className={`min-w-0 ${muted ? "text-ink-2" : "text-ink"}`}>{title}</span>
        <Badge tone={isWaste ? "warn" : "neutral"} icon={null} className="shrink-0">
          {isWaste ? "Madspild" : "Tilbud"}
        </Badge>
      </p>
      <p>
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
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <Where item={item} ctx={ctx} />
        <span className="flex items-center gap-3">
          {!isWaste && item.deal.memberOnly ? <MemberBadge chainId={item.deal.chainId} /> : null}
          {isWaste && item.item.validTo ? (
            <span className="text-micro text-ink-3">{formatEnd(item.item.validTo, ctx.now)}</span>
          ) : null}
          {productKey ? (
            <Link
              href={productPath(productKey) as Route}
              className="inline-flex min-h-9 items-center text-micro text-ink-3"
            >
              Prishistorik
            </Link>
          ) : null}
          {link ? <SourceLink link={link} className="min-h-9" /> : null}
        </span>
      </div>
    </div>
  );
}

/** The prices of one slot: the chosen item and, folded, every other cheap one. */
function SlotPrices({ row, ctx }: { row: SlotRow; ctx: MealContext }) {
  const chosen = row.chosen?.item;
  const others = row.options.filter((o) => o !== chosen);
  return (
    <div className="pb-1">
      {chosen ? <ItemLine item={chosen} ctx={ctx} /> : null}
      {others.length > 0 ? (
        <details className="mt-1">
          <summary className="flex min-h-9 items-center gap-1 text-micro font-medium text-link">
            {chosen
              ? `Flere priser (${others.length})`
              : `Tilbud i andre butikker (${others.length})`}
            <ChevronIcon className="details-chevron" />
          </summary>
          <ul className="divide-y divide-line border-l-2 border-line pl-3">
            {others.slice(0, 12).map((o) => (
              <li key={`${o.kind}-${o.id}`}>
                <ItemLine item={o} ctx={ctx} muted />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="text-micro text-ink-3 tabular">
        Normalpris for mængden: ca. {formatDkk(row.slot.estimateKr)}
      </p>
    </div>
  );
}

function checklistRows(idea: MealIdea, ctx: MealContext): ChecklistRow[] {
  const slotRows: ChecklistRow[] = idea.rows.map((row) => {
    const amount = formatQuantity(row.slot.amount, row.slot.amount, row.slot.unit) ?? "";
    const item = row.chosen?.item;
    return {
      key: `slot:${row.slot.label}`,
      group: "ingredient",
      label: row.slot.label,
      amount,
      payKr: item ? item.price : row.slot.estimateKr,
      approx: !item,
      note: item
        ? `${item.kind === "foodwaste" ? "Madspild" : "Tilbud"} i ${chainName(itemChain(item))} – hel pakke`
        : "Ikke på tilbud – skønnet normalpris",
      defaultHave: false,
      detail: <SlotPrices row={row} ctx={ctx} />,
    };
  });
  const pantryRows: ChecklistRow[] = idea.recipe.pantry.map((p) => ({
    key: `pantry:${p.name}`,
    group: p.basic ? "basic" : "buy",
    label: p.name.charAt(0).toLocaleUpperCase("da-DK") + p.name.slice(1),
    amount: p.amount,
    payKr: p.estimateKr,
    approx: true,
    defaultHave: Boolean(p.basic),
  }));
  return [...slotRows, ...pantryRows];
}

/**
 * One dish of the catalogue (docs/ui.md §19): folded it shows the name, time and price; opened,
 * the shopping list with every price we know, ticks for what you have, and the method.
 */
export function RecipeCard({
  idea,
  ctx,
  liked,
}: {
  idea: MealIdea;
  ctx: MealContext;
  liked: boolean;
}) {
  const { recipe } = idea;
  const headingId = `ret-${recipe.id}`;
  const chains = [...new Set(idea.filled.map((f) => itemChain(f.item)))];
  const savingValue =
    idea.totalSaving > 0
      ? `${formatDkk(idea.totalSaving)}${idea.unknownSavings > 0 ? " +" : ""}`
      : idea.unknownSavings > 0
        ? "ukendt"
        : "–";

  return (
    <article
      aria-labelledby={headingId}
      className="relative rounded-xl border border-line bg-surface"
    >
      <div className="absolute top-2 right-2 z-10">
        <LikeButton recipeId={recipe.id} name={recipe.name} liked={liked} />
      </div>
      <Disclosure initialOpen={false} className="group/card">
        <summary className="block cursor-pointer p-4 pr-14 lg:p-5 lg:pr-14">
          <h3 id={headingId} className="text-heading font-semibold text-ink">
            {recipe.name}
          </h3>
          <p className="mt-0.5 line-clamp-2 text-meta text-ink-2">{recipe.description}</p>
          <p className="mt-1 text-micro text-ink-3 tabular">
            ⏱ {recipe.minutes} min{sep}
            {recipe.servings} pers.{sep}
            {recipe.meal === "frokost" ? "Frokost" : "Aftensmad"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-body font-bold text-ink tabular">
              ca. {formatDkk(Math.round(idea.costPerServing))}
              <span className="text-meta font-normal text-ink-2"> pr. pers.</span>
            </span>
            {idea.totalSaving > 0 ? (
              <Badge tone="good" icon={null}>
                Spar {formatDkk(idea.totalSaving)}
                {idea.unknownSavings > 0 ? " +" : ""}
              </Badge>
            ) : null}
            {idea.filled.length > 0 ? (
              <span className="flex items-center gap-1.5 text-micro text-ink-2">
                <span className="flex -space-x-1">
                  {chains.map((c) => (
                    <ChainDot key={c} chainId={c} size="sm" />
                  ))}
                </span>
                {idea.filled.length} af {idea.rows.length} på tilbud
                {idea.chainId ? ` i ${chainName(idea.chainId)}` : ""}
              </span>
            ) : (
              <span className="text-micro text-ink-3">Intet på tilbud lige nu</span>
            )}
            <span className="ml-auto flex items-center gap-1 text-micro font-medium text-link">
              <span className="group-open/card:hidden">Se indkøb</span>
              <span className="hidden group-open/card:inline">Luk</span>
              <ChevronIcon className="details-chevron" />
            </span>
          </div>
        </summary>

        <div className="border-t border-line px-4 pb-4 lg:px-5">
          <dl className="mt-3 grid grid-cols-3 gap-3 rounded-lg bg-surface-2 p-3">
            <Stat
              label="Tilbudsvarer"
              value={formatDkk(idea.purchasePrice)}
              note={`${idea.filled.length} ${idea.filled.length === 1 ? "vare" : "varer"}, hele pakker`}
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

          {ctx.planDays && ctx.planDays.length > 0 ? (
            <AddToPlanForm recipeId={recipe.id} name={recipe.name} days={ctx.planDays} />
          ) : null}

          <h3 className="mt-4 font-semibold text-ink">Indkøbsliste</h3>
          <p className="text-micro text-ink-3">Sæt hak ved det, du allerede har.</p>
          <ShoppingChecklist recipeId={recipe.id} rows={checklistRows(idea, ctx)} />

          <div className="mt-5">
            <RecipeDetails recipe={recipe} showIngredients={false} />
          </div>
        </div>
      </Disclosure>
    </article>
  );
}
