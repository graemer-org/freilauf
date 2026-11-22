import { describe, expect, it } from 'vitest';
import type { PowerSample } from './ftpTest';
import {
  FTP_TESTS,
  RAMP_TEST,
  RAMP_TEST_INCREMENT,
  RAMP_TEST_START,
  TWENTY_MINUTE_TEST,
  bestAveragePower,
  detectRampFailure,
  evaluateRampTest,
  evaluateTwentyMinuteTest,
  ftpTestEffortWindow,
} from './ftpTest';
import { validateWorkout } from './model';
import { WorkoutRunner } from './runner';
import { buildTimeline } from './timeline';

/** 1 Hz samples from `from` (inclusive) to `to` (exclusive). */
function ride(
  from: number,
  to: number,
  power: (t: number) => number,
  extra: Partial<PowerSample> = {},
) {
  const out: PowerSample[] = [];
  for (let t = from; t < to; t++) out.push({ elapsedS: t, powerW: power(t), ...extra });
  return out;
}

describe('protocols', () => {
  it('are valid workouts', () => {
    for (const p of FTP_TESTS) {
      const r = validateWorkout(p.workout);
      expect(r.ok && r.workout, p.kind).toEqual(p.workout);
    }
  });

  it('20-minute test: the measured effort is a 20-min free-ride step', () => {
    const step = TWENTY_MINUTE_TEST.workout.steps[TWENTY_MINUTE_TEST.effortStepIndex];
    expect(step).toMatchObject({ kind: 'freeRide', durationS: 1200 });
    const kinds = TWENTY_MINUTE_TEST.workout.steps.map((s) => s.kind);
    expect(kinds[0]).toBe('ramp'); // warm-up
    expect(kinds).toContain('intervals'); // openers
    expect(
      TWENTY_MINUTE_TEST.workout.steps.some(
        (s) => s.kind === 'steady' && s.durationS === 300 && s.power >= 1,
      ),
    ).toBe(true); // clearing effort
    expect(kinds.at(-1)).toBe('ramp'); // cool-down
    const window = ftpTestEffortWindow(TWENTY_MINUTE_TEST, 100);
    expect(window.endS - window.startS).toBe(1200);
    const tl = buildTimeline(TWENTY_MINUTE_TEST.workout);
    const seg = tl.segments.find((s) => s.stepIndex === TWENTY_MINUTE_TEST.effortStepIndex);
    expect(window.startS).toBe(100 + (seg?.startS ?? -1));
    // The runner leaves ERG for the effort.
    const runner = new WorkoutRunner(TWENTY_MINUTE_TEST.workout, { ftpW: 250 });
    runner.update(0);
    const u = runner.update(window.startS - 100);
    expect(u.mode).toBe('free');
    expect(u.changes.modeChanged).toBe(true);
  });

  it('ramp test: 1-min steady steps rising by a fixed increment up to the cap', () => {
    const steps = RAMP_TEST.workout.steps.slice(RAMP_TEST.effortStepIndex);
    expect(RAMP_TEST.openEnded).toBe(true);
    expect(steps.length).toBe(43);
    steps.forEach((s, k) => {
      expect(s.kind).toBe('steady');
      if (s.kind !== 'steady') return;
      expect(s.durationS).toBe(60);
      expect(s.power).toBeCloseTo(RAMP_TEST_START + k * RAMP_TEST_INCREMENT, 6);
    });
    expect(ftpTestEffortWindow(RAMP_TEST).startS).toBe(300);
  });
});

