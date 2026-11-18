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

const compactFormats = new Map<number, Intl.NumberFormat>();

/** A number with at most `maxDecimals` decimals and no trailing zeros: `1.450` -> `"1,45"`. */
export function formatCompact(value: number, maxDecimals = 3): string {
  let fmt = compactFormats.get(maxDecimals);
  if (!fmt) {
    fmt = new Intl.NumberFormat("da-DK", { maximumFractionDigits: maxDecimals });
    compactFormats.set(maxDecimals, fmt);
  }
  return fmt.format(value);
}

/** A range of formatted values; collapses to one value when both ends read the same. */
function formatRange(lo: string, hi: string, suffix: string): string {
  return lo === hi ? `${lo}${NBSP}${suffix}` : `${lo}–${hi}${NBSP}${suffix}`;
}

/**
 * A pack size in its natural unit (docs/ui.md §5.3): grams/millilitres below 1 kg/l, otherwise
 * kg/l with up to three decimals, pieces as "stk.". `(0.25, 0.4, "kg")` -> `"250–400 g"`.
 * Returns null when no size is known.
 */
export function formatQuantity(
  min: number | null | undefined,
  max: number | null | undefined,
  unit: string | null | undefined,
): string | null {
  const lo = min ?? max;
  const hi = max ?? min;
  if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) {
    return null;
  }
  if (unit === "kg" || unit === "l") {
    if (hi < 1) {
      const small = unit === "kg" ? "g" : "ml";
      return formatRange(formatCompact(lo * 1000, 0), formatCompact(hi * 1000, 0), small);
    }
    return formatRange(formatCompact(lo), formatCompact(hi), unit);
  }
  if (unit === "stk") return formatRange(formatCompact(lo, 2), formatCompact(hi, 2), "stk.");
  if (!unit) return null;
  return formatRange(formatCompact(lo), formatCompact(hi), unit);
}

/** Where a shown pack size comes from; decides whether a unit price may be shown next to it. */
export type PackSizeOrigin =
  /** The source states it (Tjek quantity, size in the Salling name). */
  | "source"
  /** Parsed from REMA 1000's description ("400 GR. / …"). */
  | "description"
  /** Computed from price and compare price (approximate, shown with "ca."). */
  | "computed"
  /** Open Food Facts (crowd-sourced; never used for a unit price). */
  | "off"
  /** Sold by weight. */
  | "variable"
  | "unknown";

export interface PackSize {
  text: string;
  origin: PackSizeOrigin;
}

export interface PackSizeInput {
  unit: string | null;
  sizeMin: number | null;
  sizeMax: number | null;
  /** Listing source: `tjek`, `rema` or `salling_food_waste`. */
  source?: string | null;
  /** Source description (REMA 1000: `"400 GR. / REMA 1000"`). */
  description?: string | null;
  /** Food waste: `kg` when sold by weight. */
  stockUnit?: string | null;
  /** Open Food Facts quantity of the product (food waste only). */
  offNetQuantity?: number | null;
  offNetUnit?: string | null;
  offQuantityText?: string | null;
}

const REMA_SIZE = /^(\d+(?:[.,]\d+)?)\s*(GR|KG|ML|CL|LTR|L|STK)\.?(?=\s|\/|$)/i;

const REMA_UNITS: Readonly<Record<string, [number, string]>> = {
  GR: [0.001, "kg"],
  KG: [1, "kg"],
  ML: [0.001, "l"],
  CL: [0.01, "l"],
  LTR: [1, "l"],
  L: [1, "l"],
  STK: [1, "stk"],
};

/** The pack size stated in a REMA 1000 description (`"1 LTR. / ARLA"` -> `"1 l"`), or null. */
export function parseRemaSize(description: string | null | undefined): string | null {
  const head = description?.split(" / ")[0]?.trim();
  const match = head ? REMA_SIZE.exec(head) : null;
  if (!match?.[1] || !match[2]) return null;
  const conversion = REMA_UNITS[match[2].toUpperCase()];
  if (!conversion) return null;
  const value = Number(match[1].replace(",", ".")) * conversion[0];
  return formatQuantity(value, value, conversion[1]);
}

export const UNKNOWN_SIZE_TEXT = "Vægt ukendt";

/**
 * The pack size to show for an offer, shelf price or clearance, and where it comes from
 * (docs/ui.md §5.3). Never a guess: "Vægt ukendt" when nothing is known.
 */
