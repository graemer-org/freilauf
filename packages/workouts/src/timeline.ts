import type { Workout } from './model';

/** Kind of a flat timeline segment. `intervals` steps expand into `intervalOn`/`intervalOff`. */
export type SegmentKind = 'steady' | 'ramp' | 'intervalOn' | 'intervalOff' | 'freeRide';

/** How the trainer is driven: `erg` = `setTargetPower`, `free` = simulation mode (gradient). */
export type TrainerMode = 'erg' | 'free';

export interface Segment {
  index: number;
  /** Index of the workout step this segment came from. */
  stepIndex: number;
  kind: SegmentKind;
  mode: TrainerMode;
  /** Absolute workout time, seconds. `startS` is inclusive, `endS` exclusive. */
  startS: number;
  endS: number;
  durationS: number;
  /** FTP fractions; `null` for free ride. Equal for everything but ramps. */
  powerStart: number | null;
  powerEnd: number | null;
  cadenceRpm?: number;
  /** Free ride only: fixed simulated gradient. */
  gradePercent?: number;
  /** Free ride only: expected effort (stats/preview). */
  expectedPower?: number;
  label: string;
  interval?: { number: number; of: number; phase: 'on' | 'off' };
}

export interface TimelineCue {
  index: number;
  /** Absolute workout time, seconds. */
  atS: number;
  message: string;
  segmentIndex: number;
}

export interface Timeline {
  workout: Workout;
  segments: readonly Segment[];
  cues: readonly TimelineCue[];
  totalDurationS: number;
}

/** How long a cue stays in `WorkoutTarget.cue` after it fired (or until the next cue). */
export const CUE_DISPLAY_S = 10;

/** Flattens a (validated) workout into absolute, contiguous segments. */
export function buildTimeline(workout: Workout): Timeline {
  const segments: Segment[] = [];
  const cues: { atS: number; message: string }[] = [];
  let t = 0;
  const last = workout.steps.length - 1;
  const push = (s: Omit<Segment, 'index' | 'startS' | 'endS'>) => {
    segments.push({ ...s, index: segments.length, startS: t, endS: t + s.durationS });
    t += s.durationS;
  };

  workout.steps.forEach((step, stepIndex) => {
    const stepStart = t;
    for (const cue of step.cues ?? [])
      cues.push({ atS: stepStart + cue.atS, message: cue.message });
    switch (step.kind) {
      case 'steady':
        push({
          stepIndex,
          kind: 'steady',
          mode: 'erg',
          durationS: step.durationS,
          powerStart: step.power,
          powerEnd: step.power,
          ...(step.cadenceRpm !== undefined ? { cadenceRpm: step.cadenceRpm } : {}),
          label: step.label ?? 'Steady',
        });
        break;
      case 'ramp': {
        const rising = step.powerEnd > step.powerStart;
        const falling = step.powerEnd < step.powerStart;
        const label =
          step.label ??
          (stepIndex === 0 && rising
            ? 'Warm-up'
            : stepIndex === last && falling
              ? 'Cool-down'
              : 'Ramp');
        push({
          stepIndex,
          kind: 'ramp',
          mode: 'erg',
          durationS: step.durationS,
          powerStart: step.powerStart,
          powerEnd: step.powerEnd,
          ...(step.cadenceRpm !== undefined ? { cadenceRpm: step.cadenceRpm } : {}),
          label,
        });
        break;
      }
      case 'intervals': {
        const base = step.label ?? 'Interval';
        for (let n = 1; n <= step.repeat; n++) {
          const tag = `${base} ${n}/${step.repeat}`;
          push({
            stepIndex,
            kind: 'intervalOn',
            mode: 'erg',
            durationS: step.onDurationS,
            powerStart: step.onPower,
            powerEnd: step.onPower,
            ...(step.onCadenceRpm !== undefined ? { cadenceRpm: step.onCadenceRpm } : {}),
            label: `${tag} · on`,
            interval: { number: n, of: step.repeat, phase: 'on' },
          });
          push({
            stepIndex,
            kind: 'intervalOff',
            mode: 'erg',
            durationS: step.offDurationS,
            powerStart: step.offPower,
            powerEnd: step.offPower,
            ...(step.offCadenceRpm !== undefined ? { cadenceRpm: step.offCadenceRpm } : {}),
            label: `${tag} · off`,
            interval: { number: n, of: step.repeat, phase: 'off' },
          });
        }
        break;
      }
      case 'freeRide':
        push({
          stepIndex,
          kind: 'freeRide',
          mode: 'free',
          durationS: step.durationS,
          powerStart: null,
          powerEnd: null,
          ...(step.gradePercent !== undefined ? { gradePercent: step.gradePercent } : {}),
          ...(step.expectedPower !== undefined ? { expectedPower: step.expectedPower } : {}),
          label: step.label ?? 'Free ride',
        });
        break;
    }
  });

  cues.sort((a, b) => a.atS - b.atS);
  const timelineCues: TimelineCue[] = cues.map((c, index) => ({
    index,
    atS: c.atS,
    message: c.message,
    segmentIndex: findSegmentIndex(segments, c.atS),
  }));
  return { workout, segments, cues: timelineCues, totalDurationS: t };
}

