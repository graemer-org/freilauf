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
  /** Mechanical work in kJ (sum of power × sample interval). */
  workKj: number;
  /**
   * Estimated energy expenditure in kcal. Uses the common cycling approximation
   * kcal ≈ kJ of mechanical work: gross efficiency (~24 %) and the kJ→kcal
   * factor (1 / 4.184) roughly cancel out.
   */
  caloriesKcal: number;
  sampleCount: number;
}

/** Longest interval (s) a single sample may contribute to work — guards against gaps. */
const MAX_SAMPLE_DT_S = 5;

const fin = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

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
    workKj,
    caloriesKcal: workKj,
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
 * Splits samples into laps at every change of route segment (a jump along the route), in
 * order. A ride without jumps is one lap. Never returns an empty lap; [] for no samples.
 */
export function splitAtJumps(samples: readonly RideSample[]): RideSample[][] {
  const laps: RideSample[][] = [];
  let current: RideSample[] = [];
  let seg: number | null = null;
  for (const s of samples) {
    const k = segmentOf(s);
    if (seg !== null && k !== seg && current.length > 0) {
      laps.push(current);
      current = [];
    }
    seg = k;
    current.push(s);
  }
  if (current.length > 0) laps.push(current);
  return laps;
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
