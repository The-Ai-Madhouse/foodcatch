"use client";

import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { MemberPriceTag } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { ChevronIcon } from "@/components/Icons";
import { SourceLink } from "@/components/SourceLink";
import { SourcedPrice } from "@/components/SourcedPrice";
import { StoreInfo } from "@/components/StoreInfo";
import type { PriceSource, SourceLink as SourceLinkData } from "@/lib/sources";
import type { StorePin } from "@/lib/stores";

/** One comparison row, prepared on the server (plain JSON). */
export interface ComparisonRow {
  key: string;
  chainId: string;
  chainName: string;
  /** Distance to the chain's nearest store ("330 m"), null for location-independent kinds. */
  distance: string | null;
  unitPrice: string;
  isCheapest: boolean;
  title: string | null;
  /** "Tilbud · 400 g · 15,60 kr. · tor. 20.–lør. 22. nov." */
  facts: string;
  /** The reference's pack price ("15,60 kr."), linked to its source. */
  price: string | null;
  /** Where the reference price can be checked; null without a reference listing. */
  source: PriceSource | null;
  memberOnly: boolean;
  link: SourceLinkData | null;
  /** The reference item's price history page. */
  historyHref: string | null;
  /** The chain's nearest stores for the store popover; null for location-independent kinds. */
  stores: StorePin[] | null;
  /** All of the chain's stores within the radius. */
  storeTotal: number;
}

/** The comparison of one variant: counted rows, then the ones that do not count. */
export interface ComparisonSection {
  key: string;
  /** Variant label, shown when the offer has several variants. */
  label: string | null;
  counted: ComparisonRow[];
  ignored: ComparisonRow[];
  /** The class's price history page. */
  classHref: string;
}

/**
 * "Sammenlign (n)" (docs/ui.md §5.6). The rows arrive as compact JSON and are rendered only once
 * the toggle is opened, so a page with hundreds of offers does not ship every comparison as
 * markup.
 */
export function Comparison({
  count,
  sections,
  radiusKm,
  reserveRight,
}: {
  count: number;
  sections: readonly ComparisonSection[];
  radiusKm: number;
  /** Leave room for the source link next to the summary. */
  reserveRight: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary
        className={`flex h-11 items-center gap-1 text-meta font-medium text-ink ${reserveRight ? "pr-44" : ""}`}
      >
        Sammenlign ({count})
        <ChevronIcon className="details-chevron text-ink-3" />
      </summary>
      {open ? (
        <div className="space-y-4 pb-1">
          {sections.map((section) => (
            <section key={section.key} aria-label={section.label ?? "Sammenligning"}>
              {section.label ? (
                <h4 className="text-meta font-semibold text-ink">{section.label}</h4>
              ) : null}
              {section.counted.length > 0 ? (
                <ul className="divide-y divide-line">
                  {section.counted.map((row) => (
                    <Row key={row.key} row={row} />
                  ))}
                </ul>
              ) : (
                <p className="py-2 text-meta text-ink-3">Ingen sammenligning tæller med.</p>
              )}
              {section.ignored.length > 0 ? (
                <details className="mt-1">
                  <summary className="flex min-h-11 items-center gap-1 text-meta text-ink-2">
                    {section.ignored.length} tæller ikke med – ingen butik inden for {radiusKm} km
                    <ChevronIcon className="details-chevron text-ink-3" />
                  </summary>
                  <ul className="divide-y divide-line opacity-80">
                    {section.ignored.map((row) => (
                      <Row key={row.key} row={row} />
                    ))}
                  </ul>
                </details>
              ) : null}
              <p className="mt-1">
                <Link href={section.classHref as Route} className="text-meta">
                  Prishistorik for varetypen →
                </Link>
              </p>
            </section>
          ))}
        </div>
      ) : null}
    </details>
  );
}

function Row({ row }: { row: ComparisonRow }) {
  return (
    <li className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5 text-meta">
          <ChainDot chainId={row.chainId} size="xs" />
          {row.stores ? (
            <StoreInfo chainId={row.chainId} stores={row.stores} total={row.storeTotal}>
              <span className={row.isCheapest ? "font-semibold text-ink" : "text-ink"}>
                {row.chainName}
              </span>
            </StoreInfo>
          ) : (
            <span className={row.isCheapest ? "font-semibold text-ink" : "text-ink"}>
              {row.chainName}
            </span>
          )}
          {row.distance ? <span className="text-ink-3 tabular">· {row.distance}</span> : null}
        </span>
        <span
          className={`text-meta whitespace-nowrap tabular ${row.isCheapest ? "font-bold text-ink" : "text-ink-2"}`}
        >
          <SourcedPrice source={row.source}>{row.unitPrice}</SourcedPrice>
          {row.isCheapest ? <span className="font-semibold"> billigst</span> : null}
        </span>
      </div>
      {row.title ? <p className="truncate text-meta text-ink-2">{row.title}</p> : null}
      <p className="text-meta text-ink-3">
        {row.facts}
        {row.price ? (
          <>
            {" · "}
            <SourcedPrice source={row.source} className="tabular">
              {row.price}
            </SourcedPrice>
          </>
        ) : null}
        {row.memberOnly ? (
          <span className="ml-1.5 align-middle">
            <MemberPriceTag />
          </span>
        ) : null}
      </p>
      {row.link || row.historyHref ? (
        <div className="flex flex-wrap items-center gap-x-4">
          <SourceLink link={row.link} />
          {row.historyHref ? (
            <Link
              href={row.historyHref as Route}
              className="inline-flex min-h-11 items-center text-meta"
            >
              Prishistorik
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