/** Index of the segment containing `t` (boundaries belong to the following segment); -1 past the end. */
function findSegmentIndex(segments: readonly Segment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid] as Segment;
    if (seg.startS <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return segments.length > 0 ? 0 : -1;
  const seg = segments[found] as Segment;
  return t < seg.endS ? found : -1;
}

/** Planned FTP fraction of a segment `segmentElapsedS` into it (linear for ramps). */
export function segmentFractionAt(segment: Segment, segmentElapsedS: number): number | null {
  if (segment.powerStart === null || segment.powerEnd === null) return null;
  if (segment.powerStart === segment.powerEnd) return segment.powerStart;
  const f = Math.min(1, Math.max(0, segmentElapsedS / segment.durationS));
  return segment.powerStart + (segment.powerEnd - segment.powerStart) * f;
}

/** Clamp for the intensity ("bias") factor applied to all targets. */
export const MIN_INTENSITY = 0.5;
export const MAX_INTENSITY = 1.5;

export function clampIntensity(factor: number): number {
  if (!Number.isFinite(factor)) return 1;
  return Math.min(MAX_INTENSITY, Math.max(MIN_INTENSITY, factor));
}

function safeFtp(ftpW: number): number {
  return Number.isFinite(ftpW) && ftpW > 0 ? ftpW : 0;
}

export function toWatts(fraction: number | null, ftpW: number, intensity = 1): number | null {
  return fraction === null
    ? null
    : Math.round(fraction * safeFtp(ftpW) * clampIntensity(intensity));
}

export interface WorkoutTarget {
  /** Index into `timeline.segments`; `segments.length` once finished. */
  segmentIndex: number;
  kind: SegmentKind | 'done';
  mode: TrainerMode;
  label: string;
  /** Whole watts (FTP × fraction × intensity); `null` in free ride / when done. */
  targetPowerW: number | null;
  /** Effective FTP fraction (incl. intensity); `null` in free ride / when done. */
  targetFraction: number | null;
  cadenceRpm?: number;
  /** Free ride with a fixed gradient. */
  gradePercent?: number;
  interval?: { number: number; of: number; phase: 'on' | 'off' };
  /** Workout time actually used (input clamped to [0, total]). */
  elapsedS: number;
  segmentElapsedS: number;
  segmentRemainingS: number;
  totalRemainingS: number;
  next?: { label: string; targetPowerW: number | null; durationS: number };
  /** The most recent cue, for `CUE_DISPLAY_S` seconds after it fired. */
  cue?: { index: number; message: string; atS: number };
  finished: boolean;
}

