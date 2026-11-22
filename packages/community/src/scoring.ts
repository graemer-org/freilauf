/**
 * Ride facts and points.
 *
 * `rideFacts()` turns one recorded ride (1 Hz samples) plus the rider's FTP at the time into a
 * small, immutable summary — the only thing the community features ever look at. Facts carry
 * the `scoringVersion` they were computed with and their `source`, so later versions of the
 * formula (or rides imported from other sources) can coexist with existing facts without
 * recomputing anybody's standings.
 *
 * Points (SCORING_VERSION 1) — a capped training-stress score:
 *
 *   IF      = NP / FTP                         (normalised power over the rider's own FTP)
 *   IFp     = min(IF, 1.3)                     (caps a bogus/too-low FTP)
 *   raw     = movingHours × IFp² × 100         (1 h at FTP = 100 points)
 *   points  = round(min(raw, 400))             (per ride)
 *   per day = min(Σ points of that day, 500)   (applied when totals are aggregated)
 */

import {
  type DayKey,
  type MonthKey,
  type WeekKey,
  dayKey,
  isDayKey,
  monthKey,
  normalizeOffset,
  weekKey,
} from './periods';
import { isIntIn, isRecord } from './util';

export const SCORING_VERSION = 1;

/** Where a contribution comes from. Only rides recorded by Freilauf count for now. */
export type RideSource = 'freilauf';
export const RIDE_SOURCES: readonly RideSource[] = ['freilauf'];

/** Intensity factor used for points is capped here (protects against a too-low FTP). */
export const POINTS_IF_CAP = 1.3;
/** Maximum points a single ride can score. */
export const POINTS_PER_RIDE_CAP = 400;
/** Maximum points that count per local calendar day (applied in totals). */
export const POINTS_PER_DAY_CAP = 500;

/** Longest gap (s) one sample may contribute to moving time, energy and distance. */
export const MAX_SAMPLE_DT_S = 5;
/** Samples with speed above this or power above 0 count as moving. */
const MOVING_SPEED_MPS = 0.3;
/** Plausibility limits for single samples. */
const MAX_POWER_W = 2500;
const MAX_SPEED_MPS = 30;
const MAX_GRADE_PERCENT = 40;
const FTP_MIN_W = 30;
const FTP_MAX_W = 1000;

/** Best average power (W, rounded) over a window, or null when the ride is shorter. */
export interface BestEfforts {
  p5s: number | null;
  p1m: number | null;
  p5m: number | null;
  p20m: number | null;
}

export const BEST_EFFORT_WINDOWS: Readonly<Record<keyof BestEfforts, number>> = {
  p5s: 5,
  p1m: 60,
  p5m: 300,
  p20m: 1200,
};

export const BEST_EFFORT_KEYS = ['p5s', 'p1m', 'p5m', 'p20m'] as const;

export function emptyBestEfforts(): BestEfforts {
  return { p5s: null, p1m: null, p5m: null, p20m: null };
}

/** The sample fields the facts need (a structural subset of `@freilauf/session`'s RideSample). */
export interface RideFactsSample {
  /** Unix epoch ms. */
  timestamp: number;
  /** Seconds of recorded time since the ride started (pauses excluded). */
  elapsedS: number;
  powerW: number;
  speedMps: number;
  /** Cumulative distance (m). */
  distanceM: number;
  gradePercent: number;
  heartRateBpm?: number | null;
}

export interface RideFactsInput {
  /** The app's ride id (1–64 characters). */
  rideId: string;
  /** Unix epoch ms of the start; defaults to the first sample's timestamp. */
  startedAt?: number;
  /** 1 Hz samples in recording order. */
  samples: readonly RideFactsSample[];
  /** The rider's FTP (W) at the time of the ride. Without a plausible FTP the ride scores 0. */
  ftpW: number;
  /** The local UTC offset (minutes) at the start of the ride; decides day/week/month. */
  utcOffsetMin: number;
  /** True if the ride was ridden in a group session with at least one other rider. */
  groupRide?: boolean;
}

/** Immutable summary of one ride. All quantities are rounded integers unless noted. */
export interface RideFacts {
  readonly rideId: string;
  readonly source: RideSource;
  readonly scoringVersion: number;
  readonly startedAt: number;
  readonly utcOffsetMin: number;
  readonly dayKey: DayKey;
  readonly weekKey: WeekKey;
  readonly monthKey: MonthKey;
  readonly movingS: number;
  readonly distanceM: number;
  readonly elevationGainM: number;
  readonly energyKj: number;
  readonly avgPowerW: number;
  readonly normalizedPowerW: number;
  /** NP / FTP, three decimals; null without a plausible FTP. Not capped. */
  readonly intensityFactor: number | null;
  readonly ftpW: number | null;
  readonly points: number;
  /** Shown, never ranked (m/s, two decimals). */
  readonly avgSpeedMps: number;
  readonly best: Readonly<BestEfforts>;
  readonly groupRide: boolean;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round = (v: number, decimals = 0) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

/** Normalised power: 4th root of the mean of the 4th powers of 30 s rolling averages. */
export function normalizedPower(power: readonly number[]): number {
  const n = power.length;
  if (n === 0) return 0;
  if (n < 30) return power.reduce((a, b) => a + b, 0) / n;
  let windowSum = 0;
  let acc = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    windowSum += power[i] ?? 0;
    if (i >= 30) windowSum -= power[i - 30] ?? 0;
    if (i >= 29) {
      const avg = windowSum / 30;
      acc += avg ** 4;
      count++;
    }
  }
  return (acc / count) ** 0.25;
}

