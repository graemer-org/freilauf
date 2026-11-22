/**
 * FTP tests: two protocols (as ordinary `Workout`s plus metadata about the measured effort) and
 * pure evaluation over recorded samples. This module only computes a result; offering it to the
 * rider and storing it as the new FTP is the integrator's job.
 */
import type { SteadyStep, Workout } from './model';
import type { Timeline } from './timeline';
import { buildTimeline, targetAt } from './timeline';

export type FtpTestKind = 'twentyMinute' | 'ramp';

export interface FtpTestProtocol {
  kind: FtpTestKind;
  workout: Workout;
  /** Index of the step whose start begins the measured effort. */
  effortStepIndex: number;
  /** FTP = factor × (20-min average | best 1-min average). */
  factor: number;
  /**
   * `true` when the protocol has no fixed end (ramp test): the effort lasts until the rider
   * stops; end it with `detectRampFailure` or a manual "stop test".
   */
  openEnded: boolean;
}

const TWENTY_MIN_EFFORT_S = 20 * 60;

/** 20-minute test: warm-up with openers, 5-min clearing effort, recovery, 20 min all-out (free ride). */
export const TWENTY_MINUTE_TEST: FtpTestProtocol = {
  kind: 'twentyMinute',
  factor: 0.95,
  openEnded: false,
  effortStepIndex: 6,
  workout: {
    id: 'builtin-ftp-test-20',
    name: 'FTP test · 20 minutes',
    description:
      'Warm-up with openers, a 5-minute clearing effort, then 20 minutes as hard as you can sustain in free-ride mode. FTP = 95 % of the 20-minute average.',
    author: 'Freilauf',
    tags: ['ftp-test', 'test'],
    steps: [
      {
        kind: 'ramp',
        durationS: 600,
        powerStart: 0.45,
        powerEnd: 0.7,
        cadenceRpm: 90,
        label: 'Warm-up',
      },
      {
        kind: 'intervals',
        repeat: 3,
        onDurationS: 20,
        onPower: 1.2,
        offDurationS: 100,
        offPower: 0.55,
        onCadenceRpm: 100,
        label: 'Opener',
      },
      { kind: 'steady', durationS: 180, power: 0.6, label: 'Easy' },
      {
        kind: 'steady',
        durationS: 300,
        power: 1.05,
        label: 'Clearing effort',
        cues: [{ atS: 0, message: 'Hard but controlled: this clears the legs for the test.' }],
      },
      { kind: 'steady', durationS: 300, power: 0.5, label: 'Recovery' },
      {
        kind: 'steady',
        durationS: 300,
        power: 0.55,
        label: 'Get ready',
        cues: [{ atS: 240, message: 'One minute to go. The test is free ride: you set the pace.' }],
      },
      {
        kind: 'freeRide',
        durationS: TWENTY_MIN_EFFORT_S,
        gradePercent: 1,
        expectedPower: 1.0,
        label: 'FTP test · 20 min',
        cues: [
          { atS: 0, message: 'Go! Start a little below your target and settle in.' },
          { atS: 300, message: '5 minutes done. Steady breathing, smooth cadence.' },
          { atS: 600, message: 'Halfway. Hold the pace.' },
          { atS: 900, message: '5 minutes left. Lift it a little if you can.' },
          { atS: 1140, message: 'Last minute: empty the tank!' },
        ],
      },
      { kind: 'ramp', durationS: 600, powerStart: 0.6, powerEnd: 0.4, label: 'Cool-down' },
    ],
  },
};

/** Ramp test parameters, relative to the rider's current FTP estimate. */
export const RAMP_TEST_START = 0.46;
export const RAMP_TEST_INCREMENT = 0.06;
export const RAMP_TEST_STEP_S = 60;
/** Highest step target (the model's power cap is 3.0). */
export const RAMP_TEST_CEILING = 3.0;

function rampSteps(): SteadyStep[] {
  const steps: SteadyStep[] = [];
  for (let k = 0; ; k++) {
    const power = Math.round((RAMP_TEST_START + k * RAMP_TEST_INCREMENT) * 100) / 100;
    if (power > RAMP_TEST_CEILING + 1e-9) break;
    const step: SteadyStep = {
      kind: 'steady',
      durationS: RAMP_TEST_STEP_S,
      power,
      label: `Ramp ${k + 1}`,
    };
    if (k === 0)
      step.cues = [
        { atS: 0, message: 'The ramp starts. Keep pedalling until you cannot hold the target.' },
      ];
    steps.push(step);
  }
  return steps;
}