/**
 * What the trainer should do `elapsedS` seconds into the workout. Ramps interpolate linearly;
 * an exact segment boundary belongs to the following segment. Non-finite / negative times are
 * treated as 0, times past the end as finished.
 */
export function targetAt(
  timeline: Timeline,
  elapsedS: number,
  ftpW: number,
  intensity = 1,
): WorkoutTarget {
  const total = timeline.totalDurationS;
  const t = Number.isFinite(elapsedS) ? Math.min(total, Math.max(0, elapsedS)) : 0;
  const k = clampIntensity(intensity);
  const index = t >= total ? -1 : findSegmentIndex(timeline.segments, t);

  if (index === -1) {
    return {
      segmentIndex: timeline.segments.length,
      kind: 'done',
      mode: 'free',
      label: 'Done',
      targetPowerW: null,
      targetFraction: null,
      elapsedS: t,
      segmentElapsedS: 0,
      segmentRemainingS: 0,
      totalRemainingS: 0,
      finished: true,
    };
  }

  const seg = timeline.segments[index] as Segment;
  const segmentElapsedS = t - seg.startS;
  const fraction = segmentFractionAt(seg, segmentElapsedS);
  const result: WorkoutTarget = {
    segmentIndex: index,
    kind: seg.kind,
    mode: seg.mode,
    label: seg.label,
    targetPowerW: toWatts(fraction, ftpW, k),
    targetFraction: fraction === null ? null : fraction * k,
    elapsedS: t,
    segmentElapsedS,
    segmentRemainingS: seg.endS - t,
    totalRemainingS: total - t,
    finished: false,
  };
  if (seg.cadenceRpm !== undefined) result.cadenceRpm = seg.cadenceRpm;
  if (seg.gradePercent !== undefined) result.gradePercent = seg.gradePercent;
  if (seg.interval) result.interval = { ...seg.interval };

  const next = timeline.segments[index + 1];
  if (next) {
    result.next = {
      label: next.label,
      targetPowerW: toWatts(next.powerStart, ftpW, k),
      durationS: next.durationS,
    };
  }

  // Latest cue with atS <= t, still within its display window.
  let cue: TimelineCue | undefined;
  for (const c of timeline.cues) {
    if (c.atS > t) break;
    cue = c;
  }
  if (cue && t - cue.atS < CUE_DISPLAY_S) {
    result.cue = { index: cue.index, message: cue.message, atS: cue.atS };
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Stats & profile
// ---------------------------------------------------------------------------------------------

/** Classic 7-zone power model; upper bounds as FTP fractions (zone 7 is open-ended). */
export const POWER_ZONES = [
  { zone: 1, name: 'Active recovery', maxFraction: 0.55 },
  { zone: 2, name: 'Endurance', maxFraction: 0.75 },
  { zone: 3, name: 'Tempo', maxFraction: 0.9 },
  { zone: 4, name: 'Threshold', maxFraction: 1.05 },
  { zone: 5, name: 'VO2max', maxFraction: 1.2 },
  { zone: 6, name: 'Anaerobic', maxFraction: 1.5 },
  { zone: 7, name: 'Neuromuscular', maxFraction: Number.POSITIVE_INFINITY },
] as const;

/** Effort assumed for free-ride seconds without `expectedPower`, for stats only. */
export const FREE_RIDE_ASSUMED_POWER = 0.5;

export interface WorkoutStats {
  durationS: number;
  /** Seconds with an ERG target. */
  ergDurationS: number;
  freeRideS: number;
  /** Unrounded. Free ride counts as `expectedPower ?? FREE_RIDE_ASSUMED_POWER`. */
  averagePowerW: number;
  /** Normalised power estimate (30 s rolling mean, 4th-power mean, 4th root). */
  normalizedPowerW: number;
  intensityFactor: number;
  tss: number;
  workKj: number;
  /** Seconds per zone 1–7 (index 0 = zone 1); ERG seconds only, so sum + freeRideS = durationS. */
  timeInZonesS: number[];
}

/** Planned FTP fraction per second (sampled at the middle of each second). */
function perSecondFractions(timeline: Timeline): { values: Float64Array; free: Uint8Array } {
  const n = Math.ceil(timeline.totalDurationS);
  const values = new Float64Array(n);
  const free = new Uint8Array(n);
  for (const seg of timeline.segments) {
    for (let s = seg.startS; s < seg.endS && s < n; s++) {
      const f = segmentFractionAt(seg, s + 0.5 - seg.startS);
      if (f === null) {
        values[s] = seg.expectedPower ?? FREE_RIDE_ASSUMED_POWER;
        free[s] = 1;
      } else {
        values[s] = f;
      }
    }
  }
  return { values, free };
}

export function zoneOf(fraction: number): number {
  for (const z of POWER_ZONES) if (fraction <= z.maxFraction + 1e-9) return z.zone;
  return 7;
}

/** Planned-load summary for the workout list / preview. */
export function workoutStats(workout: Workout, ftpW: number): WorkoutStats {
  const ftp = safeFtp(ftpW);
  const timeline = buildTimeline(workout);
  const { values, free } = perSecondFractions(timeline);
  const n = values.length;
  const timeInZonesS = [0, 0, 0, 0, 0, 0, 0];
  let sum = 0;
  let freeRideS = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i] as number;
    sum += v;
    if (free[i]) freeRideS++;
    else {
      const zi = zoneOf(v) - 1;
      timeInZonesS[zi] = (timeInZonesS[zi] as number) + 1;
    }
  }
  const avgFraction = n > 0 ? sum / n : 0;

  let npFraction = avgFraction;
  const window = 30;
  if (n >= window) {
    let rolling = 0;
    let acc = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      rolling += values[i] as number;
      if (i >= window) rolling -= values[i - window] as number;
      if (i >= window - 1) {
        acc += (rolling / window) ** 4;
        count++;
      }
    }
    npFraction = (acc / count) ** 0.25;
  }

  return {
    durationS: timeline.totalDurationS,
    ergDurationS: timeline.totalDurationS - freeRideS,
    freeRideS,
    averagePowerW: avgFraction * ftp,
    normalizedPowerW: npFraction * ftp,
    intensityFactor: npFraction,
    tss: (n / 3600) * npFraction * npFraction * 100,
    workKj: (sum * ftp) / 1000,
    timeInZonesS,
  };
}

