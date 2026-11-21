import type { Route } from "next";
import Link from "next/link";
import { Badge, MemberBadge } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { Disclosure } from "@/components/Disclosure";
import { ChevronIcon } from "@/components/Icons";
import { SourceLink } from "@/components/SourceLink";
import { SourcedPrice } from "@/components/SourcedPrice";
import { chainName } from "@/lib/chains";
import { foodWastePackSize, foodWasteSource } from "@/lib/foodwaste";
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
import { priceSource, sourceLink, type PriceSource } from "@/lib/sources";
import { chainPins, shortStoreName, storeDisplayName, type NearbyStore } from "@/lib/stores";
import { StoreInfo } from "@/components/StoreInfo";
import { itemStore } from "@/components/foodwaste/FoodWasteItemRow";
import { AddToPlanForm } from "./AddToPlanForm";
import { LikeButton } from "./LikeButton";
import { RecipeDetails } from "./RecipeDetails";
import { ShoppingChecklist, type ChecklistRow } from "./ShoppingChecklist";
import { dishCost, type DishCost, type DishLine } from "@/lib/dish-cost";
import { packText, type FoundPrice, type PriceFinder } from "@/lib/pantry";

export interface MealContext {
  /** Stores of each chain within the radius, nearest first (offers are chain-wide). */
  storesByChain: ReadonlyMap<string, readonly NearbyStore[]>;
  now: Date;
  /** Days a dish can be added to ("Føj til madplan"); none hides the form. */
  planDays?: readonly { date: string; label: string }[];
  /** Real prices for the extra items and the ingredients not on offer (`lib/pantry.ts`). */
  finder?: PriceFinder;
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
        title="Beregnet ud fra priserne i indkøbslisten nedenfor – hver pris dér linker til sin kilde"
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

/** Where the price of a cheap item (offer or clearance) can be checked. */
export function mealItemSource(item: MealItem, now: Date): PriceSource {
  return item.kind === "foodwaste" ? foodWasteSource(item.item, now) : priceSource(item.deal, now);
}

/** An estimate has no shop behind it; the bubble says so. */
export const ESTIMATE_SOURCE: PriceSource = {
  href: null,
  label: "Skøn: FoodCatchs vejledende normalpris for mængden – ikke en pris fra en butik",
};

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
  const source = mealItemSource(item, ctx.now);
  const pct =
    item.saving != null && item.saving > 0 && item.normalPrice
      ? (item.saving / item.normalPrice) * 100
      : null;

