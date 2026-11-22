import { describe, expect, it } from 'vitest';
import {
  addMonths,
  addWeeks,
  dayKey,
  isDayKey,
  isMonthKey,
  isWeekKey,
  isoWeeksInYear,
  monthKey,
  normalizeOffset,
  periodBounds,
  periodKind,
  recentMonths,
  recentWeeks,
  weekDays,
  weekKey,
  weekKeyOfDay,
  weeksBetween,
} from './periods';

const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

describe('week keys', () => {
  it('starts weeks on Monday in local time (around midnight)', () => {
    // Sunday 2026-11-22 23:30 CET = 22:30 UTC.
    expect(weekKey(utc(2026, 11, 22, 22, 30), 60)).toBe('2026-W47');
    expect(dayKey(utc(2026, 11, 22, 22, 30), 60)).toBe('2026-11-22');
    // Monday 2026-11-23 00:30 CET = Sunday 23:30 UTC — already the next week locally.
    expect(weekKey(utc(2026, 11, 22, 23, 30), 60)).toBe('2026-W48');
    expect(weekKey(utc(2026, 11, 22, 23, 30), 0)).toBe('2026-W47');
    expect(dayKey(utc(2026, 11, 22, 23, 30), 60)).toBe('2026-11-23');
  });

  it('handles negative offsets', () => {
    // Monday 2026-11-23 03:00 UTC is still Sunday evening in New York (UTC−5).
    expect(weekKey(utc(2026, 11, 23, 3), -300)).toBe('2026-W47');
    expect(dayKey(utc(2026, 11, 23, 3), -300)).toBe('2026-11-22');
    expect(weekKey(utc(2026, 11, 23, 6), -300)).toBe('2026-W48');
  });

  it('handles year boundaries and ISO week 53', () => {
    expect(isoWeeksInYear(2020)).toBe(53);
    expect(isoWeeksInYear(2025)).toBe(52);
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(weekKey(utc(2021, 1, 1, 12), 0)).toBe('2020-W53');
    expect(weekKey(utc(2021, 1, 3, 12), 0)).toBe('2020-W53');
    expect(weekKey(utc(2021, 1, 4, 12), 0)).toBe('2021-W01');
    expect(weekKey(utc(2024, 12, 30, 12), 0)).toBe('2025-W01');
    expect(weekKey(utc(2026, 12, 31, 12), 0)).toBe('2026-W53');
    expect(weekKey(utc(2027, 1, 3, 12), 0)).toBe('2026-W53');
    expect(weekKey(utc(2027, 1, 4, 12), 0)).toBe('2027-W01');
    // New Year's Eve 23:30 local in UTC+1 is 22:30 UTC on Dec 31.
    expect(monthKey(utc(2026, 12, 31, 22, 30), 60)).toBe('2026-12');
    expect(monthKey(utc(2026, 12, 31, 23, 30), 60)).toBe('2027-01');
    expect(weekKey(utc(2027, 1, 3, 23, 30), 60)).toBe('2027-W01');
  });

  it('follows DST via the offset supplied for each instant', () => {
    // 2026-03-29: Europe switches CET (+60) → CEST (+120). 22:30 UTC on Sunday the 29th is
    // 00:30 Monday in CEST — the next ISO week — but would be Sunday under the old offset.
    expect(weekKey(utc(2026, 3, 29, 22, 30), 120)).toBe('2026-W14');
    expect(weekKey(utc(2026, 3, 29, 22, 30), 60)).toBe('2026-W13');
    // Autumn: 2026-10-25 back to CET; 23:30 UTC Sunday is 00:30 Monday in CET.
    expect(weekKey(utc(2026, 10, 25, 23, 30), 60)).toBe('2026-W44');
    expect(weekKey(utc(2026, 10, 25, 21, 30), 120)).toBe('2026-W43');
  });

  it('validates keys', () => {
    expect(isWeekKey('2026-W53')).toBe(true);
    expect(isWeekKey('2025-W53')).toBe(false);
    expect(isWeekKey('2026-W00')).toBe(false);
    expect(isWeekKey('2026-w01')).toBe(false);
    expect(isWeekKey(42)).toBe(false);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-01')).toBe(true);
    expect(isDayKey('2026-02-29')).toBe(false);
    expect(isDayKey('2028-02-29')).toBe(true);
    expect(periodKind('2026-W01')).toBe('week');
    expect(periodKind('2026-01')).toBe('month');
    expect(periodKind('nonsense')).toBeNull();
  });

  it('does arithmetic on keys across years', () => {
    expect(addWeeks('2026-W52', 1)).toBe('2026-W53');
    expect(addWeeks('2026-W53', 1)).toBe('2027-W01');
    expect(addWeeks('2027-W01', -1)).toBe('2026-W53');
    expect(addWeeks('2025-W52', 1)).toBe('2026-W01');
    expect(addWeeks('2026-W10', -60)).toBe('2025-W02');
    expect(weeksBetween('2026-W52', '2027-W02')).toBe(3);
    expect(weeksBetween('2027-W02', '2026-W52')).toBe(-3);
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-06', -18)).toBe('2024-12');
    expect(addWeeks('bad', 1)).toBe('bad');
  });

  it('lists the days of a week and maps days to weeks', () => {
    expect(weekDays('2026-W53')).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
    expect(weekKeyOfDay('2027-01-03')).toBe('2026-W53');
    expect(weekKeyOfDay('2027-02-30')).toBeNull();
    expect(weekDays('nope')).toEqual([]);
  });

  it('computes period bounds in local time', () => {
    expect(periodBounds('2026-W48', 60)).toEqual({
      startMs: utc(2026, 11, 22, 23),
      endMs: utc(2026, 11, 29, 23),
    });
    expect(periodBounds('2026-11', -300)).toEqual({
      startMs: utc(2026, 11, 1, 5),
      endMs: utc(2026, 12, 1, 5),
    });
    expect(periodBounds('x', 0)).toBeNull();
  });

  it('lists recent periods newest first', () => {
    const now = { ms: utc(2027, 1, 6, 12), utcOffsetMin: 60 };
    expect(recentWeeks(now, 3)).toEqual(['2027-W01', '2026-W53', '2026-W52']);
    expect(recentMonths(now, 2)).toEqual(['2027-01', '2026-12']);
  });

  it('normalises offsets', () => {
    expect(normalizeOffset(Number.NaN)).toBe(0);
    expect(normalizeOffset(10_000)).toBe(840);
    expect(normalizeOffset(59.6)).toBe(60);
  });
});
