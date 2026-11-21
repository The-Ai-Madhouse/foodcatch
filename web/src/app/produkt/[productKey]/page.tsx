import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MemberPriceTag } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { Notice } from "@/components/Notice";
import { ProductPriceChart } from "@/components/ProductPriceChart";
import { Segmented } from "@/components/Segmented";
import { SourceLink } from "@/components/SourceLink";
import { SourcedPrice } from "@/components/SourcedPrice";
import { chainName } from "@/lib/chains";
import { cleanClassLabel, unitPriceWord } from "@/lib/deals";
import {
  displayTitle,
  formatDate,
  formatDkk,
  formatShortPeriod,
  formatUnitPriceRange,
  packSize,
} from "@/lib/format";
import {
  buildProductChart,
  newestFirst,
  parseMeasure,
  productKindLabel,
  shortHistoryNote,
} from "@/lib/product";
import { classPath, productKeyFromSegment, productPath } from "@/lib/routes";
import { openFoodFactsProductLink, priceSource, sourceLink } from "@/lib/sources";
import { storeDisplayName } from "@/lib/stores";
import { getProduct, getProductHistory, getStoresByIds } from "@/server/queries";

async function load(segment: string) {
  const productKey = productKeyFromSegment(segment);
  if (!productKey) return null;
  const [product, rows] = await Promise.all([
    getProduct(productKey),
    getProductHistory(productKey),
  ]);
  if (!product && rows.length === 0) return null;
  const label = product?.label ?? rows[0]?.productLabel ?? productKey;
  return { productKey, product, rows, title: displayTitle(label) };
}

export async function generateMetadata({
  params,
}: PageProps<"/produkt/[productKey]">): Promise<Metadata> {
  const data = await load((await params).productKey);
  return { title: data ? `Prishistorik: ${data.title}` : "Ukendt vare" };
}

/** `?pris=enhed&periode=alt` for this page, keeping the defaults out of the URL. */
function href(productKey: string, measure: "pakke" | "enhed", all: boolean): Route {
  const params = new URLSearchParams();
  if (measure === "enhed") params.set("pris", "enhed");
  if (all) params.set("periode", "alt");
  const query = params.toString();
  return `${productPath(productKey)}${query ? `?${query}` : ""}` as Route;
}

/**
 * The price history of one item (docs/ui.md §6.5): its shelf prices, offers, clearances and
 * Salling's normal price for the EAN over time, as a chart and a table with source links.
 */
