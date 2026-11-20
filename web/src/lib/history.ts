/**
 * Price history of one product class (`api.class_price_history`) prepared for an SVG chart:
 * series, time and price scales and axis ticks. Pure and unit tested; the chart component only
 * draws what this module computes.
 */

import { formatDate, copenhagenParts } from "./format";

/** One row of `api.class_price_history`, with numbers parsed and names in camelCase. */
export interface PriceHistoryRow {
  classKey: string;
  classLabel: string;
  /** `offer`, `regular` or `clearance` (listing kind). */
  kind: string;
  chainId: string;
  chainName: string;
  listingId: string;
  title: string;
  unit: string | null;
  unitPriceMin: number | null;
  unitPriceMax: number | null;
  validFrom: string;
  validTo: string | null;
  /**
   * Whether the row's unit price is this product's: false for a multi-product offer whose
   * kilo price range mostly belongs to another product (same rule as the deals, §6).
   */
  priceApplies: boolean;
  /** Only members get this price (e.g. Netto+, Coop members). */
  memberOnly: boolean;
  /** `tjek`, `rema` or `salling_food_waste`. */
  source: string | null;
  sourceItemId: string | null;
  catalogId: string | null;
  /** Store of a food-waste clearance (null for chain-wide prices). */
  storeId: string | null;
  /** Pack price. */
  price: number | null;
  description: string | null;
  sizeMin: number | null;
  sizeMax: number | null;
  /** The listing's item key (its own price history page). */
  productKey: string | null;
}

export type SeriesKey = "offer" | "regular";

export interface SeriesMeta {
  key: SeriesKey;
  label: string;
  /** Categorical slot (1-3) in the validated chart palette. */
  slot: 1 | 2 | 3;
}

/** Fixed series order and colors: color follows the series, never its rank. */
export const SERIES: readonly SeriesMeta[] = [
  { key: "offer", label: "Tilbud", slot: 1 },
  { key: "regular", label: "Normalpris", slot: 3 },
];

export const KIND_LABELS: Readonly<Record<string, string>> = {
  offer: "Tilbud",
  regular: "Normalpris",
  clearance: "Madspild",
};

export interface ChartMark {
  row: PriceHistoryRow;
  series: SeriesKey;
  /** Epoch milliseconds. */
  start: number;
  end: number;
  /** Whether the end is open (no `valid_to`, drawn up to now). */
  openEnded: boolean;
  low: number;
  high: number;
}

export interface Tick {
  value: number;
  label: string;
}

export interface PriceChartModel {
  unit: string | null;
  marks: ChartMark[];
  series: SeriesMeta[];
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: Tick[];
  yTicks: Tick[];
  /**
   * Rows left out of the chart (other unit, clearance, no unit price, a price that covers
   * other products, or outside the window).
   */
  excluded: number;
}

const DAY_MS = 86_400_000;

/** The chart window: at most this many days back from now. */
export const MAX_WINDOW_DAYS = 365;

/** The series a row belongs to, or null when it is not charted (e.g. clearances). */
export function seriesOf(row: Pick<PriceHistoryRow, "kind" | "chainId">): SeriesKey | null {
  if (row.kind === "regular") return "regular";
  if (row.kind === "offer") return "offer";
  return null;
}

/** The most common unit among rows with a unit price (ties: kg, l, stk). */
export function dominantUnit(rows: readonly PriceHistoryRow[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.unit && (r.unitPriceMin != null || r.unitPriceMax != null)) {
      counts.set(r.unit, (counts.get(r.unit) ?? 0) + 1);
    }
  }
  const order = ["kg", "l", "stk"];
  let best: string | null = null;
  let bestCount = 0;
  for (const [unit, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && best != null && order.indexOf(unit) < order.indexOf(best))
    ) {
      best = unit;
      bestCount = count;
    }
  }
  return best;
}

