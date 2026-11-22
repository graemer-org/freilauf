import { describe, expect, it } from 'vitest';
import type { Workout } from './model';
import {
  CUE_DISPLAY_S,
  POWER_ZONES,
  buildTimeline,
  powerProfile,
  targetAt,
  workoutStats,
  zoneOf,
} from './timeline';

const workout: Workout = {
  id: 'w',
  name: 'Test',
  steps: [
    { kind: 'ramp', durationS: 100, powerStart: 0.5, powerEnd: 1.0, cadenceRpm: 90 },
    {
      kind: 'intervals',
      repeat: 3,
      onDurationS: 30,
      onPower: 1.2,
      offDurationS: 20,
      offPower: 0.5,
      onCadenceRpm: 100,
      cues: [
        { atS: 0, message: 'Go' },
        { atS: 55, message: 'Second' },
      ],
    },
    { kind: 'freeRide', durationS: 60, gradePercent: 0 },
    { kind: 'steady', durationS: 40, power: 0.6, label: 'Easy' },
    { kind: 'ramp', durationS: 50, powerStart: 0.6, powerEnd: 0.4 },
  ],
};
const tl = buildTimeline(workout);

describe('buildTimeline', () => {
  it('expands intervals and assigns absolute times and labels', () => {
    expect(tl.segments.map((s) => s.label)).toEqual([
      'Warm-up',
      'Interval 1/3 · on',
      'Interval 1/3 · off',
      'Interval 2/3 · on',
      'Interval 2/3 · off',
      'Interval 3/3 · on',
      'Interval 3/3 · off',
      'Free ride',
      'Easy',
      'Cool-down',
    ]);
    expect(tl.segments.map((s) => [s.startS, s.endS])).toEqual([
      [0, 100],
      [100, 130],
      [130, 150],
      [150, 180],
      [180, 200],
      [200, 230],
      [230, 250],
      [250, 310],
      [310, 350],
      [350, 400],
    ]);
    expect(tl.totalDurationS).toBe(400);
    expect(tl.segments[1]).toMatchObject({
      kind: 'intervalOn',
      mode: 'erg',
      stepIndex: 1,
      cadenceRpm: 100,
      interval: { number: 1, of: 3, phase: 'on' },
    });
    expect(tl.segments[2]?.cadenceRpm).toBeUndefined();
    expect(tl.segments[7]).toMatchObject({
      kind: 'freeRide',
      mode: 'free',
      powerStart: null,
      gradePercent: 0,
    });
  });

  it('uses custom interval labels and plain ramp labels in the middle', () => {
    const t = buildTimeline({
      id: 'x',
      name: 'x',
      steps: [
        { kind: 'steady', durationS: 10, power: 0.5 },
        { kind: 'ramp', durationS: 10, powerStart: 0.5, powerEnd: 0.8 },
        {
          kind: 'intervals',
          label: 'Sprint',
          repeat: 2,
          onDurationS: 5,
          onPower: 2,
          offDurationS: 5,
          offPower: 0.4,
        },
      ],
    });
    expect(t.segments.map((s) => s.label)).toEqual([
      'Steady',
      'Ramp',
      'Sprint 1/2 · on',
      'Sprint 1/2 · off',
      'Sprint 2/2 · on',
      'Sprint 2/2 · off',
    ]);
  });

  it('places cues on absolute time', () => {
    expect(tl.cues.map((c) => [c.atS, c.message, c.segmentIndex])).toEqual([
      [100, 'Go', 1],
      [155, 'Second', 3],
    ]);
  });
});

