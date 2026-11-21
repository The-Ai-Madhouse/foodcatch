import type { Route } from "next";
import Link from "next/link";
import { saveStaples } from "@/app/actions";
import { Badge, MemberBadge, VerdictBadge } from "@/components/Badge";
import { SavingTag } from "@/components/SavingTag";
import { SourcedPrice } from "@/components/SourcedPrice";
import { ChainDot } from "@/components/ChainDot";
import { Disclosure } from "@/components/Disclosure";
import { ChevronIcon } from "@/components/Icons";
import { chainName } from "@/lib/chains";
import type { ListingDeal } from "@/lib/deals";
import { foodWastePackSize, foodWasteSource, type FoodWasteItem } from "@/lib/foodwaste";
import { priceSource } from "@/lib/sources";
import { clearanceSaving, listingSaving } from "@/lib/savings";
import {
  displayTitle,
  formatDayDate,
  formatDistance,
  formatDkk,
  formatUnitPriceRange,
  packSize,
} from "@/lib/format";
import { productPath } from "@/lib/routes";
import { STAPLE_OPTIONS, resolveStaple } from "@/lib/staple-catalogue";
import type { StapleMatches, TextOffer } from "@/lib/staples";
import { StoreInfo } from "@/components/StoreInfo";
import { itemStore } from "@/components/foodwaste/FoodWasteItemRow";
import { chainPins, storeDisplayName, type NearbyStore } from "@/lib/stores";
import { StapleSearch } from "./StapleSearch";
import { Notice } from "@/components/Notice";

type StoresByChain = ReadonlyMap<string, readonly NearbyStore[]>;

/** The chain's name as a store-popover trigger (its nearest stores). */
function ChainStores({ chainId, stores }: { chainId: string; stores: StoresByChain }) {
  const { pins, total } = chainPins(stores, chainId);
  return (
    <StoreInfo chainId={chainId} stores={pins} total={total}>
      <ChainDot chainId={chainId} size="xs" />
      <span>{chainName(chainId)}</span>
    </StoreInfo>
  );
}

const sep = <span aria-hidden="true"> · </span>;

/** "fra lør. 22. nov." for an offer that has not started yet. */
function startsLater(validFrom: string, now: Date) {
  return Date.parse(validFrom) > now.getTime() ? (
    <>
      {sep}
      <span className="whitespace-nowrap">fra {formatDayDate(validFrom)}</span>
    </>
  ) : null;
}

/** One offer of a staple in one line: title, chain, price, size, unit price and verdict. */
function OfferRow({
  listing,
  now,
  stores,
}: {
  listing: ListingDeal;
  now: Date;
  stores: StoresByChain;
}) {
  const { offer } = listing;
  const size = packSize({
    unit: offer.unit,
    sizeMin: offer.sizeMin,
    sizeMax: offer.sizeMax,
    source: offer.source,
    description: offer.description,
  });
  const unitPrice = formatUnitPriceRange(offer.unitPriceMin, offer.unitPriceMax, offer.unit);
  const title = offer.productKey ? (
    <Link href={productPath(offer.productKey) as Route} className="text-ink">
      {offer.title}
    </Link>
  ) : (
    offer.title
  );
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        <p className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
          <ChainStores chainId={offer.chainId} stores={stores} />
          {sep}
          <SourcedPrice source={priceSource(offer, now)} className="font-bold text-ink tabular">
            {formatDkk(offer.price)}
          </SourcedPrice>
          {sep}
          <span>{size.text}</span>
          {unitPrice ? (
            <>
              {sep}
              <span className="whitespace-nowrap tabular">{unitPrice}</span>
            </>
          ) : null}
          {startsLater(offer.validFrom, now)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <SavingTag saving={listingSaving(listing, new Set(stores.keys()))} size="sm" />
        <VerdictBadge
          status={listing.status}
          memberOnly={offer.memberOnly}
          chainId={offer.chainId}
        />
        {offer.memberOnly ? <MemberBadge chainId={offer.chainId} /> : null}
      </div>
    </li>
  );
}

