/**
 * Weekly and monthly totals from ride facts, either computed from scratch (`aggregate`) or
 * maintained incrementally in a `Ledger` (`ledgerAdd` / `ledgerRemove`). All fact quantities
 * are integers, so incremental and full computation agree exactly.
 */

import { type DayKey, type PeriodKey, isMonthKey, isWeekKey } from './periods';
import {
  BEST_EFFORT_KEYS,
  type BestEfforts,
  POINTS_PER_DAY_CAP,
  type RideFacts,
  emptyBestEfforts,
} from './scoring';

/** The comparable totals of one period. */
export interface Totals {
  rides: number;
  movingS: number;
  distanceM: number;
  elevationGainM: number;
  energyKj: number;
  /** Σ over days of min(day's ride points, POINTS_PER_DAY_CAP). */
  points: number;
  /** Rides flagged as group rides. */
  groupRides: number;
  /** Distinct local days with at least one ride. */
  rideDays: number;
}

export interface PeriodTotals extends Totals {
  key: PeriodKey;
  /** Best efforts within the period (max over its rides). */
  best: BestEfforts;
}

/** Metrics that can be ranked (average speed deliberately is not one of them). */
export type TotalsMetric = keyof Totals;
export const TOTALS_METRICS: readonly TotalsMetric[] = [
  'points',
  'distanceM',
  'movingS',
  'elevationGainM',
  'energyKj',
  'rides',
  'groupRides',
  'rideDays',
];

export function emptyTotals(): Totals {
  return {
    rides: 0,
    movingS: 0,
    distanceM: 0,
    elevationGainM: 0,
    energyKj: 0,
    points: 0,
    groupRides: 0,
    rideDays: 0,
  };
}

/** Average speed of a period for display (m/s); never used for ranking. */
export function averageSpeedMps(t: Totals): number {
  return t.movingS > 0 ? t.distanceM / t.movingS : 0;
}

export function factsInPeriod(f: RideFacts, period: PeriodKey): boolean {
  return f.weekKey === period || f.monthKey === period;
}

function maxBest(a: BestEfforts, b: Readonly<BestEfforts>): BestEfforts {
  const out = { ...a };
  for (const k of BEST_EFFORT_KEYS) {
    const v = b[k];
    const cur = out[k];
    if (v !== null && (cur === null || v > cur)) out[k] = v;
  }
  return out;
}

/** Totals of one period (week or month key) computed from scratch. */
export function aggregate(facts: readonly RideFacts[], period: PeriodKey): PeriodTotals {
  const t = emptyTotals();
  const dayPoints = new Map<DayKey, number>();
  let best = emptyBestEfforts();
  for (const f of facts) {
    if (!factsInPeriod(f, period)) continue;
    t.rides++;
    t.movingS += f.movingS;
    t.distanceM += f.distanceM;
    t.elevationGainM += f.elevationGainM;
    t.energyKj += f.energyKj;
    if (f.groupRide) t.groupRides++;
    dayPoints.set(f.dayKey, (dayPoints.get(f.dayKey) ?? 0) + f.points);
    best = maxBest(best, f.best);
  }
  t.rideDays = dayPoints.size;
  for (const p of dayPoints.values()) t.points += Math.min(p, POINTS_PER_DAY_CAP);
  return { key: period, ...t, best };
}

/** Best efforts within a period (typically a month). */
export function bestEfforts(facts: readonly RideFacts[], period: PeriodKey): BestEfforts {
  return aggregate(facts, period).best;
}

/** Running sums for one period; `days` keeps per-day ride counts and raw points for the cap. */
export interface PeriodAccumulator {
  rides: number;
  movingS: number;
  distanceM: number;
  elevationGainM: number;
  energyKj: number;
  groupRides: number;
  days: Record<DayKey, { rides: number; points: number }>;
  best: BestEfforts;
}

