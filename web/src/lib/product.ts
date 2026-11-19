/**
 * The price history of one item (`api.product_price_history`, keyed by `product_key`) prepared
 * for an SVG chart and a table: which price to plot (pack price or unit price), step lines for
 * shelf prices, segments for offers and points for clearances, scales and ticks. Pure and unit
 * tested; the chart component only draws what this module computes.
 */

import { chainName } from "./chains";
import { formatDate } from "./format";
import { niceTicks, timeTicks, type Tick } from "./history";

/** One row of `api.product_price_history`, with numbers parsed and names in camelCase. */
export interface ProductHistoryRow {
  productKey: string;
  productLabel: string;
  chainId: string;
  /** `offer`, `regular`, `clearance` or `reference` (Salling's normal price for the EAN). */
  kind: string;
  /** Pack price. */
  price: number | null;
  unit: string | null;
  unitPriceMin: number | null;
  unitPriceMax: number | null;
  sizeMin: number | null;
  sizeMax: number | null;
  validFrom: string;
  validTo: string | null;
  source: string | null;
  sourceItemId: string | null;
  catalogId: string | null;
  storeId: string | null;
  memberOnly: boolean;
  listingId: string | null;
  title: string;
}

/** One row of `api.products` (the fields the page uses). */
export interface ProductInfo {
  productKey: string;
  label: string;
  chainId: string;
  chainName: string;
  classKey: string | null;
  classLabel: string | null;
  isExact: boolean | null;
  ean: string | null;
  latestSource: string | null;
  latestPrice: number | null;
  latestUnit: string | null;
  latestSizeMin: number | null;
  latestSizeMax: number | null;
  latestValidFrom: string | null;
  latestValidTo: string | null;
}

/** The price on the y axis: what the pack costs, or the price per kg / l / piece. */
export type Measure = "pakke" | "enhed";

/** Kinds in legend order. */
export const PRODUCT_KINDS = ["regular", "reference", "offer", "clearance"] as const;

export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const PRODUCT_KIND_LABELS: Readonly<Record<ProductKind, string>> = {
  regular: "Normalpris",
  reference: "Normalpris ifølge Salling",
  offer: "Tilbud",
  clearance: "Madspild",
};