describe('targetAt', () => {
  it('interpolates ramps linearly and rounds watts', () => {
    expect(targetAt(tl, 0, 250).targetPowerW).toBe(125);
    expect(targetAt(tl, 50, 250).targetPowerW).toBe(188); // 0.75 × 250 = 187.5
    expect(targetAt(tl, 50, 250).targetFraction).toBeCloseTo(0.75);
    expect(targetAt(tl, 99.9, 200).targetPowerW).toBe(200);
    expect(targetAt(tl, 375, 200).targetPowerW).toBe(100);
  });

  it('assigns exact boundaries to the following segment', () => {
    const t = targetAt(tl, 100, 200);
    expect(t.segmentIndex).toBe(1);
    expect(t.kind).toBe('intervalOn');
    expect(t.targetPowerW).toBe(240);
    expect(t.segmentElapsedS).toBe(0);
    expect(t.segmentRemainingS).toBe(30);
    expect(targetAt(tl, 129.999, 200).segmentIndex).toBe(1);
    expect(targetAt(tl, 130, 200).segmentIndex).toBe(2);
  });

  it('reports remaining times, cadence, label and next', () => {
    const t = targetAt(tl, 110, 200);
    expect(t).toMatchObject({
      label: 'Interval 1/3 · on',
      cadenceRpm: 100,
      segmentElapsedS: 10,
      segmentRemainingS: 20,
      totalRemainingS: 290,
      interval: { number: 1, of: 3, phase: 'on' },
      next: { label: 'Interval 1/3 · off', targetPowerW: 100, durationS: 20 },
      finished: false,
    });
  });

  it('returns null power in free ride and announces it as next', () => {
    expect(targetAt(tl, 240, 200).next).toEqual({
      label: 'Free ride',
      targetPowerW: null,
      durationS: 60,
    });
    const t = targetAt(tl, 260, 200);
    expect(t).toMatchObject({
      kind: 'freeRide',
      mode: 'free',
      targetPowerW: null,
      targetFraction: null,
      gradePercent: 0,
    });
  });

  it('applies the intensity factor (clamped)', () => {
    expect(targetAt(tl, 320, 200, 1.1).targetPowerW).toBe(132);
    expect(targetAt(tl, 320, 200, 1.1).targetFraction).toBeCloseTo(0.66);
    expect(targetAt(tl, 320, 200, 9).targetPowerW).toBe(180);
    expect(targetAt(tl, 320, 200, 0).targetPowerW).toBe(60);
  });

  it('is finished at and after the end, and clamps bad input', () => {
    for (const t of [400, 1e9]) {
      expect(targetAt(tl, t, 200)).toMatchObject({
        finished: true,
        kind: 'done',
        mode: 'free',
        targetPowerW: null,
        segmentIndex: tl.segments.length,
        totalRemainingS: 0,
      });
    }
    expect(targetAt(tl, -5, 200).segmentIndex).toBe(0);
    expect(targetAt(tl, Number.NaN, 200).elapsedS).toBe(0);
    expect(targetAt(tl, 10, Number.NaN).targetPowerW).toBe(0);
    expect(targetAt(tl, 399, 200).next).toBeUndefined();
  });

  it('shows a cue for CUE_DISPLAY_S seconds', () => {
    expect(targetAt(tl, 99, 200).cue).toBeUndefined();
    expect(targetAt(tl, 100, 200).cue).toEqual({ index: 0, message: 'Go', atS: 100 });
    expect(targetAt(tl, 100 + CUE_DISPLAY_S - 0.01, 200).cue?.index).toBe(0);
    expect(targetAt(tl, 100 + CUE_DISPLAY_S, 200).cue).toBeUndefined();
    expect(targetAt(tl, 156, 200).cue?.message).toBe('Second');
  });

  it('handles an empty timeline', () => {
    const empty = buildTimeline({ id: 'e', name: 'e', steps: [] });
    expect(targetAt(empty, 0, 200).finished).toBe(true);
  });
});