describe('bestAveragePower', () => {
  it('finds the best window', () => {
    const s = ride(0, 600, (t) => (t >= 200 && t < 260 ? 400 : 200));
    expect(bestAveragePower(s, 60)).toEqual({ averagePowerW: 400, startS: 200 });
    expect(bestAveragePower(s, 600)?.averagePowerW).toBeCloseTo(220);
    expect(bestAveragePower(s, 601)).toBeNull();
  });

  it('handles gaps: small dropouts are tolerated, large gaps break windows', () => {
    // 60 s at 300 W but 5 s missing in the middle: still qualifies (≥ 90 % coverage).
    const s = ride(0, 60, () => 300).filter((x) => x.elapsedS < 20 || x.elapsedS >= 25);
    expect(bestAveragePower(s, 60)?.averagePowerW).toBe(300);
    // Two 40 s blocks separated by a 100 s gap never form a 60 s window.
    const gap = [...ride(0, 40, () => 300), ...ride(140, 180, () => 300)];
    expect(bestAveragePower(gap, 60)).toBeNull();
  });

  it('ignores non-finite values and bad input', () => {
    const s = ride(0, 60, (t) => (t % 10 === 0 ? Number.NaN : 250));
    s.push(
      { elapsedS: Number.NaN, powerW: 9999 },
      { elapsedS: 30.5, powerW: Number.POSITIVE_INFINITY },
    );
    expect(bestAveragePower(s, 50)?.averagePowerW).toBe(250);
    expect(bestAveragePower([], 60)).toBeNull();
    expect(bestAveragePower(s, 0)).toBeNull();
    expect(bestAveragePower(s, Number.NaN)).toBeNull();
  });
});

describe('evaluateTwentyMinuteTest', () => {
  const start = 2000;
  const end = start + 1200;

  it('computes FTP as 95 % of the 20-min average', () => {
    const s = [
      ...ride(0, start, () => 150, { heartRateBpm: 120 }),
      ...ride(start, end, (t) => (t < start + 600 ? 280 : 300), { heartRateBpm: 170 }),
      ...ride(end, end + 600, () => 120),
    ];
    const r = evaluateTwentyMinuteTest(s, start, end);
    expect(r).toEqual({
      valid: true,
      averagePowerW: 290,
      ftpW: 276,
      averageHeartRateBpm: 170,
      sampleCount: 1200,
    });
  });

  it('tolerates a few dropouts and missing heart rate', () => {
    const s = ride(start, end, () => 250).filter((x) => x.elapsedS % 50 !== 0);
    const r = evaluateTwentyMinuteTest(s, start, end);
    expect(r.valid).toBe(true);
    expect(r.ftpW).toBe(238); // 237.5 rounded
    expect(r.averageHeartRateBpm).toBeUndefined();
  });

  it('rejects a cut-short effort', () => {
    const r = evaluateTwentyMinuteTest(
      ride(start, start + 900, () => 300),
      start,
      end,
    );
    expect(r).toMatchObject({ valid: false, reason: 'cut-short', averagePowerW: 300 });
  });

  it('rejects too few samples', () => {
    const s = ride(start, end, () => 300).filter((x) => x.elapsedS % 5 !== 0); // 80 %
    expect(evaluateTwentyMinuteTest(s, start, end)).toMatchObject({
      valid: false,
      reason: 'too-few-samples',
    });
  });

  it('rejects zero power, bad and short windows', () => {
    expect(
      evaluateTwentyMinuteTest(
        ride(start, end, () => 0),
        start,
        end,
      ).reason,
    ).toBe('no-power');
    expect(evaluateTwentyMinuteTest([], end, start).reason).toBe('invalid-window');
    expect(evaluateTwentyMinuteTest([], Number.NaN, end).reason).toBe('invalid-window');
    expect(
      evaluateTwentyMinuteTest(
        ride(0, 600, () => 300),
        0,
        600,
      ).reason,
    ).toBe('window-too-short');
  });
});