/** Ramp test: warm-up, then 1-minute ERG steps rising by 6 % FTP until the rider cannot continue. */
export const RAMP_TEST: FtpTestProtocol = {
  kind: 'ramp',
  factor: 0.75,
  openEnded: true,
  effortStepIndex: 1,
  workout: {
    id: 'builtin-ftp-test-ramp',
    name: 'FTP test · ramp',
    description:
      'Short warm-up, then the target rises by 6 % of your FTP every minute until you cannot hold it. FTP = 75 % of your best 1-minute power.',
    author: 'Freilauf',
    tags: ['ftp-test', 'test'],
    steps: [
      { kind: 'ramp', durationS: 300, powerStart: 0.35, powerEnd: 0.45, label: 'Warm-up' },
      ...rampSteps(),
    ],
  },
};

export const FTP_TESTS: readonly FtpTestProtocol[] = [TWENTY_MINUTE_TEST, RAMP_TEST];

/**
 * The measured effort window on the ride clock, given the ride time at which the workout
 * started (assumes no skip/back during the test). For the open-ended ramp test `endS` is the
 * planned end of the last step.
 */
export function ftpTestEffortWindow(
  protocol: FtpTestProtocol,
  workoutStartRideS = 0,
): { startS: number; endS: number } {
  const timeline = buildTimeline(protocol.workout);
  const first = timeline.segments.find((s) => s.stepIndex === protocol.effortStepIndex);
  const lastSeg = protocol.openEnded
    ? timeline.segments[timeline.segments.length - 1]
    : [...timeline.segments].reverse().find((s) => s.stepIndex === protocol.effortStepIndex);
  return {
    startS: workoutStartRideS + (first?.startS ?? 0),
    endS: workoutStartRideS + (lastSeg?.endS ?? timeline.totalDurationS),
  };
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/** Structurally compatible with `@freilauf/session`'s `RideSample`. */
export interface PowerSample {
  elapsedS: number;
  powerW: number;
  heartRateBpm?: number | null;
  cadenceRpm?: number | null;
}

export type FtpTestInvalidReason =
  'invalid-window' | 'window-too-short' | 'cut-short' | 'too-few-samples' | 'no-power';

export interface TwentyMinuteTestResult {
  valid: boolean;
  reason?: FtpTestInvalidReason;
  /** Whole watts, over the samples inside the window. */
  averagePowerW: number;
  /** round(0.95 × average). Only meaningful when `valid`. */
  ftpW: number;
  averageHeartRateBpm?: number;
  sampleCount: number;
}

export interface RampTestResult {
  valid: boolean;
  reason?: FtpTestInvalidReason;
  bestOneMinutePowerW: number;
  /** round(0.75 × best 1-min average). Only meaningful when `valid`. */
  ftpW: number;
  maxHeartRateBpm?: number;
  /** Seconds from the ramp start to the last sample. */
  rampDurationS: number;
}

/** A window counts if at least this share of its seconds has a power value. */
export const MIN_WINDOW_COVERAGE = 0.9;
const MAX_SPAN_S = 48 * 3600;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const validPower = (v: unknown): v is number => finite(v) && v >= 0 && v < 5000;
const validHr = (v: unknown): v is number => finite(v) && v > 20 && v < 260;

/**
 * Best average power over `windowS` consecutive seconds. Samples are bucketed per whole second;
 * seconds without a finite power value are gaps. A window is only considered when at least 90 %
 * of its seconds have data, and is averaged over the seconds that do. Returns `null` when no
 * window qualifies.
 */
export function bestAveragePower(
  samples: readonly PowerSample[],
  windowS: number,
): { averagePowerW: number; startS: number } | null {
  const w = Math.round(windowS);
  if (!Number.isFinite(w) || w < 1) return null;
  let t0 = Number.POSITIVE_INFINITY;
  for (const s of samples)
    if (finite(s.elapsedS) && validPower(s.powerW)) t0 = Math.min(t0, Math.floor(s.elapsedS));
  if (t0 === Number.POSITIVE_INFINITY) return null;

  let n = 0;
  for (const s of samples) {
    if (!finite(s.elapsedS) || !validPower(s.powerW)) continue;
    const i = Math.floor(s.elapsedS) - t0;
    if (i < MAX_SPAN_S) n = Math.max(n, i + 1);
  }
  const value = new Float64Array(n);
  const has = new Uint8Array(n);
  for (const s of samples) {
    if (!finite(s.elapsedS) || !validPower(s.powerW)) continue;
    const i = Math.floor(s.elapsedS) - t0;
    if (i >= n) continue;
    value[i] = s.powerW; // last sample in a second wins
    has[i] = 1;
  }
  if (n < w) return null;

  const need = Math.ceil(w * MIN_WINDOW_COVERAGE);
  let sum = 0;
  let count = 0;
  let best: { averagePowerW: number; startS: number } | null = null;
  for (let i = 0; i < n; i++) {
    sum += value[i] as number;
    count += has[i] as number;
    if (i >= w) {
      sum -= value[i - w] as number;
      count -= has[i - w] as number;
    }
    if (i >= w - 1 && count >= need) {
      const avg = sum / count;
      if (!best || avg > best.averagePowerW) best = { averagePowerW: avg, startS: t0 + i - w + 1 };
    }
  }
  return best;
}

/** Evaluates a 20-minute test over the effort window [effortStartS, effortEndS) (ride clock). */
export function evaluateTwentyMinuteTest(
  samples: readonly PowerSample[],
  effortStartS: number,
  effortEndS: number,
): TwentyMinuteTestResult {
  const invalid = (reason: FtpTestInvalidReason, avg = 0, count = 0): TwentyMinuteTestResult => ({
    valid: false,
    reason,
    averagePowerW: Math.round(avg),
    ftpW: Math.round(avg * TWENTY_MINUTE_TEST.factor),
    sampleCount: count,
  });
  if (!finite(effortStartS) || !finite(effortEndS) || effortEndS <= effortStartS) {
    return invalid('invalid-window');
  }
  const durationS = effortEndS - effortStartS;
  if (durationS < TWENTY_MIN_EFFORT_S - 60) return invalid('window-too-short');

  let sum = 0;
  let count = 0;
  let hrSum = 0;
  let hrCount = 0;
  let lastS = Number.NEGATIVE_INFINITY;
  const seconds = new Set<number>();
  for (const s of samples) {
    if (!finite(s.elapsedS) || s.elapsedS < effortStartS || s.elapsedS >= effortEndS) continue;
    if (!validPower(s.powerW)) continue;
    const sec = Math.floor(s.elapsedS);
    if (seconds.has(sec)) continue; // one sample per second
    seconds.add(sec);
    sum += s.powerW;
    count++;
    lastS = Math.max(lastS, s.elapsedS);
    if (validHr(s.heartRateBpm)) {
      hrSum += s.heartRateBpm;
      hrCount++;
    }
  }
  const avg = count > 0 ? sum / count : 0;
  if (lastS < effortEndS - 10) return invalid('cut-short', avg, count);
  if (count < durationS * MIN_WINDOW_COVERAGE) return invalid('too-few-samples', avg, count);
  if (avg < 30) return invalid('no-power', avg, count);
  const result: TwentyMinuteTestResult = {
    valid: true,
    averagePowerW: Math.round(avg),
    ftpW: Math.round(avg * TWENTY_MINUTE_TEST.factor),
    sampleCount: count,
  };
  if (hrCount > 0) result.averageHeartRateBpm = Math.round(hrSum / hrCount);
  return result;
}

/** Minimum ramp length (from ramp start to last sample) for a valid ramp test. */
export const MIN_RAMP_DURATION_S = 180;

/** Evaluates a ramp test from `rampStartS` (ride clock) to the last sample. */
export function evaluateRampTest(
  samples: readonly PowerSample[],
  rampStartS: number,
): RampTestResult {
  const start = finite(rampStartS) ? rampStartS : 0;
  const ramp = samples.filter((s) => finite(s.elapsedS) && s.elapsedS >= start);
  let lastS = start;
  let maxHr: number | undefined;
  for (const s of ramp) {
    if (validPower(s.powerW)) lastS = Math.max(lastS, s.elapsedS);
    if (validHr(s.heartRateBpm)) maxHr = Math.max(maxHr ?? 0, s.heartRateBpm);
  }
  const best = bestAveragePower(ramp, 60);
  const bestW = best?.averagePowerW ?? 0;
  const result: RampTestResult = {
    valid: true,
    bestOneMinutePowerW: Math.round(bestW),
    ftpW: Math.round(bestW * RAMP_TEST.factor),
    rampDurationS: lastS - start,
  };
  if (maxHr !== undefined) result.maxHeartRateBpm = maxHr;
  if (result.rampDurationS < MIN_RAMP_DURATION_S) {
    result.valid = false;
    result.reason = 'cut-short';
  } else if (!best) {
    result.valid = false;
    result.reason = 'too-few-samples';
  } else if (bestW < 30) {
    result.valid = false;
    result.reason = 'no-power';
  }
  return result;
}

export interface RampFailureOptions {
  /** Ride time at which the workout started (samples and `nowS` are on the ride clock). Default 0. */
  workoutStartRideS?: number;
  /** Ignore samples before this ride time, e.g. the ramp start. Default: no limit. */
  fromS?: number;
  /** Intensity the runner applies (should be 1 for tests). Default 1. */
  intensity?: number;
}

/** Below this share of the target for `RAMP_FAILURE_LOW_S` seconds = failure. */
export const RAMP_FAILURE_RATIO = 0.8;
export const RAMP_FAILURE_LOW_S = 10;
/** Power (or cadence) at zero for this long = failure. */
export const RAMP_FAILURE_STOPPED_S = 5;

/**
 * True when the rider can no longer hold the ramp: every sample of the last 10 s is below 80 %
 * of its ERG target (needs ≥ 8 samples), or power or cadence has been zero for the last 5 s
 * (needs ≥ 4 samples), or the timeline has run out. Pure; call it once per sample.
 */
export function detectRampFailure(
  samples: readonly PowerSample[],
  timeline: Timeline,
  ftpW: number,
  nowS: number,
  options: RampFailureOptions = {},
): boolean {
  if (!finite(nowS)) return false;
  const offset = options.workoutStartRideS ?? 0;
  const fromS = options.fromS ?? Number.NEGATIVE_INFINITY;
  if (targetAt(timeline, nowS - offset, ftpW).finished) return true;

  let lowCount = 0;
  let lowAll = true;
  let lowEarliest = Number.POSITIVE_INFINITY;
  let stopCount = 0;
  let stopAll = true;
  let stopEarliest = Number.POSITIVE_INFINITY;
  // Walk backwards: recent samples are at the end.
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i] as PowerSample;
    if (!finite(s.elapsedS) || s.elapsedS > nowS) continue;
    const age = nowS - s.elapsedS;
    if (age >= RAMP_FAILURE_LOW_S) break;
    if (s.elapsedS < fromS) break;
    const target = targetAt(timeline, s.elapsedS - offset, ftpW, options.intensity ?? 1);
    if (target.mode !== 'erg' || target.targetPowerW === null || target.targetPowerW <= 0) continue;
    if (validPower(s.powerW)) {
      lowCount++;
      lowEarliest = Math.min(lowEarliest, s.elapsedS);
      if (s.powerW >= target.targetPowerW * RAMP_FAILURE_RATIO) lowAll = false;
    }
    if (age < RAMP_FAILURE_STOPPED_S) {
      const stopped =
        (validPower(s.powerW) && s.powerW === 0) || (finite(s.cadenceRpm) && s.cadenceRpm === 0);
      const known = validPower(s.powerW) || finite(s.cadenceRpm);
      if (known) {
        stopCount++;
        stopEarliest = Math.min(stopEarliest, s.elapsedS);
        if (!stopped) stopAll = false;
      }
    }
  }
  const lowFail = lowAll && lowCount >= 8 && nowS - lowEarliest >= RAMP_FAILURE_LOW_S - 2;
  const stopFail = stopAll && stopCount >= 4 && nowS - stopEarliest >= RAMP_FAILURE_STOPPED_S - 2;
  return lowFail || stopFail;
}