/** Highest mean over any `window` consecutive samples, or null if there are fewer. */
export function bestAverage(power: readonly number[], window: number): number | null {
  if (window <= 0 || power.length < window) return null;
  let sum = 0;
  let best = 0;
  for (let i = 0; i < power.length; i++) {
    sum += power[i] ?? 0;
    if (i >= window) sum -= power[i - window] ?? 0;
    if (i >= window - 1 && sum > best) best = sum;
  }
  return best / window;
}

/** Points for a ride with the given moving time and intensity factor (before rounding). */
export function pointsFor(movingS: number, intensityFactor: number | null): number {
  if (intensityFactor === null || !fin(intensityFactor) || !fin(movingS) || movingS <= 0) return 0;
  const ifp = Math.min(Math.max(intensityFactor, 0), POINTS_IF_CAP);
  return Math.round(Math.min((movingS / 3600) * ifp * ifp * 100, POINTS_PER_RIDE_CAP));
}

/**
 * Computes the facts of one ride. Returns null when the ride cannot be placed in time (no
 * finite start) or the id is unusable. Bad samples are skipped, never fatal.
 *
 * Method:
 * - For each sample after the first, `dt = elapsedS − previous elapsedS`, ignored when ≤ 0 or
 *   not finite and capped at 5 s (gaps from pauses or dropped samples do not count).
 * - Moving time: Σ dt of samples that are moving (speed > 0.3 m/s or power > 0).
 * - Energy: Σ power × dt (power clamped to 0–2500 W), in kJ.
 * - Distance: Σ positive increments of the cumulative distance, ignoring jumps faster than
 *   30 m/s × dt (e.g. a reset or a glitch).
 * - Elevation gain: Σ Δdistance × max(0, grade) / 100 over the same increments, grade clamped to
 *   ±40 % — climbing is the gradient applied to the distance covered. Δdistance is treated as
 *   horizontal; at 10 % the error versus the slope length is 0.5 %, well below other noise.
 * - Normalised power over the per-sample (1 Hz) power series; best efforts as the highest mean
 *   over 5 / 60 / 300 / 1200 consecutive samples.
 */
export function rideFacts(input: RideFactsInput): RideFacts | null {
  const rideId = typeof input.rideId === 'string' ? input.rideId : '';
  if (rideId.length < 1 || rideId.length > 64) return null;
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const firstTs = samples.find((s) => fin(s?.timestamp))?.timestamp;
  const startedAt = fin(input.startedAt) ? input.startedAt : firstTs;
  if (!fin(startedAt)) return null;
  const offset = normalizeOffset(input.utcOffsetMin);

  const power: number[] = [];
  let movingS = 0;
  let energyJ = 0;
  let distanceM = 0;
  let climbM = 0;
  let prevElapsed: number | null = null;
  let prevDistance: number | null = null;

  for (const s of samples) {
    if (!isRecord(s)) continue;
    const p = fin(s.powerW) ? Math.min(Math.max(s.powerW, 0), MAX_POWER_W) : 0;
    power.push(p);
    const elapsed = fin(s.elapsedS) ? s.elapsedS : null;
    const dist = fin(s.distanceM) ? s.distanceM : null;
    const dtRaw = elapsed !== null && prevElapsed !== null ? elapsed - prevElapsed : 0;
    const dt = dtRaw > 0 ? Math.min(dtRaw, MAX_SAMPLE_DT_S) : 0;
    if (dt > 0) {
      const speed = fin(s.speedMps) ? s.speedMps : 0;
      if (speed > MOVING_SPEED_MPS || p > 0) movingS += dt;
      energyJ += p * dt;
      if (dist !== null && prevDistance !== null) {
        const dd = dist - prevDistance;
        if (dd > 0 && dd <= MAX_SPEED_MPS * dt) {
          distanceM += dd;
          const g = fin(s.gradePercent)
            ? Math.min(Math.max(s.gradePercent, -MAX_GRADE_PERCENT), MAX_GRADE_PERCENT)
            : 0;
          if (g > 0) climbM += (dd * g) / 100;
        }
      }
    }
    if (elapsed !== null) prevElapsed = elapsed;
    if (dist !== null) prevDistance = dist;
  }

  const np = normalizedPower(power);
  const avgPower = power.length ? power.reduce((a, b) => a + b, 0) / power.length : 0;
  const ftp =
    fin(input.ftpW) && input.ftpW >= FTP_MIN_W && input.ftpW <= FTP_MAX_W ? input.ftpW : null;
  const intensity = ftp !== null ? np / ftp : null;
  const best = emptyBestEfforts();
  for (const k of BEST_EFFORT_KEYS) {
    const v = bestAverage(power, BEST_EFFORT_WINDOWS[k]);
    best[k] = v === null ? null : Math.round(v);
  }
  const moving = Math.round(movingS);
  const distance = Math.round(distanceM);

  return Object.freeze({
    rideId,
    source: 'freilauf' as const,
    scoringVersion: SCORING_VERSION,
    startedAt,
    utcOffsetMin: offset,
    dayKey: dayKey(startedAt, offset),
    weekKey: weekKey(startedAt, offset),
    monthKey: monthKey(startedAt, offset),
    movingS: moving,
    distanceM: distance,
    elevationGainM: Math.round(climbM),
    energyKj: Math.round(energyJ / 1000),
    avgPowerW: Math.round(avgPower),
    normalizedPowerW: Math.round(np),
    intensityFactor: intensity === null ? null : round(intensity, 3),
    ftpW: ftp === null ? null : Math.round(ftp),
    points: pointsFor(movingS, intensity),
    avgSpeedMps: moving > 0 ? round(distanceM / movingS, 2) : 0,
    best: Object.freeze(best),
    groupRide: input.groupRide === true,
  });
}

