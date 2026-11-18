/**
 * Danish formatting of money, unit prices, distances and dates.
 *
 * Dates are always shown in Europe/Copenhagen, regardless of the server's time zone. Month and
 * weekday names are spelled out here (not left to ICU) so output is stable across Node versions.
 */

export const TIME_ZONE = "Europe/Copenhagen";

/** Non-breaking space: keeps "33,33 kr." and "45 %" on one line. */
const NBSP = " ";

const MONTHS = [
  "jan.",
  "feb.",
  "mar.",
  "apr.",
  "maj",
  "jun.",
  "jul.",
  "aug.",
  "sep.",
  "okt.",
  "nov.",
  "dec.",
] as const;

const WEEKDAYS = ["søn.", "man.", "tirs.", "ons.", "tors.", "fre.", "lør."] as const;

const UNIT_LABELS: Record<string, string> = { kg: "kg", l: "l", stk: "stk." };

const numberFormats = new Map<number, Intl.NumberFormat>();

function numberFormat(decimals: number): Intl.NumberFormat {
  let fmt = numberFormats.get(decimals);
  if (!fmt) {
    fmt = new Intl.NumberFormat("da-DK", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberFormats.set(decimals, fmt);
  }
  return fmt;
}

/** A number in Danish notation: `1234.5` -> `"1.234,50"`. */
export function formatNumber(value: number, decimals = 2): string {
  return numberFormat(decimals).format(value);
}

/** An amount in Danish kroner: `33.33` -> `"33,33 kr."`. */
export function formatDkk(value: number): string {
  return `${formatNumber(value)}${NBSP}kr.`;
}

/** The display label of a unit (`kg`, `l`, `stk.`). */
export function unitLabel(unit: string | null | undefined): string {
  if (!unit) return "enhed";
  return UNIT_LABELS[unit] ?? unit;
}

/** A unit price: `(33.33, "kg")` -> `"33,33 kr./kg"`. */
export function formatUnitPrice(value: number, unit: string | null | undefined): string {
  return `${formatNumber(value)}${NBSP}kr./${unitLabel(unit)}`;
}

/**
 * A unit-price range; collapses to a single price when both ends round to the same øre.
 *
 * `(33.33, 41.67, "kg")` -> `"33,33–41,67 kr./kg"`.
 */
export function formatUnitPriceRange(
  min: number | null,
  max: number | null,
  unit: string | null | undefined,
): string | null {
  const lo = min ?? max;
  const hi = max ?? min;
  if (lo == null || hi == null) return null;
  if (formatNumber(lo) === formatNumber(hi)) return formatUnitPrice(lo, unit);
  return `${formatNumber(lo)}–${formatNumber(hi)}${NBSP}kr./${unitLabel(unit)}`;
}

/** A percentage in Danish style: `45.5` -> `"46 %"`. */
export function formatPercent(value: number, decimals = 0): string {
  return `${formatNumber(value, decimals)}${NBSP}%`;
}

/** A distance: below 1 km in whole tens of metres, otherwise in km with one decimal. */
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)}${NBSP}m`;
  return `${formatNumber(km, 1)}${NBSP}km`;
}

interface CopenhagenParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(value)}`);
  return date;
}

/** Calendar fields of `value` as seen on a wall clock in Copenhagen. */
export function copenhagenParts(value: Date | string): CopenhagenParts {
  const date = toDate(value);
  const parts: Record<string, number> = {};
  for (const part of partsFormat.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const year = parts.year ?? 0;
  const month = parts.month ?? 1;
  const day = parts.day ?? 1;
  // Weekday of the Copenhagen calendar date (independent of the server's zone).
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, weekday, hour: parts.hour ?? 0, minute: parts.minute ?? 0 };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A date: `"20. nov. 2026"` (year omitted when `withYear` is false). */
export function formatDate(value: Date | string, { withYear = true } = {}): string {
  const p = copenhagenParts(value);
  const base = `${p.day}. ${MONTHS[p.month - 1]}`;
  return withYear ? `${base} ${p.year}` : base;
}

/** A date with weekday and without year: `"tors. 20. nov."`. */
export function formatDayDate(value: Date | string): string {
  const p = copenhagenParts(value);
  return `${WEEKDAYS[p.weekday]} ${p.day}. ${MONTHS[p.month - 1]}`;
}

/** A date and time: `"18. nov. 2026 kl. 14.05"`. */
export function formatDateTime(value: Date | string): string {
  const p = copenhagenParts(value);
  return `${formatDate(value)} kl.${NBSP}${pad2(p.hour)}.${pad2(p.minute)}`;
}

/**
 * The last moment of a validity period ending at `value`, for display.
 *
 * Rema periods are stored with an exclusive end at the next Copenhagen midnight (a campaign
 * ending Saturday has `valid_to` = Sunday 00:00), Tjek periods with an inclusive end (22:59:59
 * UTC). An end exactly at Copenhagen midnight is shown as the day before, so both read the same.
 */
export function displayEnd(value: Date | string): Date {
  const date = toDate(value);
  const p = copenhagenParts(date);
  const atMidnight =
    p.hour === 0 && p.minute === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  return atMidnight ? new Date(date.getTime() - 1) : date;
}

/**
 * A validity period: `"tors. 20. nov. – ons. 26. nov."`, or open-ended `"fra tors. 20. nov."`.
 * The end is shown as its last day (see {@link displayEnd}).
 */
export function formatPeriod(
  from: Date | string | null | undefined,
  to: Date | string | null | undefined,
): string {
  if (from && to) return `${formatDayDate(from)} – ${formatDayDate(displayEnd(to))}`;
  if (from) return `fra ${formatDayDate(from)}`;
  if (to) return `til ${formatDayDate(displayEnd(to))}`;
  return "ukendt periode";
}

/** Time relative to `now` in Danish: `"for 3 timer siden"`, `"om 2 dage"`, `"lige nu"`. */
export function formatRelative(value: Date | string, now: Date = new Date()): string {
  const seconds = (toDate(value).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 60) return "lige nu";
  const units: [number, string, string][] = [
    [60, "minut", "minutter"],
    [3600, "time", "timer"],
    [86400, "dag", "dage"],
  ];
  let amount = Math.round(abs / 60);
  let [singular, plural] = ["minut", "minutter"];
  for (const [size, one, many] of units) {
    if (abs >= size) {
      amount = Math.floor(abs / size);
      singular = one;
      plural = many;
    }
  }
  const text = `${amount} ${amount === 1 ? singular : plural}`;
  return seconds < 0 ? `for ${text} siden` : `om ${text}`;
}
