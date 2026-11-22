/**
 * Calendar periods in the rider's local time: day keys (`2026-11-23`), ISO-8601 week keys
 * (`2026-W48`, weeks start on Monday, week 1 contains the year's first Thursday) and month keys
 * (`2026-11`).
 *
 * There is no time-zone database here: the caller passes the UTC offset in minutes that applies
 * at the instant in question (`-new Date(ms).getTimezoneOffset()` in a browser; +60 for CET,
 * +120 for CEST). Keys are therefore stable across DST changes as long as every instant is
 * paired with the offset that was in force at that instant.
 *
 * All keys are zero-padded, so lexicographic order equals chronological order.
 */

export type DayKey = string;
export type WeekKey = string;
export type MonthKey = string;
export type PeriodKey = WeekKey | MonthKey;
export type PeriodKind = 'week' | 'month';

/** An instant plus the rider's UTC offset in force at that instant. */
export interface Now {
  /** Unix epoch milliseconds. */
  ms: number;
  /** Minutes east of UTC (CET = 60, CEST = 120, New York EST = -300). */
  utcOffsetMin: number;
}

const DAY_MS = 86_400_000;
const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

/** Offsets in use world-wide lie within ±14 h. Non-finite input becomes 0. */
export function normalizeOffset(offsetMin: number): number {
  if (!Number.isFinite(offsetMin)) return 0;
  return Math.max(-840, Math.min(840, Math.round(offsetMin)));
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const pad4 = (n: number) => String(n).padStart(4, '0');

/** UTC midnight (ms) of the local calendar date that `ms` falls on. */
function localDayStart(ms: number, offsetMin: number): number {
  const local = ms + normalizeOffset(offsetMin) * 60_000;
  return Math.floor(local / DAY_MS) * DAY_MS;
}

function dayKeyOfUtcDate(d: number): DayKey {
  const date = new Date(d);
  return `${pad4(date.getUTCFullYear())}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** ISO week of a date given as UTC midnight ms. */
function isoWeekOfUtcDate(d: number): { year: number; week: number } {
  const dow = (new Date(d).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = d + (3 - dow) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const dayOfYear = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS);
  return { year, week: Math.floor(dayOfYear / 7) + 1 };
}

function weekKeyOf(year: number, week: number): WeekKey {
  return `${pad4(year)}-W${pad2(week)}`;
}

/** Local calendar day, e.g. `2026-11-23`. */
export function dayKey(ms: number, offsetMin: number): DayKey {
  return dayKeyOfUtcDate(localDayStart(ms, offsetMin));
}

/** ISO week in local time, e.g. `2026-W48`. */
export function weekKey(ms: number, offsetMin: number): WeekKey {
  const { year, week } = isoWeekOfUtcDate(localDayStart(ms, offsetMin));
  return weekKeyOf(year, week);
}

/** Calendar month in local time, e.g. `2026-11`. */
export function monthKey(ms: number, offsetMin: number): MonthKey {
  return dayKey(ms, offsetMin).slice(0, 7);
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

function parseDay(key: unknown): number | null {
  if (typeof key !== 'string') return null;
  const m = DAY_RE.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < MIN_YEAR || y > MAX_YEAR || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  return dayKeyOfUtcDate(t) === key ? t : null;
}

/** Number of ISO weeks (52 or 53) in an ISO year. */
export function isoWeeksInYear(year: number): number {
  return isoWeekOfUtcDate(Date.UTC(year, 11, 28)).week;
}

function parseWeek(key: unknown): { year: number; week: number } | null {
  if (typeof key !== 'string') return null;
  const m = WEEK_RE.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (year < MIN_YEAR || year > MAX_YEAR || week < 1 || week > isoWeeksInYear(year)) return null;
  return { year, week };
}

function parseMonth(key: unknown): { year: number; month: number } | null {
  if (typeof key !== 'string') return null;
  const m = MONTH_RE.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return null;
  return { year, month };
}

export const isDayKey = (key: unknown): boolean => parseDay(key) !== null;
export const isWeekKey = (key: unknown): boolean => parseWeek(key) !== null;
export const isMonthKey = (key: unknown): boolean => parseMonth(key) !== null;
export const isPeriodKey = (key: unknown): boolean => isWeekKey(key) || isMonthKey(key);

export function periodKind(key: PeriodKey): PeriodKind | null {
  return isWeekKey(key) ? 'week' : isMonthKey(key) ? 'month' : null;
}

/** UTC-midnight ms of the Monday of an ISO week (as a calendar date, not an instant). */
function mondayOf(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7;
  return jan4 - dow * DAY_MS + (week - 1) * 7 * DAY_MS;
}

/** The ISO week a local calendar day belongs to. */
export function weekKeyOfDay(day: DayKey): WeekKey | null {
  const t = parseDay(day);
  if (t === null) return null;
  const { year, week } = isoWeekOfUtcDate(t);
  return weekKeyOf(year, week);
}

export function monthKeyOfDay(day: DayKey): MonthKey | null {
  return parseDay(day) === null ? null : day.slice(0, 7);
}

/** The seven local days (Monday first) of an ISO week; [] for an invalid key. */
export function weekDays(key: WeekKey): DayKey[] {
  const w = parseWeek(key);
  if (!w) return [];
  const monday = mondayOf(w.year, w.week);
  return Array.from({ length: 7 }, (_, i) => dayKeyOfUtcDate(monday + i * DAY_MS));
}

/** Shifts a week key by `n` weeks (negative = earlier). Returns the input if it is invalid. */
export function addWeeks(key: WeekKey, n: number): WeekKey {
  const w = parseWeek(key);
  if (!w || !Number.isInteger(n)) return key;
  const { year, week } = isoWeekOfUtcDate(mondayOf(w.year, w.week) + n * 7 * DAY_MS);
  return weekKeyOf(year, week);
}

/** Shifts a month key by `n` months. Returns the input if it is invalid. */
export function addMonths(key: MonthKey, n: number): MonthKey {
  const m = parseMonth(key);
  if (!m || !Number.isInteger(n)) return key;
  const idx = m.year * 12 + (m.month - 1) + n;
  return `${pad4(Math.floor(idx / 12))}-${pad2((idx % 12) + 1)}`;
}

/** Whole weeks from `a` to `b` (positive when `b` is later). */
export function weeksBetween(a: WeekKey, b: WeekKey): number {
  const wa = parseWeek(a);
  const wb = parseWeek(b);
  if (!wa || !wb) return 0;
  return Math.round((mondayOf(wb.year, wb.week) - mondayOf(wa.year, wa.week)) / (7 * DAY_MS));
}

/**
 * Start (inclusive) and end (exclusive) instants of a period in the given local offset. The
 * same offset is applied to both ends, so a period spanning a DST change is off by the DST
 * shift (one hour) at one end — good enough for "time remaining" displays.
 */
export function periodBounds(
  key: PeriodKey,
  offsetMin: number,
): { startMs: number; endMs: number } | null {
  const off = normalizeOffset(offsetMin) * 60_000;
  const w = parseWeek(key);
  if (w) {
    const start = mondayOf(w.year, w.week);
    return { startMs: start - off, endMs: start + 7 * DAY_MS - off };
  }
  const m = parseMonth(key);
  if (m) {
    return {
      startMs: Date.UTC(m.year, m.month - 1, 1) - off,
      endMs: Date.UTC(m.year, m.month, 1) - off,
    };
  }
  return null;
}

/** The `n` most recent week keys, current week first. */
export function recentWeeks(now: Now, n: number): WeekKey[] {
  const current = weekKey(now.ms, now.utcOffsetMin);
  return Array.from({ length: Math.max(0, n) }, (_, i) => addWeeks(current, -i));
}

/** The `n` most recent month keys, current month first. */
export function recentMonths(now: Now, n: number): MonthKey[] {
  const current = monthKey(now.ms, now.utcOffsetMin);
  return Array.from({ length: Math.max(0, n) }, (_, i) => addMonths(current, -i));
}