/** The rider's own rides and their per-period accumulators. Plain JSON. */
export interface Ledger {
  rides: Record<string, RideFacts>;
  periods: Record<PeriodKey, PeriodAccumulator>;
}

export function emptyLedger(): Ledger {
  return { rides: {}, periods: {} };
}

function emptyAccumulator(): PeriodAccumulator {
  return {
    rides: 0,
    movingS: 0,
    distanceM: 0,
    elevationGainM: 0,
    energyKj: 0,
    groupRides: 0,
    days: {},
    best: emptyBestEfforts(),
  };
}

function applyToAccumulator(
  acc: PeriodAccumulator | undefined,
  f: RideFacts,
  sign: 1 | -1,
): PeriodAccumulator {
  const a = acc ?? emptyAccumulator();
  const day = a.days[f.dayKey] ?? { rides: 0, points: 0 };
  const nextDay = { rides: day.rides + sign, points: day.points + sign * f.points };
  const days = { ...a.days };
  if (nextDay.rides <= 0) delete days[f.dayKey];
  else days[f.dayKey] = nextDay;
  return {
    rides: a.rides + sign,
    movingS: a.movingS + sign * f.movingS,
    distanceM: a.distanceM + sign * f.distanceM,
    elevationGainM: a.elevationGainM + sign * f.elevationGainM,
    energyKj: a.energyKj + sign * f.energyKj,
    groupRides: a.groupRides + (f.groupRide ? sign : 0),
    days,
    best: sign === 1 ? maxBest(a.best, f.best) : a.best,
  };
}

/** Adds (or replaces, by `rideId`) one ride. Returns a new ledger; the input is not modified. */
export function ledgerAdd(ledger: Ledger, facts: RideFacts): Ledger {
  const base = ledger.rides[facts.rideId] ? ledgerRemove(ledger, facts.rideId) : ledger;
  const periods = { ...base.periods };
  for (const key of [facts.weekKey, facts.monthKey]) {
    periods[key] = applyToAccumulator(periods[key], facts, 1);
  }
  return { rides: { ...base.rides, [facts.rideId]: facts }, periods };
}

/** Removes one ride (no-op for an unknown id). Max-based best efforts are recomputed. */
export function ledgerRemove(ledger: Ledger, rideId: string): Ledger {
  const facts = ledger.rides[rideId];
  if (!facts) return ledger;
  const rides = { ...ledger.rides };
  delete rides[rideId];
  const periods = { ...ledger.periods };
  for (const key of [facts.weekKey, facts.monthKey]) {
    const next = applyToAccumulator(periods[key], facts, -1);
    if (next.rides <= 0) {
      delete periods[key];
      continue;
    }
    let best = emptyBestEfforts();
    for (const f of Object.values(rides)) if (factsInPeriod(f, key)) best = maxBest(best, f.best);
    periods[key] = { ...next, best };
  }
  return { rides, periods };
}

export function ledgerFromFacts(facts: readonly RideFacts[]): Ledger {
  let l = emptyLedger();
  for (const f of facts) l = ledgerAdd(l, f);
  return l;
}

/** Totals of a period from the ledger (zeros for a period without rides). */
export function ledgerTotals(ledger: Ledger, key: PeriodKey): PeriodTotals {
  const a = ledger.periods[key];
  if (!a) return { key, ...emptyTotals(), best: emptyBestEfforts() };
  let points = 0;
  let rideDays = 0;
  for (const d of Object.values(a.days)) {
    points += Math.min(d.points, POINTS_PER_DAY_CAP);
    rideDays++;
  }
  return {
    key,
    rides: a.rides,
    movingS: a.movingS,
    distanceM: a.distanceM,
    elevationGainM: a.elevationGainM,
    energyKj: a.energyKj,
    points,
    groupRides: a.groupRides,
    rideDays,
    best: { ...a.best },
  };
}

/** True for keys a ledger may hold (week or month). */
export function isLedgerKey(key: string): boolean {
  return isWeekKey(key) || isMonthKey(key);
}