/** Limits for stored facts (local data can be corrupted too). */
const FACT_LIMITS = {
  movingS: 86_400,
  distanceM: 2_000_000,
  elevationGainM: 50_000,
  energyKj: 100_000,
  power: MAX_POWER_W,
};

/**
 * Validates facts read back from storage. Returns a frozen copy or null. Facts with a newer
 * `scoringVersion` or another known source are accepted as they are (never recomputed).
 */
export function validateRideFacts(v: unknown): RideFacts | null {
  if (!isRecord(v)) return null;
  const { rideId, source, scoringVersion, startedAt, utcOffsetMin } = v;
  if (typeof rideId !== 'string' || rideId.length < 1 || rideId.length > 64) return null;
  if (typeof source !== 'string' || !(RIDE_SOURCES as readonly string[]).includes(source))
    return null;
  if (!isIntIn(scoringVersion, 1, 1000)) return null;
  if (!fin(startedAt) || startedAt < 0 || startedAt > 1e14) return null;
  if (!isIntIn(utcOffsetMin, -840, 840)) return null;
  const dk = dayKey(startedAt, utcOffsetMin);
  if (v.dayKey !== dk || !isDayKey(dk)) return null;
  if (v.weekKey !== weekKey(startedAt, utcOffsetMin)) return null;
  if (v.monthKey !== monthKey(startedAt, utcOffsetMin)) return null;
  if (!isIntIn(v.movingS, 0, FACT_LIMITS.movingS)) return null;
  if (!isIntIn(v.distanceM, 0, FACT_LIMITS.distanceM)) return null;
  if (!isIntIn(v.elevationGainM, 0, FACT_LIMITS.elevationGainM)) return null;
  if (!isIntIn(v.energyKj, 0, FACT_LIMITS.energyKj)) return null;
  if (!isIntIn(v.avgPowerW, 0, FACT_LIMITS.power)) return null;
  if (!isIntIn(v.normalizedPowerW, 0, FACT_LIMITS.power)) return null;
  if (!isIntIn(v.points, 0, POINTS_PER_RIDE_CAP)) return null;
  const ifac = v.intensityFactor;
  if (ifac !== null && !(fin(ifac) && ifac >= 0 && ifac <= 100)) return null;
  const ftp = v.ftpW;
  if (ftp !== null && !isIntIn(ftp, FTP_MIN_W, FTP_MAX_W)) return null;
  if (!fin(v.avgSpeedMps) || v.avgSpeedMps < 0 || v.avgSpeedMps > MAX_SPEED_MPS) return null;
  if (typeof v.groupRide !== 'boolean') return null;
  if (!isRecord(v.best)) return null;
  const best = emptyBestEfforts();
  for (const k of BEST_EFFORT_KEYS) {
    const b = v.best[k];
    if (b !== null && !isIntIn(b, 0, FACT_LIMITS.power)) return null;
    best[k] = b;
  }
  return Object.freeze({
    rideId,
    source: source as RideSource,
    scoringVersion,
    startedAt,
    utcOffsetMin,
    dayKey: dk,
    weekKey: weekKey(startedAt, utcOffsetMin),
    monthKey: monthKey(startedAt, utcOffsetMin),
    movingS: v.movingS,
    distanceM: v.distanceM,
    elevationGainM: v.elevationGainM,
    energyKj: v.energyKj,
    avgPowerW: v.avgPowerW,
    normalizedPowerW: v.normalizedPowerW,
    intensityFactor: ifac,
    ftpW: ftp,
    points: v.points,
    avgSpeedMps: v.avgSpeedMps,
    best: Object.freeze(best),
    groupRide: v.groupRide,
  });
}