export type ProfilePoint = [tS: number, fraction: number | null];

/**
 * Planned power profile for charts: `[tS, fraction]` points (`null` = free ride, draw as a gap or
 * hatched band). Exact segment corners when they fit into `maxPoints`, otherwise `maxPoints`
 * time-bucket averages (ERG seconds only; a bucket that is all free ride is `null`).
 */
export function powerProfile(workout: Workout, maxPoints: number): ProfilePoint[] {
  const timeline = buildTimeline(workout);
  const max = Math.max(2, Math.floor(Number.isFinite(maxPoints) ? maxPoints : 2));
  if (timeline.segments.length * 2 <= max) {
    const points: ProfilePoint[] = [];
    for (const seg of timeline.segments) {
      points.push([seg.startS, seg.powerStart], [seg.endS, seg.powerEnd]);
    }
    return points;
  }
  const { values, free } = perSecondFractions(timeline);
  const total = values.length;
  const buckets = Math.min(max, total);
  const points: ProfilePoint[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * total) / buckets);
    const to = Math.floor(((b + 1) * total) / buckets);
    let sum = 0;
    let count = 0;
    for (let i = from; i < to && i < total; i++) {
      if (free[i]) continue;
      sum += values[i] as number;
      count++;
    }
    points.push([from, count > 0 ? sum / count : null]);
  }
  return points;
}