/** An offer of a free-text staple: like {@link OfferRow}, but without a verdict. */
function TextOfferRow({
  offer,
  now,
  stores,
}: {
  offer: TextOffer;
  now: Date;
  stores: StoresByChain;
}) {
  const size = packSize({
    unit: offer.unit,
    sizeMin: offer.sizeMin,
    sizeMax: offer.sizeMax,
    source: offer.source,
    description: null,
  });
  const unitPrice = formatUnitPriceRange(offer.unitPriceMin, offer.unitPriceMax, offer.unit);
  const title = offer.productKey ? (
    <Link href={productPath(offer.productKey) as Route} className="text-ink">
      {displayTitle(offer.title)}
    </Link>
  ) : (
    displayTitle(offer.title)
  );
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        <p className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
          <ChainStores chainId={offer.chainId} stores={stores} />
          {offer.price != null ? (
            <>
              {sep}
              <SourcedPrice source={priceSource(offer, now)} className="font-bold text-ink tabular">
                {formatDkk(offer.price)}
              </SourcedPrice>
            </>
          ) : null}
          {sep}
          <span>{size.text}</span>
          {unitPrice ? (
            <>
              {sep}
              <span className="whitespace-nowrap tabular">{unitPrice}</span>
            </>
          ) : null}
          {startsLater(offer.validFrom, now)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge tone="neutral">Tilbud</Badge>
        {offer.memberOnly ? <MemberBadge chainId={offer.chainId} /> : null}
      </div>
    </li>
  );
}

/** One clearance of a staple: title, store, price and discount. */
function ClearanceRow({ item, now }: { item: FoodWasteItem; now: Date }) {
  const source = foodWasteSource(item, now);
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="font-medium text-ink">{displayTitle(item.title)}</p>
        <p className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
          <StoreInfo chainId={item.chainId} stores={[itemStore(item)]}>
            <ChainDot chainId={item.chainId} size="xs" />
            <span>{storeDisplayName(item.storeName, item.chainId)}</span>
          </StoreInfo>
          <span className="whitespace-nowrap tabular">· {formatDistance(item.distanceKm)}</span>
          {sep}
          <SourcedPrice source={source} className="font-bold text-ink tabular">
            {formatDkk(item.price)}
          </SourcedPrice>
          {item.referencePrice != null ? (
            <span className="tabular">
              {" "}
              (før{" "}
              <SourcedPrice source={source}>
                <s>{formatDkk(item.referencePrice)}</s>
              </SourcedPrice>
              )
            </span>
          ) : null}
          {sep}
          <span>{foodWastePackSize(item).text}</span>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <SavingTag saving={clearanceSaving(item)} size="sm" />
        <span className="rounded-full border border-warn-line bg-warn-bg px-2 py-0.5 text-micro font-medium text-warn-fg">
          Madspild
        </span>
      </div>
    </li>
  );
}

/**
 * The picker: a checkbox per suggested staple and per staple added through the search, saved in
 * a cookie by a server action (works without JS); then the search for more staples.
 */
