import { energyOfSamples, kcalFromWorkKj } from '../energy';
import type { RecordedRide, RideSample } from '../types';

/** Aggregates of a recorded ride, used for the FIT lap/session and the ride list. */
export interface RideSummary {
  /** Unix epoch ms of the start (earliest of `startedAt` and the first sample). */
  startTime: number;
  /** Unix epoch ms of the last sample (equals `startTime` for an empty ride). */
  endTime: number;
  /** Wall-clock duration in seconds, pauses included. */
  elapsedS: number;
  /** Recorded (moving/timer) duration in seconds, pauses excluded. */
  durationS: number;
  distanceM: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  /** Mean power over all samples (zeros included). */
  avgPowerW: number;
  maxPowerW: number;
  /** Mean cadence over samples with cadence > 0 (Garmin's default "exclude zeros"). */
  avgCadenceRpm: number;
  maxCadenceRpm: number;
  /** `null` when no sample carries heart rate. */
  avgHeartRateBpm: number | null;
  maxHeartRateBpm: number | null;
  /**
   * Normalized power (W): the 4th root of the mean of the 4th powers of the 30 s rolling
   * average of the 1 Hz power samples. `null` with fewer than 30 samples.
   */
  normalizedPowerW: number | null;
  /** Mechanical work in kJ (sum of power × sample interval). */
  workKj: number;
  /**
   * Estimated energy expenditure in kcal from the mechanical work: kJ / (4.184 × 0.24), i.e.
   * a gross efficiency of 24 % (energy.ts, docs/energy.md). 0 without power.
   */
  caloriesKcal: number;
  /**
   * Of caloriesKcal, the kcal estimated to come from fat (energy.ts); null when the ride does
   * not carry the rider's FTP (`RecordedRide.ftpW`) or has no power.
   */
  fatCaloriesKcal: number | null;
  sampleCount: number;
}

/** Longest interval (s) a single sample may contribute to work — guards against gaps. */
const MAX_SAMPLE_DT_S = 5;

const fin = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Rolling window (samples, i.e. seconds at 1 Hz) of normalized power. */
const NP_WINDOW = 30;

/**
 * Normalized power of 1 Hz samples (the usual definition: 30 s rolling mean, raised to the
 * 4th power, averaged, 4th root). Samples are recorded only while riding, so pauses are not
 * counted; non-finite or negative power counts as 0. `null` with fewer than 30 samples.
 */
export function normalizedPower(samples: readonly RideSample[]): number | null {
  if (samples.length < NP_WINDOW) return null;
  const p = samples.map((s) => (fin(s.powerW) ? Math.max(0, s.powerW) : 0));
  let windowSum = 0;
  let sum4 = 0;
  let n = 0;
  for (let i = 0; i < p.length; i++) {
    windowSum += p[i]!;
    if (i >= NP_WINDOW) windowSum -= p[i - NP_WINDOW]!;
    if (i >= NP_WINDOW - 1) {
      sum4 += (windowSum / NP_WINDOW) ** 4;
      n++;
    }
  }
  return (sum4 / n) ** 0.25;
}

/** Samples usable for encoding: those with a finite timestamp. */
export function usableSamples(ride: RecordedRide): RideSample[] {
  return ride.samples.filter((s) => fin(s.timestamp));
}