describe('evaluateRampTest', () => {
  it('computes FTP as 75 % of the best 1-min power', () => {
    // Ramp from 300 s: 115 W + 15 W per minute, rider stops after 18 minutes.
    const rampStart = 300;
    const s = [
      ...ride(0, rampStart, () => 100),
      ...ride(rampStart, rampStart + 18 * 60, (t) => 115 + 15 * Math.floor((t - rampStart) / 60), {
        heartRateBpm: 150,
      }),
      ...ride(rampStart + 18 * 60, rampStart + 19 * 60, () => 0),
    ];
    s[s.length - 100]!.heartRateBpm = 188;
    const r = evaluateRampTest(s, rampStart);
    const last = 115 + 15 * 17; // 370 W
    expect(r).toMatchObject({
      valid: true,
      bestOneMinutePowerW: last,
      ftpW: Math.round(last * 0.75),
      maxHeartRateBpm: 188,
    });
  });

  it('rejects a too short ramp', () => {
    const r = evaluateRampTest(
      ride(300, 400, () => 200),
      300,
    );
    expect(r).toMatchObject({ valid: false, reason: 'cut-short' });
    expect(evaluateRampTest([], 0).valid).toBe(false);
    expect(
      evaluateRampTest(
        ride(0, 600, () => 0),
        0,
      ).reason,
    ).toBe('no-power');
  });
});

describe('detectRampFailure', () => {
  const tl = buildTimeline(RAMP_TEST.workout);
  const ftp = 250;
  /** Rides the ramp test perfectly on target until `failAt`, then at `after(target)`. */
  function rideRamp(
    until: number,
    failAt: number,
    after: (target: number) => number,
    cadence = 90,
  ) {
    const out: PowerSample[] = [];
    const runner = new WorkoutRunner(RAMP_TEST.workout, { ftpW: ftp });
    for (let t = 0; t <= until; t++) {
      const target = runner.update(t).targetPowerW ?? 0;
      out.push({
        elapsedS: t,
        powerW: t < failAt ? target : after(target),
        cadenceRpm: t < failAt ? 90 : cadence,
      });
    }
    return out;
  }

  it('stays false while the rider holds the target', () => {
    const s = rideRamp(900, Number.POSITIVE_INFINITY, (x) => x);
    for (let now = 0; now <= 900; now += 7) expect(detectRampFailure(s, tl, ftp, now)).toBe(false);
  });

  it('fires after 10 s clearly below target', () => {
    const s = rideRamp(1000, 900, (x) => x * 0.7);
    expect(detectRampFailure(s, tl, ftp, 905)).toBe(false);
    expect(detectRampFailure(s, tl, ftp, 909)).toBe(true);
    // 85 % is not "clearly below".
    const s2 = rideRamp(1000, 900, (x) => x * 0.85);
    expect(detectRampFailure(s2, tl, ftp, 950)).toBe(false);
  });

  it('fires after 5 s at zero power or zero cadence', () => {
    const s = rideRamp(1000, 900, () => 0);
    expect(detectRampFailure(s, tl, ftp, 901)).toBe(false);
    expect(detectRampFailure(s, tl, ftp, 904)).toBe(true);
    const c = rideRamp(1000, 900, (x) => x, 0);
    expect(detectRampFailure(c, tl, ftp, 904)).toBe(true);
  });

  it('respects fromS and the workout start offset', () => {
    // Rider not pedalling in the first seconds of the warm-up.
    const s = ride(0, 20, () => 0);
    expect(detectRampFailure(s, tl, ftp, 10)).toBe(true);
    expect(detectRampFailure(s, tl, ftp, 10, { fromS: 300 })).toBe(false);
    // Workout started at ride time 1000: samples before are ignored via fromS, targets are shifted.
    const shifted = rideRamp(1000, 900, (x) => x * 0.5).map((x) => ({
      ...x,
      elapsedS: x.elapsedS + 1000,
    }));
    expect(detectRampFailure(shifted, tl, ftp, 1905, { workoutStartRideS: 1000 })).toBe(false);
    expect(detectRampFailure(shifted, tl, ftp, 1910, { workoutStartRideS: 1000 })).toBe(true);
  });

  it('is true once the timeline has run out, false for bad input', () => {
    expect(detectRampFailure([], tl, ftp, tl.totalDurationS)).toBe(true);
    expect(detectRampFailure([], tl, ftp, Number.NaN)).toBe(false);
    expect(detectRampFailure([], tl, ftp, 500)).toBe(false);
  });
});