/** The Danish label of a history row's kind. */
export function productKindLabel(kind: string): string {
  return (PRODUCT_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

const isKind = (kind: string): kind is ProductKind =>
  (PRODUCT_KINDS as readonly string[]).includes(kind);

/** The day FoodCatch started collecting offers and clearances (REMA 1000 prices go back years). */
export const HISTORY_START = "2026-11-18T00:00:00+01:00";

const DAY_MS = 86_400_000;

/** The default chart window; `?periode=alt` shows everything. */
export const DEFAULT_WINDOW_DAYS = 365;

/** Shelf prices of one chain closer together than this are joined by a vertical step. */
const STEP_JOIN_MS = 2 * DAY_MS;

/** Parse `?pris=`: the pack price unless the unit price is asked for (and available). */
export function parseMeasure(value: string | string[] | undefined, canUnit: boolean): Measure {
  return value === "enhed" && canUnit ? "enhed" : "pakke";
}

/** The unit that most rows with a unit price use (ties: kg, l, stk), or null. */
export function productUnit(rows: readonly ProductHistoryRow[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.unit && (r.unitPriceMin != null || r.unitPriceMax != null)) {
      counts.set(r.unit, (counts.get(r.unit) ?? 0) + 1);
    }
  }
  const order = ["kg", "l", "stk"];
  const rank = (u: string) => (order.includes(u) ? order.indexOf(u) : order.length);
  let best: string | null = null;
  for (const [unit, count] of counts) {
    const bestCount = best ? (counts.get(best) ?? 0) : 0;
    if (count > bestCount || (count === bestCount && best && rank(unit) < rank(best))) best = unit;
  }
  return best;
}

/** The plotted value range of a row, or null when it has no such price. */
export function rowValue(
  row: ProductHistoryRow,
  measure: Measure,
  unit: string | null,
): { low: number; high: number } | null {
  if (measure === "pakke") {
    return row.price != null && row.price > 0 ? { low: row.price, high: row.price } : null;
  }
  if (unit == null || row.unit !== unit) return null;
  const low = row.unitPriceMin ?? row.unitPriceMax;
  const high = row.unitPriceMax ?? row.unitPriceMin;
  return low != null && high != null ? { low, high } : null;
}

export interface ProductMark {
  row: ProductHistoryRow;
  kind: ProductKind;
  chainId: string;
  /** Epoch milliseconds. */
  start: number;
  end: number;
  /** No `valid_to`: drawn up to now. */
  openEnded: boolean;
  low: number;
  high: number;
}

/** Consecutive shelf prices of one chain and kind, drawn as one step line. */
export interface StepSeries {
  key: string;
  kind: "regular" | "reference";
  chainId: string;
  marks: ProductMark[];
}

export interface ProductChartModel {
  measure: Measure;
  /** Unit of the unit prices (also when the pack price is plotted). */
  unit: string | null;
  steps: StepSeries[];
  /** Offers: one segment (or band) over the validity period. */
  segments: ProductMark[];
  /** Clearances: one point at the day they were seen. */
  points: ProductMark[];
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: Tick[];
  yTicks: Tick[];
  /** Chains drawn, in order of first appearance. */
  chains: string[];
  /** Kinds drawn, in legend order. */
  kinds: ProductKind[];
  /** Rows in the chart. */
  charted: number;
  /** Rows not in the chart (no such price, or before the window). */
  excluded: number;
  /** Start of the earliest row when it is before the window (for "show everything"), or null. */
  olderFrom: string | null;
}

/** Build the chart of one item's history as seen at `now`. */
export function buildProductChart(
  rows: readonly ProductHistoryRow[],
  now: Date,
  { measure = "pakke" as Measure, all = false } = {},
): ProductChartModel {
  const unit = productUnit(rows);
  const nowMs = now.getTime();
  const windowStart = all ? Number.NEGATIVE_INFINITY : nowMs - DEFAULT_WINDOW_DAYS * DAY_MS;
  const marks: ProductMark[] = [];
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const start = Date.parse(row.validFrom);
    if (Number.isFinite(start)) earliest = Math.min(earliest, start);
    const value = rowValue(row, measure, unit);
    if (!value || !isKind(row.kind) || !Number.isFinite(start)) continue;
    const openEnded = row.validTo == null;
    const end = openEnded ? Math.max(nowMs, start + DAY_MS) : Date.parse(row.validTo ?? "");
    if (!Number.isFinite(end) || end < windowStart) continue;
    marks.push({
      row,
      kind: row.kind,
      chainId: row.chainId,
      start: Math.max(start, windowStart),
      end: Math.max(end, start),
      openEnded,
      ...value,
    });
  }

  const steps = new Map<string, StepSeries>();
  const segments: ProductMark[] = [];
  const points: ProductMark[] = [];
  for (const mark of marks) {
    if (mark.kind === "offer") segments.push(mark);
    else if (mark.kind === "clearance") points.push(mark);
    else {
      const key = `${mark.kind}|${mark.chainId}`;
      const series = steps.get(key);
      if (series) series.marks.push(mark);
      else steps.set(key, { key, kind: mark.kind, chainId: mark.chainId, marks: [mark] });
    }
  }
  for (const s of steps.values()) s.marks.sort((a, b) => a.start - b.start);

  const xMin = marks.length ? Math.min(...marks.map((m) => m.start)) : nowMs - 28 * DAY_MS;
  const xMax = marks.length ? Math.max(nowMs, ...marks.map((m) => m.end)) : nowMs;
  // A price without an end still applies: it runs to the right edge of the chart.
  for (const m of marks) if (m.openEnded) m.end = xMax;
  const yValues = marks.flatMap((m) => [m.low, m.high]);
  const yLow = Math.min(...yValues);
  const yHigh = Math.max(...yValues);
  // Headroom, so no price is drawn on the axis line.
  const yPad = (yHigh - yLow) * 0.08 || yHigh * 0.05;
  const yTickValues = yValues.length
    ? niceTicks(Math.max(0, yLow - yPad), yHigh + yPad)
    : niceTicks(0, 100);
  const chains: string[] = [];
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    if (!chains.includes(m.chainId)) chains.push(m.chainId);
  }
  const present = new Set(marks.map((m) => m.kind));
  const yFormat = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 2 });

  return {
    measure,
    unit,
    steps: [...steps.values()],
    segments,
    points,
    xDomain: [xMin, xMax],
    yDomain: [yTickValues[0] ?? 0, yTickValues.at(-1) ?? 1],
    xTicks: timeTicks(xMin, xMax),
    yTicks: yTickValues.map((v) => ({ value: v, label: yFormat.format(v) })),
    chains,
    kinds: PRODUCT_KINDS.filter((k) => present.has(k)),
    charted: marks.length,
    excluded: rows.length - marks.length,
    olderFrom:
      !all && Number.isFinite(earliest) && earliest < nowMs - DEFAULT_WINDOW_DAYS * DAY_MS
        ? new Date(earliest).toISOString()
        : null,
  };
}