export function rideSummary(ride: RecordedRide): RideSummary {
  const samples = usableSamples(ride);
  const first = samples[0];
  const last = samples[samples.length - 1];

  const candidates = [ride.startedAt, first?.timestamp].filter(fin);
  const startTime = candidates.length > 0 ? Math.min(...candidates) : 0;
  const endTime = last ? Math.max(last.timestamp, startTime) : startTime;

  let durationS = 0;
  let distanceM = 0;
  let maxSpeed = 0;
  let powerSum = 0;
  let powerN = 0;
  let maxPower = 0;
  let cadSum = 0;
  let cadN = 0;
  let maxCad = 0;
  let hrSum = 0;
  let hrN = 0;
  let maxHr = 0;
  let workJ = 0;
  let prevElapsed = 0;

  for (const s of samples) {
    if (fin(s.elapsedS)) {
      durationS = Math.max(durationS, s.elapsedS);
    }
    if (fin(s.distanceM)) distanceM = Math.max(distanceM, s.distanceM);
    if (fin(s.speedMps) && s.speedMps > maxSpeed) maxSpeed = s.speedMps;
    if (fin(s.powerW)) {
      const p = Math.max(0, s.powerW);
      powerSum += p;
      powerN++;
      if (p > maxPower) maxPower = p;
      let dt = 1;
      if (fin(s.elapsedS)) {
        dt = Math.min(MAX_SAMPLE_DT_S, Math.max(0, s.elapsedS - prevElapsed));
      }
      workJ += p * dt;
    }
    if (fin(s.elapsedS)) prevElapsed = s.elapsedS;
    if (fin(s.cadenceRpm) && s.cadenceRpm > 0) {
      cadSum += s.cadenceRpm;
      cadN++;
      if (s.cadenceRpm > maxCad) maxCad = s.cadenceRpm;
    }
    if (fin(s.heartRateBpm) && s.heartRateBpm > 0) {
      hrSum += s.heartRateBpm;
      hrN++;
      if (s.heartRateBpm > maxHr) maxHr = s.heartRateBpm;
    }
  }

  // Fall back to the sample count (1 Hz) if elapsedS was unusable.
  if (durationS === 0 && samples.length > 1) durationS = samples.length;

  const workKj = workJ / 1000;
  return {
    startTime,
    endTime,
    elapsedS: (endTime - startTime) / 1000,
    durationS,
    distanceM,
    avgSpeedMps: durationS > 0 ? distanceM / durationS : 0,
    maxSpeedMps: maxSpeed,
    avgPowerW: powerN > 0 ? powerSum / powerN : 0,
    maxPowerW: maxPower,
    avgCadenceRpm: cadN > 0 ? cadSum / cadN : 0,
    maxCadenceRpm: maxCad,
    avgHeartRateBpm: hrN > 0 ? hrSum / hrN : null,
    maxHeartRateBpm: hrN > 0 ? maxHr : null,
    normalizedPowerW: normalizedPower(samples),
    workKj,
    caloriesKcal: kcalFromWorkKj(workKj),
    fatCaloriesKcal:
      typeof ride.ftpW === 'number' && Number.isFinite(ride.ftpW) && ride.ftpW > 0
        ? energyOfSamples(samples, { massKg: ride.riderMassKg, ftpW: ride.ftpW }).fatKcal
        : null,
    sampleCount: samples.length,
  };
}

/** Position and altitude aggregates of a ride that followed a route. */
export interface RouteSummary {
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  /** Climbing / descending (m), with a 1 m dead band against ripples. */
  ascentM: number;
  descentM: number;
  avgAltitudeM: number | null;
  minAltitudeM: number | null;
  maxAltitudeM: number | null;
}

/** Null when no sample carries a position. */
export function routeSummary(samples: readonly RideSample[]): RouteSummary | null {
  const pos = samples.filter((s) => fin(s.lat) && fin(s.lon));
  const first = pos[0];
  const last = pos[pos.length - 1];
  if (!first || !last) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const s of pos) {
    minLat = Math.min(minLat, s.lat!);
    maxLat = Math.max(maxLat, s.lat!);
    minLon = Math.min(minLon, s.lon!);
    maxLon = Math.max(maxLon, s.lon!);
  }
  const alts = samples.map((s) => s.altitudeM).filter(fin);
  let ascentM = 0;
  let descentM = 0;
  let ref = alts[0] ?? 0;
  for (const a of alts) {
    if (a - ref >= 1) {
      ascentM += a - ref;
      ref = a;
    } else if (ref - a >= 1) {
      descentM += ref - a;
      ref = a;
    }
  }
  return {
    startLat: first.lat!,
    startLon: first.lon!,
    endLat: last.lat!,
    endLon: last.lon!,
    minLat,
    maxLat,
    minLon,
    maxLon,
    ascentM,
    descentM,
    avgAltitudeM: alts.length > 0 ? alts.reduce((x, y) => x + y, 0) / alts.length : null,
    minAltitudeM: alts.length > 0 ? alts.reduce((x, y) => Math.min(x, y)) : null,
    maxAltitudeM: alts.length > 0 ? alts.reduce((x, y) => Math.max(x, y)) : null,
  };
}

/** The route segment of a sample (see RideSample.segment): 0 unless a positive integer. */
export function segmentOf(s: RideSample): number {
  const v = s.segment;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}

