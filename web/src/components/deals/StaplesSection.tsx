import type { Route } from "next";
import Link from "next/link";
import { saveStaples } from "@/app/actions";
import { Badge, DiscountPill, MemberBadge, VerdictBadge } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { Disclosure } from "@/components/Disclosure";
import { ChevronIcon } from "@/components/Icons";
import { chainName } from "@/lib/chains";
import type { ListingDeal } from "@/lib/deals";
import { foodWastePackSize, shownDiscount, type FoodWasteItem } from "@/lib/foodwaste";
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
import { StaplesFold } from "./StaplesFold";

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
          <span className="font-bold text-ink tabular">{formatDkk(offer.price)}</span>
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
              <span className="font-bold text-ink tabular">{formatDkk(offer.price)}</span>
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
function ClearanceRow({ item }: { item: FoodWasteItem }) {
  const discount = shownDiscount(item.discountPct);
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
          <span className="font-bold text-ink tabular">{formatDkk(item.price)}</span>
          {item.referencePrice != null ? (
            <span className="tabular">
              {" "}
              (før <s>{formatDkk(item.referencePrice)}</s>)
            </span>
          ) : null}
          {sep}
          <span>{foodWastePackSize(item).text}</span>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="rounded-full border border-warn-line bg-warn-bg px-2 py-0.5 text-micro font-medium text-warn-fg">
          Madspild
        </span>
        {discount ? <DiscountPill percent={discount} /> : null}
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
    <Disclosure initialOpen={open} className="group/picker border-t border-line">
      <summary className="flex h-11 items-center gap-1 text-meta font-medium text-link">
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
  folded,
}: {
  selected: readonly string[];
  matches: readonly StapleMatches[];
  now: Date;
  storesByChain: StoresByChain;
  /** The user folded the section away last time. */
  folded: boolean;
}) {
  const onSale = matches.filter((m) => m.offerCount + m.clearanceCount > 0);
  const quiet = matches.filter((m) => m.offerCount + m.clearanceCount === 0);
  const summary =
    selected.length === 0
      ? null
      : onSale.length === 0
        ? "intet på tilbud"
        : `${onSale.length} af ${matches.length} på tilbud`;
  return (
    <section
      aria-labelledby="basisvarer"
      className="rounded-xl border border-line bg-surface px-4 pt-1 lg:px-5"
    >
      <StaplesFold
        // Nothing picked yet: keep it open, the picker is the point.
        initialOpen={selected.length === 0 || !folded}
        summary={summary}
        title={
          <h2 id="basisvarer" className="text-heading font-semibold text-ink">
            Dine basisvarer
          </h2>
        }
      >
        {selected.length === 0 ? (
          <p className="text-meta text-ink-2">
            Vælg fx æg, havregryn og mælk, så ser du dem her, når de er billige.
          </p>
        ) : onSale.length === 0 ? (
          <p className="text-meta text-ink-2">Ingen af dine basisvarer er på tilbud lige nu.</p>
        ) : (
          <div
            tabIndex={0}
            aria-label="Dine basisvarer på tilbud"
            className="-mx-4 max-h-[min(55vh,28rem)] divide-y divide-line overflow-y-auto overscroll-contain border-y border-line px-4 lg:-mx-5 lg:px-5"
          >
            {onSale.map((m) => {
              const shown = m.offers.length + m.textOffers.length;
              const more = m.offerCount - shown + (m.clearanceCount - m.clearances.length);
              return (
                <div key={m.staple.id} className="py-2">
                  <h3 className="text-meta font-semibold text-ink-3">
                    {m.staple.label}{" "}
                    <span className="font-normal tabular">
                      ({m.offerCount} tilbud
                      {m.clearanceCount ? `, ${m.clearanceCount} madspild` : ""}
                      {m.staple.kind === "text" ? ", uden prisdom" : ""})
                    </span>
                  </h3>
                  <ul className="divide-y divide-line">
                    {m.offers.map((l) => (
                      <OfferRow key={l.listingId} listing={l} now={now} stores={storesByChain} />
                    ))}
                    {m.textOffers.map((o) => (
                      <TextOfferRow key={o.listingId} offer={o} now={now} stores={storesByChain} />
                    ))}
                    {m.clearances.map((w) => (
                      <ClearanceRow key={w.listingId} item={w} />
                    ))}
                  </ul>
                  {more > 0 ? <p className="text-micro text-ink-3">+{more} flere</p> : null}
                </div>
              );
            })}
          </div>
        )}
        {quiet.length > 0 && onSale.length > 0 ? (
          <p className="py-2 text-micro text-ink-3">
            Ikke på tilbud: {quiet.map((m) => m.staple.label).join(", ")}
          </p>
        ) : null}
        <StaplePicker selected={selected} open={selected.length === 0} />
      </StaplesFold>
    </section>
  );
}