  return (
    <div className={`text-meta text-ink-2 ${muted ? "py-1.5" : "pt-0.5"}`}>
      <p className="flex items-start justify-between gap-2">
        <SourcedPrice source={source} className={`min-w-0 ${muted ? "text-ink-2" : "text-ink"}`}>
          {title}
        </SourcedPrice>
        <Badge tone={isWaste ? "warn" : "neutral"} icon={null} className="shrink-0">
          {isWaste ? "Madspild" : "Tilbud"}
        </Badge>
      </p>
      <p>
        <SourcedPrice source={source} className="font-bold text-ink tabular">
          {formatDkk(item.price)}
        </SourcedPrice>
        {item.normalPrice != null ? (
          <>
            {" "}
            <span className="tabular">
              ({isWaste ? "før" : "normalt"}{" "}
              {isWaste ? (
                <SourcedPrice source={source}>
                  <s>{formatDkk(item.normalPrice)}</s>
                </SourcedPrice>
              ) : (
                <s title="Laveste normalpris på samme vare i en butik nær dig – se den under Prishistorik">
                  {formatDkk(item.normalPrice)}
                </s>
              )}
              )
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
function SlotPrices({
  row,
  ctx,
  found,
}: {
  row: SlotRow;
  ctx: MealContext;
  found: FoundPrice | null;
}) {
  const chosen = row.chosen?.item;
  const others = row.options.filter((o) => o !== chosen);
  return (
    <div className="pb-1">
      {chosen ? <ItemLine item={chosen} ctx={ctx} /> : null}
      {!chosen && found ? <FoundLine found={found} ctx={ctx} /> : null}
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
      {chosen || found ? null : (
        <p className="text-micro text-ink-3 tabular">
          Ingen pris i butikkerne nær dig. Skøn for mængden: ca.{" "}
          <SourcedPrice source={ESTIMATE_SOURCE}>{formatDkk(row.slot.estimateKr)}</SourcedPrice>
        </p>
      )}
    </div>
  );
}

const KIND_WORD: Readonly<Record<FoundPrice["product"]["kind"], string>> = {
  regular: "Normalpris",
  offer: "Tilbud",
  clearance: "Madspild",
};

/** Where a found product's price can be checked. */
export function foundSource(found: FoundPrice, now: Date): PriceSource {
  const p = found.product;
  return priceSource(
    {
      source: p.source,
      chainId: p.chainId,
      sourceItemId: p.sourceItemId,
      catalogId: p.catalogId,
      validTo: p.validTo,
      ean: p.ean,
    },
    now,
  );
}

/** A real product found for an item: its name, where, kind, pack and price (with the source). */
export function FoundLine({ found, ctx }: { found: FoundPrice; ctx: MealContext }) {
  const p = found.product;
  const { pins, total } = chainPins(ctx.storesByChain, p.chainId);
  const pack = packText(found);
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-meta">
      <span className="min-w-0">
        <SourcedPrice source={foundSource(found, ctx.now)} className="text-ink">
          {displayTitle(p.label)}
        </SourcedPrice>
        <span className="flex flex-wrap items-center gap-x-1 text-micro text-ink-2">
          {p.kind === "clearance" && p.storeName ? (
            <span>{storeDisplayName(p.storeName, p.chainId)}</span>
          ) : (
            <StoreInfo chainId={p.chainId} stores={pins} total={total}>
              <ChainDot chainId={p.chainId} size="xs" />
              {chainName(p.chainId)}
            </StoreInfo>
          )}
          <span>· {KIND_WORD[p.kind]}</span>
          {pack ? <span>· {pack}</span> : null}
        </span>
      </span>
      <SourcedPrice
        source={foundSource(found, ctx.now)}
        className="shrink-0 font-semibold text-ink tabular"
      >
        {formatDkk(found.purchaseKr)}
      </SourcedPrice>
    </div>
  );
}

function lineNote(line: DishLine): string {
  if (line.item) {
    return `${line.item.kind === "foodwaste" ? "Madspild" : "Tilbud"} i ${chainName(itemChain(line.item))} – hel pakke`;
  }
  if (line.found) {
    const pack = packText(line.found);
    return `${KIND_WORD[line.found.product.kind]} i ${chainName(line.found.product.chainId)}${pack ? ` – ${pack}` : ""}`;
  }
  return "Ingen pris i butikkerne nær dig – skøn";
}

function checklistRows(idea: MealIdea, cost: DishCost, ctx: MealContext): ChecklistRow[] {
  return cost.lines.map((line) => {
    const row =
      line.kind === "slot" ? idea.rows.find((r) => `slot:${r.slot.label}` === line.key) : null;
    return {
      key: line.key,
      group: line.group,
      label: line.label,
      amount: line.amount,
      payKr: line.purchaseKr,
      portionKr: line.portionKr,
      approx: line.estimate,
      source: line.item
        ? mealItemSource(line.item, ctx.now)
        : line.found
          ? foundSource(line.found, ctx.now)
          : ESTIMATE_SOURCE,
      note: lineNote(line),
      defaultHave: line.basic,
      detail: row ? (
        <SlotPrices row={row} ctx={ctx} found={line.found} />
      ) : line.found ? (
        <FoundLine found={line.found} ctx={ctx} />
      ) : undefined,
    };
  });
}

/**
 * What the dish saves against normal prices: the sum of the items' known savings (never an
 * estimate). Says so when nothing is on offer or the saving is unknown.
 */
function DishSaving({ idea }: { idea: MealIdea }) {
  if (idea.totalSaving > 0) {
    return (
      <span
        title="Summen af de kendte besparelser på varerne på tilbud, ift. normalprisen på samme vare."
        className="inline-flex items-center gap-1 rounded-md bg-good-fg px-2 py-0.5 text-meta font-semibold whitespace-nowrap text-page tabular"
      >
        Spar {formatDkk(idea.totalSaving)}
        {idea.unknownSavings > 0 ? <span className="font-normal">+ mere</span> : null}
      </span>
    );
  }
  if (idea.filled.length === 0) {
    return <span className="text-meta text-ink-3">Intet på tilbud lige nu</span>;
  }
  return (
    <span
      title="Varerne er gode køb, men vi kender ikke normalprisen på præcis samme vare."
      className="text-meta text-ink-3"
    >
      Besparelse ukendt
    </span>
  );
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
  const cost = dishCost(
    idea,
    ctx.finder,
    (slot) => formatQuantity(slot.amount, slot.amount, slot.unit) ?? "",
  );
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
          <p className="mt-0.5 text-micro text-ink-3 tabular">
            ⏱ {recipe.minutes} min{sep}
            {recipe.servings} pers.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-ink">
              <span className="text-meta text-ink-2">Indkøb </span>
              <span className="text-price shelf">
                {cost.purchaseApprox ? <span className="text-title">ca. </span> : null}
                {formatDkk(cost.purchaseKr)}
              </span>
            </span>
            <DishSaving idea={idea} />
          </div>
          <p className="mt-0.5 text-meta text-ink-2 tabular">
            Retten {cost.dishApprox ? "ca. " : ""}
            {formatDkk(cost.dishKr)} · {formatDkk(cost.perServingKr)} pr. pers.
            <span className="text-ink-3"> – det, retten bruger af varerne</span>
          </p>
          {idea.filled.length > 0 ? (
            <p className="mt-2 flex items-start gap-1.5 text-meta text-ink-2">
              <span className="mt-0.5 flex shrink-0 -space-x-1">
                {chains.map((c) => (
                  <ChainDot key={c} chainId={c} size="sm" />
                ))}
              </span>
              <span className="min-w-0">
                <span className="text-ink">På tilbud: </span>
                {idea.filled.map((f) => f.slot.label.toLocaleLowerCase("da-DK")).join(", ")}
                {idea.missing.length > 0 ? (
                  <span className="text-ink-3"> · {idea.missing.length} til normalpris</span>
                ) : null}
              </span>
            </p>
          ) : null}
          <span className="mt-1 flex items-center justify-end gap-1 text-micro font-medium text-link">
            <span className="group-open/card:hidden">Se indkøb</span>
            <span className="hidden group-open/card:inline">Luk</span>
            <ChevronIcon className="details-chevron" />
          </span>
        </summary>

        <div className="border-t border-line px-4 pb-4 lg:px-5">
          <p className="mt-3 text-meta text-ink-2">{recipe.description}</p>
          <dl className="mt-3 grid grid-cols-3 gap-3 rounded-lg bg-surface-2 p-3">
            <Stat
              label="Indkøb"
              value={`${cost.purchaseApprox ? "ca. " : ""}${formatDkk(cost.purchaseKr)}`}
              note="hele pakker, uden basisvarer"
            />
            <Stat
              label="Du sparer"
              value={savingValue}
              note={idea.savingPct != null ? formatPercent(idea.savingPct) : null}
              tone={idea.totalSaving > 0 ? "good" : undefined}
            />
            <Stat
              label={cost.dishApprox ? "Retten koster ca." : "Retten koster"}
              value={formatDkk(cost.dishKr)}
              note={`${formatDkk(cost.perServingKr)} pr. pers.`}
            />
          </dl>

          {ctx.planDays && ctx.planDays.length > 0 ? (
            <AddToPlanForm recipeId={recipe.id} name={recipe.name} days={ctx.planDays} />
          ) : null}

          <h3 className="mt-4 font-semibold text-ink">Indkøbsliste</h3>
          <p className="text-micro text-ink-3">
            Sæt hak ved det, du allerede har – så tæller kun den mængde, retten bruger.
          </p>
          <ShoppingChecklist
            recipeId={recipe.id}
            rows={checklistRows(idea, cost, ctx)}
            servings={recipe.servings}
          />

          <div className="mt-5">
            <RecipeDetails recipe={recipe} showIngredients={false} />
          </div>
        </div>
      </Disclosure>
    </article>
  );
}