/**
 * A route segment shorter than this — in ridden distance or in timer time — does not make a
 * lap of its own: typically the rider started, paused at once and moved the start point
 * (a jump) before riding, or jumped several times in a row without riding in between.
 */
export const MIN_LAP_DISTANCE_M = 1;
export const MIN_LAP_TIMER_S = 5;

/** One lap of a ride: its samples, and those of them whose positions describe the lap. */
export interface RideLap {
  samples: RideSample[];
  /**
   * The samples of the route segment that was ridden in this lap. When a too-short segment
   * was folded into the lap, its samples count for time, distance and work but not for
   * positions (they lie on the other side of a jump).
   */
  ridden: RideSample[];
}

/**
 * Splits samples into laps at every change of route segment (a jump along the route), in
 * order. Segments with almost no riding (under MIN_LAP_DISTANCE_M or MIN_LAP_TIMER_S) are
 * folded into the next lap (into the previous one at the end of the ride), so a ride never
 * has an empty lap. A ride without jumps is one lap. [] for no samples.
 */
export function splitIntoLaps(samples: readonly RideSample[]): RideLap[] {
  // Runs of consecutive samples on the same segment.
  const runs: RideSample[][] = [];
  let seg: number | null = null;
  for (const s of samples) {
    const k = segmentOf(s);
    if (seg === null || k !== seg) runs.push([]);
    seg = k;
    runs.at(-1)!.push(s);
  }
  if (runs.length <= 1) return runs.map((r) => ({ samples: r, ridden: r }));

  let prevEnd: RideSample | undefined;
  const isShort = (run: RideSample[]): boolean => {
    const last = run.at(-1)!;
    const d0 = prevEnd && fin(prevEnd.distanceM) ? prevEnd.distanceM : 0;
    const t0 = prevEnd && fin(prevEnd.elapsedS) ? prevEnd.elapsedS : 0;
    const distance = fin(last.distanceM) ? last.distanceM - d0 : 0;
    const timer = fin(last.elapsedS) ? last.elapsedS - t0 : run.length;
    prevEnd = last;
    return distance < MIN_LAP_DISTANCE_M || timer < MIN_LAP_TIMER_S;
  };

  const laps: RideLap[] = [];
  let pending: RideSample[] = [];
  for (const run of runs) {
    if (isShort(run)) {
      pending.push(...run);
      continue;
    }
    laps.push({ samples: [...pending, ...run], ridden: run });
    pending = [];
  }
  if (pending.length > 0) {
    const last = laps.at(-1);
    if (last) last.samples.push(...pending);
    else laps.push({ samples: pending, ridden: runs.at(-1)! }); // nothing ridden at all
  }
  return laps;
}

/** The samples of each lap (see splitIntoLaps). */
export function splitAtJumps(samples: readonly RideSample[]): RideSample[][] {
  return splitIntoLaps(samples).map((lap) => lap.samples);
}

/**
 * Totals of one lap that starts where the previous lap ended (`before` = its last sample):
 * time, distance and work are counted from there, so the laps add up to the ride.
 */
export function lapSummary(
  ride: RecordedRide,
  lap: readonly RideSample[],
  before: RideSample | undefined,
): RideSummary {
  if (!before) return rideSummary({ ...ride, samples: [...lap] });
  const e0 = fin(before.elapsedS) ? before.elapsedS : 0;
  const d0 = fin(before.distanceM) ? before.distanceM : 0;
  return rideSummary({
    ...ride,
    startedAt: before.timestamp,
    samples: lap.map((s) => ({
      ...s,
      elapsedS: fin(s.elapsedS) ? s.elapsedS - e0 : s.elapsedS,
      distanceM: fin(s.distanceM) ? Math.max(0, s.distanceM - d0) : s.distanceM,
    })),
  });
}

/**
 * The whole ride's position summary: start, end, bounding box and altitudes over all samples,
 * but ascent/descent as the sum over the laps (route segments) — never the elevation difference
 * across a jump.
 */
export function sessionRouteSummary(
  samples: readonly RideSample[],
  laps: readonly (RouteSummary | null)[],
): RouteSummary | null {
  const whole = routeSummary(samples);
  if (!whole || laps.length <= 1) return whole;
  return {
    ...whole,
    ascentM: laps.reduce((a, l) => a + (l?.ascentM ?? 0), 0),
    descentM: laps.reduce((a, l) => a + (l?.descentM ?? 0), 0),
  };
}