/**
 * The SVG path of a step line: each price is a horizontal run over its period; runs that follow
 * each other within two days are joined by a vertical step, longer gaps stay open.
 */
export function stepPath(
  marks: readonly Pick<ProductMark, "start" | "end" | "high">[],
  x: (t: number) => number,
  y: (v: number) => number,
): string {
  const parts: string[] = [];
  let prevEnd: number | null = null;
  for (const m of marks) {
    const x1 = x(m.start).toFixed(1);
    const x2 = Math.max(x(m.end), x(m.start) + 2).toFixed(1);
    const yv = y(m.high).toFixed(1);
    if (prevEnd != null && m.start - prevEnd <= STEP_JOIN_MS) parts.push(`L${x1},${yv}`);
    else parts.push(`M${x1},${yv}`);
    parts.push(`L${x2},${yv}`);
    prevEnd = m.end;
  }
  return parts.join(" ");
}

/**
 * The note shown when the history is still short: collecting began on {@link HISTORY_START}
 * (REMA 1000 prices come with years of history, so they never get it).
 */
export function shortHistoryNote(
  productKey: string,
  rows: readonly Pick<ProductHistoryRow, "validFrom">[],
  now: Date,
): string | null {
  if (productKey.startsWith("rema:")) return null;
  const starts = rows.map((r) => Date.parse(r.validFrom)).filter(Number.isFinite);
  const earliest = starts.length ? Math.min(...starts) : now.getTime();
  if (now.getTime() - earliest >= 60 * DAY_MS && rows.length >= 3) return null;
  return `Historik indsamles fra ${formatDate(HISTORY_START)}`;
}

/** Rows newest first (the table under the chart). */
export function newestFirst<T extends Pick<ProductHistoryRow, "validFrom" | "kind">>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom) || a.kind.localeCompare(b.kind),
  );
}

/** The accessible summary of the chart: what is plotted and the price range. */
export function chartSummary(model: ProductChartModel, title: string): string {
  if (model.charted === 0) return `${title}: ingen priser at vise i grafen.`;
  const values = [
    ...model.segments,
    ...model.points,
    ...model.steps.flatMap((s) => s.marks),
  ].flatMap((m) => [m.low, m.high]);
  const fmt = new Intl.NumberFormat("da-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const what = model.measure === "pakke" ? "pakkepris" : "enhedspris";
  const chains = model.chains.map(chainName).join(", ");
  return `${title}: ${what} over tid fra ${chains}, mellem ${fmt.format(Math.min(...values))} og ${fmt.format(Math.max(...values))} kr. Samme tal står i tabellen under grafen.`;
}