export function packSize(input: PackSizeInput): PackSize {
  const stated = formatQuantity(input.sizeMin, input.sizeMax, input.unit);
  if (input.source === "rema") {
    const parsed = parseRemaSize(input.description);
    if (parsed) return { text: parsed, origin: "description" };
    if (stated) return { text: `ca. ${stated}`, origin: "computed" };
    return { text: UNKNOWN_SIZE_TEXT, origin: "unknown" };
  }
  if (stated) return { text: stated, origin: "source" };
  if (input.source === "salling_food_waste") {
    // A product sold by weight has no fixed pack size, whatever Open Food Facts says.
    if (input.stockUnit === "kg") return { text: "Vægt varierer", origin: "variable" };
    const off =
      formatQuantity(input.offNetQuantity, input.offNetQuantity, input.offNetUnit) ??
      (input.offQuantityText?.trim() || null);
    if (off) return { text: `${off} ifølge Open Food Facts`, origin: "off" };
  }
  return { text: UNKNOWN_SIZE_TEXT, origin: "unknown" };
}

/** The pack-size text of {@link packSize}. */
export function formatPackSize(input: PackSizeInput): string {
  return packSize(input).text;
}

/**
 * A product name in sentence case when the source shouts it (Salling: `"HK GRIS 3-7%
 * MESTERHAKKET"` -> `"Hk gris 3-7% mesterhakket"`). Names that already contain lower-case
 * letters are kept as they are.
 */
export function displayTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed !== trimmed.toLocaleUpperCase("da-DK")) return trimmed;
  const lower = trimmed.toLocaleLowerCase("da-DK");
  return lower.charAt(0).toLocaleUpperCase("da-DK") + lower.slice(1);
}

/** The Copenhagen wall-clock time: `"13.37"`. */
export function formatClock(value: Date | string): string {
  const p = copenhagenParts(value);
  return `${pad2(p.hour)}.${pad2(p.minute)}`;
}

const dayKey = (p: CopenhagenParts): number => Date.UTC(p.year, p.month - 1, p.day);

/** Calendar days from `now` to `value` in Copenhagen (0 = today, 1 = tomorrow, -1 = yesterday). */
export function daysFromToday(value: Date | string, now: Date): number {
  return Math.round((dayKey(copenhagenParts(value)) - dayKey(copenhagenParts(now))) / 86_400_000);
}

/**
 * When a clearance ends: `"til i dag"`, `"til i morgen"` or `"til tors. 20. nov."`, with the time
 * only when it is not the end of the day (`"til i dag kl. 18.00"`).
 */
export function formatEnd(value: Date | string, now: Date): string {
  const end = displayEnd(value);
  const p = copenhagenParts(end);
  const days = daysFromToday(end, now);
  const day = days === 0 ? "i dag" : days === 1 ? "i morgen" : formatDayDate(end);
  const endOfDay = p.hour === 23 && p.minute === 59;
  return endOfDay ? `til ${day}` : `til ${day} kl.${NBSP}${formatClock(end)}`;
}

/** Stock left: `"1 stk. tilbage"`, `"1,96 kg tilbage"`. */
export function formatStock(stock: number | null, stockUnit: string | null): string | null {
  if (stock == null || !Number.isFinite(stock)) return null;
  const unit = stockUnit === "kg" ? "kg" : "stk.";
  return `${formatCompact(stock, 2)}${NBSP}${unit} tilbage`;
}

/**
 * A compact validity period for cards: `"lør. 14.–fre. 20. nov."` within one month,
 * `"fre. 28. nov.–tors. 4. dec."` across months. The end is shown as its last day.
 */
export function formatShortPeriod(
  from: Date | string | null | undefined,
  to: Date | string | null | undefined,
): string {
  if (from && to) {
    const end = displayEnd(to);
    const a = copenhagenParts(from);
    const b = copenhagenParts(end);
    if (a.year === b.year && a.month === b.month) {
      if (a.day === b.day) return formatDayDate(from);
      return `${WEEKDAYS[a.weekday]} ${a.day}.–${formatDayDate(end)}`;
    }
    return `${formatDayDate(from)}–${formatDayDate(end)}`;
  }
  return formatPeriod(from, to);
}

const MONTH_NAMES = [
  "januar",
  "februar",
  "marts",
  "april",
  "maj",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "december",
] as const;

/** A month heading: `"november 2026"`. */
export function formatMonth(value: Date | string): string {
  const p = copenhagenParts(value);
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}