describe('workoutStats', () => {
  it('matches hand-computed values for a steady workout', () => {
    const s = workoutStats(
      { id: 's', name: 's', steps: [{ kind: 'steady', durationS: 600, power: 0.8 }] },
      250,
    );
    expect(s.durationS).toBe(600);
    expect(s.averagePowerW).toBeCloseTo(200);
    expect(s.normalizedPowerW).toBeCloseTo(200);
    expect(s.intensityFactor).toBeCloseTo(0.8);
    expect(s.tss).toBeCloseTo((600 / 3600) * 0.64 * 100); // 10.67
    expect(s.workKj).toBeCloseTo(120); // 200 W × 600 s
    expect(s.timeInZonesS).toEqual([0, 0, 600, 0, 0, 0, 0]);
  });

  it('averages ramps exactly', () => {
    const s = workoutStats(
      {
        id: 'r',
        name: 'r',
        steps: [{ kind: 'ramp', durationS: 100, powerStart: 0.5, powerEnd: 1 }],
      },
      200,
    );
    expect(s.averagePowerW).toBeCloseTo(150);
    expect(s.workKj).toBeCloseTo(15);
  });

  it('computes NP from the 30 s rolling average', () => {
    // 300 s @ 100 %, then 300 s @ 50 %. Rolling windows: 271 × 1.0, 29 mixed (1 − k/60), 271 × 0.5.
    const s = workoutStats(
      {
        id: 'np',
        name: 'np',
        steps: [
          { kind: 'steady', durationS: 300, power: 1 },
          { kind: 'steady', durationS: 300, power: 0.5 },
        ],
      },
      300,
    );
    let acc = 271 * 1 + 271 * 0.5 ** 4;
    for (let k = 1; k <= 29; k++) acc += (1 - k / 60) ** 4;
    const np = (acc / 571) ** 0.25;
    expect(s.intensityFactor).toBeCloseTo(np, 10);
    expect(s.normalizedPowerW).toBeCloseTo(np * 300, 8);
    expect(s.averagePowerW).toBeCloseTo(225);
    expect(s.normalizedPowerW).toBeGreaterThan(s.averagePowerW);
    expect(s.tss).toBeCloseTo((600 / 3600) * np * np * 100, 8);
    expect(s.timeInZonesS).toEqual([300, 0, 0, 300, 0, 0, 0]);
  });

  it('uses the average for workouts shorter than 30 s', () => {
    const s = workoutStats(
      { id: 's', name: 's', steps: [{ kind: 'steady', durationS: 20, power: 1.5 }] },
      200,
    );
    expect(s.normalizedPowerW).toBeCloseTo(300);
    expect(s.timeInZonesS[5]).toBe(20);
  });

  it('counts free ride separately with the assumed effort', () => {
    const s = workoutStats(
      {
        id: 'f',
        name: 'f',
        steps: [
          { kind: 'freeRide', durationS: 100 },
          { kind: 'freeRide', durationS: 100, expectedPower: 1 },
          { kind: 'steady', durationS: 100, power: 0.7 },
        ],
      },
      100,
    );
    expect(s.freeRideS).toBe(200);
    expect(s.ergDurationS).toBe(100);
    expect(s.averagePowerW).toBeCloseTo((50 + 100 + 70) / 3);
    expect(s.timeInZonesS.reduce((a, b) => a + b, 0) + s.freeRideS).toBe(s.durationS);
  });

  it('classifies zones by % FTP', () => {
    expect([0.3, 0.55, 0.56, 0.75, 0.9, 1.0, 1.05, 1.1, 1.2, 1.5, 1.51, 3].map(zoneOf)).toEqual([
      1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 7, 7,
    ]);
    expect(POWER_ZONES).toHaveLength(7);
  });
});

describe('powerProfile', () => {
  it('returns exact corners when they fit', () => {
    const p = powerProfile(workout, 100);
    expect(p).toHaveLength(20);
    expect(p[0]).toEqual([0, 0.5]);
    expect(p[1]).toEqual([100, 1]);
    expect(p[14]).toEqual([250, null]);
  });

  it('downsamples to maxPoints buckets', () => {
    const p = powerProfile(workout, 8);
    expect(p).toHaveLength(8);
    expect(p[0]?.[0]).toBe(0);
    // Bucket 0 = seconds 0..49 of the ramp: mean fraction 0.5 + 0.005 × 25 = 0.625.
    expect(p[0]?.[1]).toBeCloseTo(0.625);
    expect(p[5]?.[1]).toBeNull(); // 250..300 is all free ride
    for (let i = 1; i < p.length; i++) expect(p[i]![0]).toBeGreaterThan(p[i - 1]![0]);
  });

  it('copes with tiny or bad maxPoints', () => {
    expect(powerProfile(workout, 0)).toHaveLength(2);
    expect(powerProfile(workout, Number.NaN)).toHaveLength(2);
  });
});