function StaplePicker({ selected, open }: { selected: readonly string[]; open: boolean }) {
  const suggested = new Set(STAPLE_OPTIONS.map((o) => o.id));
  const added = selected.flatMap((id) => {
    const staple = suggested.has(id) ? null : resolveStaple(id);
    return staple ? [staple] : [];
  });
  return (
    <Disclosure initialOpen={open} className="group/picker">
      <summary
        className={
          selected.length
            ? "flex h-11 items-center gap-1 text-meta font-medium text-link"
            : "my-2 inline-flex h-11 items-center gap-1 rounded-[10px] bg-brand px-4 font-semibold text-page"
        }
      >
        {selected.length ? "Skift basisvarer" : "Vælg dine basisvarer"}
        <ChevronIcon className="details-chevron" />
      </summary>
      <form action={saveStaples} className="pb-3">
        {added.length > 0 ? (
          <fieldset className="mb-3">
            <legend className="text-meta text-ink-2">
              Tilføjet af dig (fjern fluebenet for at fjerne)
            </legend>
            <div className="mt-2 grid grid-cols-2 gap-x-3 sm:grid-cols-3">
              {added.map((s) => (
                <label key={s.id} className="flex min-h-11 items-center gap-2 text-ink">
                  <input
                    type="checkbox"
                    name="basisvare"
                    value={s.id}
                    defaultChecked
                    className="size-5 accent-brand"
                  />
                  <span>
                    {s.label}
                    {s.kind === "text" ? (
                      <span className="block text-micro text-ink-3">fritekst</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <fieldset>
          <legend className="text-meta text-ink-2">
            Vælg de varer, du altid køber. De vises her, når de er på tilbud eller madspild.
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-x-3 sm:grid-cols-3">
            {STAPLE_OPTIONS.map((o) => (
              <label key={o.id} className="flex min-h-11 items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  name="basisvare"
                  value={o.id}
                  defaultChecked={selected.includes(o.id)}
                  className="size-5 accent-brand"
                />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>
        <button
          type="submit"
          className="mt-3 inline-flex h-11 items-center rounded-[10px] bg-brand px-4 font-semibold text-page hover:opacity-90"
        >
          Gem basisvarer
        </button>
      </form>
      <StapleSearch selected={selected} />
    </Disclosure>
  );
}

/**
 * "Dine basisvarer" (docs/ui.md §15) at the top of the offers page: the staples the user picked
 * that are on offer or cleared nearby, and the picker. It can be folded away (remembered), and
 * a long list scrolls inside the box, so it never pushes the week's offers far down.
 */
export function StaplesSection({
  selected,
  matches,
  now,
  storesByChain,
}: {
  selected: readonly string[];
  matches: readonly StapleMatches[];
  now: Date;
  storesByChain: StoresByChain;
}) {
  const onSale = matches.filter((m) => m.offerCount + m.clearanceCount > 0);
  const quiet = matches.filter((m) => m.offerCount + m.clearanceCount === 0);
  return (
    <section aria-label="Dine varer" className="mt-3">
      {selected.length === 0 ? (
        <Notice title="Du følger ingen varer endnu">
          Vælg fx æg, havregryn og mælk nedenfor. Så ser du her, når de er billige eller kommer på
          tilbud.
        </Notice>
      ) : onSale.length === 0 ? (
        <Notice title="Ingen af dine varer er på tilbud lige nu">
          Vi holder øje og viser dem her, så snart de kommer på tilbud – også tilbud, der først
          gælder fra næste uge.
        </Notice>
      ) : (
        <div className="space-y-3">
          {onSale.map((m) => {
            const shown = m.offers.length + m.textOffers.length;
            const more = m.offerCount - shown + (m.clearanceCount - m.clearances.length);
            const startedOffers = m.offers.filter(
              (l) => Date.parse(l.offer.validFrom) <= now.getTime(),
            );
            const status =
              m.offerCount === 0
                ? "Madspild nær dig"
                : startedOffers.length === 0 && m.offers.length > 0
                  ? `På tilbud fra ${formatDayDate(m.offers[0]!.offer.validFrom)}`
                  : "Billig nu";
            return (
              <article
                key={m.staple.id}
                aria-labelledby={`vare-${m.staple.id}`}
                className="rounded-xl border border-line bg-surface px-4 pt-2 pb-1 lg:px-5"
              >
                <h2
                  id={`vare-${m.staple.id}`}
                  className="flex flex-wrap items-baseline gap-x-2 text-heading font-semibold text-ink"
                >
                  {m.staple.label}
                  <span className="text-meta font-medium text-good-fg">{status}</span>
                  <span className="text-meta font-normal text-ink-3 tabular">
                    {m.offerCount} tilbud
                    {m.clearanceCount ? `, ${m.clearanceCount} madspild` : ""}
                    {m.staple.kind === "text" ? " · navnesøgning, uden prisdom" : ""}
                  </span>
                </h2>
                <ul className="divide-y divide-line">
                  {m.offers.map((l) => (
                    <OfferRow key={l.listingId} listing={l} now={now} stores={storesByChain} />
                  ))}
                  {m.textOffers.map((o) => (
                    <TextOfferRow key={o.listingId} offer={o} now={now} stores={storesByChain} />
                  ))}
                  {m.clearances.map((w) => (
                    <ClearanceRow key={w.listingId} item={w} now={now} />
                  ))}
                </ul>
                {more > 0 ? <p className="pb-1 text-micro text-ink-3">+{more} flere</p> : null}
              </article>
            );
          })}
        </div>
      )}
      {quiet.length > 0 && onSale.length > 0 ? (
        <p className="mt-3 text-meta text-ink-2">
          Ikke på tilbud lige nu: {quiet.map((m) => m.staple.label).join(", ")}
        </p>
      ) : null}
      <div className="mt-4 rounded-xl border border-line bg-surface px-4 lg:px-5">
        <StaplePicker selected={selected} open={selected.length === 0} />
      </div>
    </section>
  );
}