export default async function ProductHistoryPage({
  params,
  searchParams,
}: PageProps<"/produkt/[productKey]">) {
  const data = await load((await params).productKey);
  if (!data) notFound();
  const { productKey, product, rows, title } = data;
  const query = await searchParams;
  const now = new Date();
  const canUnit = rows.some((r) => r.unitPriceMin != null || r.unitPriceMax != null);
  const measure = parseMeasure(query.pris, canUnit);
  const all = query.periode === "alt";
  const model = buildProductChart(rows, now, { measure, all });
  const note = shortHistoryNote(productKey, rows, now);
  const chainId = product?.chainId ?? rows.at(-1)?.chainId ?? null;
  const ean = product?.ean ?? (productKey.startsWith("ean:") ? productKey.slice(4) : null);
  const off = openFoodFactsProductLink(ean);
  const stores = await getStoresByIds(rows.flatMap((r) => (r.storeId ? [r.storeId] : [])));
  const table = newestFirst(rows);

  return (
    <div className="mx-auto max-w-[760px]">
      <h1 className="text-display shelf text-ink">{title}</h1>
      <p className="flex flex-wrap items-center gap-x-1.5 text-meta text-ink-2">
        {chainId ? (
          <>
            <ChainDot chainId={chainId} size="xs" />
            <span>{product?.chainName ?? chainName(chainId)}</span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        {ean ? (
          <>
            <span className="tabular">EAN {ean}</span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <span>
          {rows.length} {rows.length === 1 ? "pris" : "priser"} registreret
        </span>
      </p>
      <p className="flex flex-wrap items-center gap-x-4">
        {product?.classKey && product.classLabel ? (
          <Link
            href={classPath(product.classKey) as Route}
            className="inline-flex min-h-11 items-center text-meta"
          >
            Varetypen {cleanClassLabel(product.classLabel).toLocaleLowerCase("da-DK")} i alle kæder
            →
          </Link>
        ) : null}
        {off ? <SourceLink link={off} className="min-h-11" /> : null}
      </p>

      {canUnit ? (
        <div className="mt-2">
          <Segmented
            label="Vis pris"
            items={[
              {
                href: href(productKey, "pakke", all),
                label: "Pakkepris",
                active: measure === "pakke",
              },
              {
                href: href(productKey, "enhed", all),
                label: `${unitPriceWord(model.unit).replace(/^./, (c) => c.toLocaleUpperCase("da-DK"))}`,
                active: measure === "enhed",
              },
            ]}
          />
        </div>
      ) : null}

      {note ? <p className="mt-3 text-meta text-ink-2">{note}.</p> : null}

      <div className="mt-3">
        {model.charted > 0 ? (
          <ProductPriceChart model={model} title={title} now={now.getTime()} />
        ) : (
          <Notice title="Ingen priser at vise i grafen">
            {measure === "enhed"
              ? "Ingen af priserne har en pris pr. enhed. Skift til pakkepris."
              : "Priserne står i tabellen nedenfor."}
          </Notice>
        )}
      </div>
      <p className="mt-2 flex flex-wrap gap-x-4 text-meta text-ink-3">
        {model.excluded > 0 && model.charted > 0 ? (
          <span>
            {model.excluded} {model.excluded === 1 ? "pris" : "priser"} kun i tabellen
            {measure === "enhed" ? " (uden pris pr. enhed eller ældre)" : " (ældre)"}.
          </span>
        ) : null}
        {model.olderFrom ? (
          <Link href={href(productKey, measure, true)} className="min-h-11">
            Vis hele historikken (fra {formatDate(model.olderFrom)})
          </Link>
        ) : all ? (
          <Link href={href(productKey, measure, false)} className="min-h-11">
            Vis kun det seneste år
          </Link>
        ) : null}
      </p>

      <h2 className="mt-6 mb-2 text-meta font-semibold text-ink-3">Alle priser</h2>
      <div className="rounded-xl border border-line bg-surface">
        <table className="w-full table-fixed border-collapse text-left text-meta">
          <caption className="sr-only">Alle registrerede priser for {title}, nyeste først</caption>
          <thead className="text-ink-3">
            <tr className="border-b border-line">
              <th scope="col" className="w-[27%] px-2 py-2 font-medium lg:px-4">
                Periode
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Kæde og type
              </th>
              <th scope="col" className="w-[29%] px-2 py-2 text-right font-medium lg:px-4">
                Pris
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {table.map((row, i) => {
              const size = packSize({
                unit: row.unit,
                sizeMin: row.sizeMin,
                sizeMax: row.sizeMax,
                source: row.source,
                description: null,
              });
              const unitPrice = formatUnitPriceRange(row.unitPriceMin, row.unitPriceMax, row.unit);
              const store = row.storeId ? stores.get(row.storeId) : undefined;
              const link =
                row.kind === "reference"
                  ? null
                  : sourceLink(
                      {
                        source: row.source,
                        chainId: row.chainId,
                        sourceItemId: row.sourceItemId,
                        catalogId: row.catalogId,
                        validTo: row.validTo,
                      },
                      now,
                    );
              const rowSource = priceSource(
                {
                  source: row.kind === "reference" ? "salling" : row.source,
                  chainId: row.chainId,
                  sourceItemId: row.sourceItemId,
                  catalogId: row.catalogId,
                  validTo: row.validTo,
                  ean,
                },
                now,
              );
              return (
                <tr key={`${row.listingId ?? row.kind}-${i}`} className="align-top">
                  <td className="px-2 py-2.5 text-ink-2 lg:px-4">
                    {formatShortPeriod(row.validFrom, row.validTo)}
                  </td>
                  <td className="px-2 py-2.5">
                    <span className="flex items-center gap-1.5 font-semibold text-ink">
                      <ChainDot chainId={row.chainId} size="xs" />
                      {chainName(row.chainId)}
                    </span>
                    <span className="block text-ink-2">
                      {productKindLabel(row.kind)}
                      {row.memberOnly ? (
                        <span className="ml-1.5 align-middle">
                          <MemberPriceTag />
                        </span>
                      ) : null}
                    </span>
                    {store ? (
                      <span className="block text-ink-2">
                        {storeDisplayName(store.name, store.chainId)}
                      </span>
                    ) : null}
                    {row.title !== title &&
                    row.title.toLocaleLowerCase("da-DK") !== title.toLocaleLowerCase("da-DK") ? (
                      <span className="block truncate text-ink-3" title={row.title}>
                        {row.title}
                      </span>
                    ) : null}
                    <SourceLink link={link} className="break-words" />
                  </td>
                  <td className="px-2 py-2.5 text-right tabular lg:px-4">
                    {row.price != null ? (
                      <SourcedPrice source={rowSource} className="block font-semibold text-ink">
                        {formatDkk(row.price)}
                      </SourcedPrice>
                    ) : null}
                    {size.origin !== "unknown" ? (
                      <span className="block text-ink-2">{size.text}</span>
                    ) : null}
                    {unitPrice ? (
                      <SourcedPrice source={rowSource} className="block text-ink-2">
                        {unitPrice}
                      </SourcedPrice>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.some((r) => r.kind === "reference") ? (
        <p className="mt-2 text-meta text-ink-3">
          Normalpris ifølge Salling er den førpris, Salling Group oplyser på madspildsvarer med
          samme EAN – en pris for pakken.
        </p>
      ) : null}
    </div>
  );
}