/** About `count` evenly spaced "nice" values (1, 2, 2.5, 5 × 10^n) covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    return niceTicks(min - pad, max + pad, count);
  }
  const rawStep = (max - min) / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ?? 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  if ((ticks.at(-1) ?? -Infinity) < max)
    ticks.push(Math.round((start + ticks.length * step) * 1e6) / 1e6);
  return ticks;
}

/** Ticks on the time axis: Mondays for short spans, first of the month for longer ones. */
export function timeTicks(start: number, end: number): Tick[] {
  const spanDays = (end - start) / DAY_MS;
  const ticks: Tick[] = [];
  if (spanDays <= 70) {
    const stepDays = spanDays <= 21 ? 7 : 14;
    // Walk days at noon UTC (safe across DST) and keep Copenhagen Mondays.
    const first = new Date(start);
    first.setUTCHours(12, 0, 0, 0);
    let mondaysSeen = 0;
    for (let t = first.getTime(); t <= end; t += DAY_MS) {
      if (copenhagenParts(new Date(t)).weekday !== 1) continue;
      if (mondaysSeen % (stepDays / 7) === 0 && t >= start) {
        ticks.push({ value: t, label: formatDate(new Date(t), { withYear: false }) });
      }
      mondaysSeen += 1;
    }
    return ticks;
  }
  const stepMonths = spanDays <= 200 ? 1 : 2;
  const p = copenhagenParts(new Date(start));
  let year = p.year;
  let month = p.month; // 1-12; first tick is the next month start
  for (;;) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    const t = Date.UTC(year, month - 1, 1, 12);
    if (t > end) break;
    if ((month - 1) % stepMonths !== 0) continue;
    const label = formatDate(new Date(t), { withYear: false }).replace(/^1\. /, "");
    ticks.push({ value: t, label: month === 1 ? `${label} ${year}` : label });
  }
  return ticks;
}

/** Build the chart model for one class's history as seen at `now`. */
export function buildPriceChart(rows: readonly PriceHistoryRow[], now: Date): PriceChartModel {
  const unit = dominantUnit(rows);
  const nowMs = now.getTime();
  const windowStart = nowMs - MAX_WINDOW_DAYS * DAY_MS;
  const marks: ChartMark[] = [];
  for (const row of rows) {
    const series = seriesOf(row);
    const low = row.unitPriceMin ?? row.unitPriceMax;
    const high = row.unitPriceMax ?? row.unitPriceMin;
    if (series == null || low == null || high == null || row.unit !== unit) continue;
    if (!row.priceApplies) continue;
    const start = Date.parse(row.validFrom);
    const openEnded = row.validTo == null;
    const end = openEnded ? Math.max(nowMs, start + DAY_MS) : Date.parse(row.validTo ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < windowStart) continue;
    marks.push({ row, series, start: Math.max(start, windowStart), end, openEnded, low, high });
  }

  const xMin = marks.length ? Math.min(...marks.map((m) => m.start)) : nowMs - 28 * DAY_MS;
  const xMax = marks.length ? Math.max(nowMs, ...marks.map((m) => m.end)) : nowMs;
  const yValues = marks.flatMap((m) => [m.low, m.high]);
  const yTickValues = yValues.length
    ? niceTicks(Math.min(...yValues), Math.max(...yValues))
    : niceTicks(0, 100);
  const yDomain: [number, number] = [yTickValues[0] ?? 0, yTickValues.at(-1) ?? 1];
  const present = new Set(marks.map((m) => m.series));

  return {
    unit,
    marks,
    series: SERIES.filter((s) => present.has(s.key)),
    xDomain: [xMin, xMax],
    yDomain,
    xTicks: timeTicks(xMin, xMax),
    yTicks: yTickValues.map((v) => ({
      value: v,
      label: new Intl.NumberFormat("da-DK", { maximumFractionDigits: 2 }).format(v),
    })),
    excluded: rows.length - marks.length,
  };
}

/** A linear scale from `domain` to `range`. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}
