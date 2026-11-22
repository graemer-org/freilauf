import { describe, expect, it } from 'vitest';
import type { Workout } from '@freilauf/workouts';
import { BUILTIN_WORKOUTS, FTP_TESTS, RAMP_TEST, workoutStats } from '@freilauf/workouts';
import type { WorkoutEntry } from '../../core/workoutLibrary';
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  chartGeometry,
  chartProgress,
  chartSummary,
  classifyDeviation,
  deviationPosition,
  formatFtpChange,
  formatStepDuration,
  modeText,
  nextText,
  nudgeIntensity,
  openEndedHorizonS,
  stepRows,
  uniqueEntries,
  zoneRows,
} from './workoutView';

const sample: Workout = {
  id: 'w',
  name: 'Sample',
  steps: [
    { kind: 'ramp', durationS: 120, powerStart: 0.5, powerEnd: 0.8 },
    { kind: 'steady', durationS: 60, power: 1.2 },
    { kind: 'freeRide', durationS: 60 },
    {
      kind: 'intervals',
      repeat: 2,
      onDurationS: 30,
      onPower: 1.1,
      offDurationS: 30,
      offPower: 0.5,
    },
  ],
};

/** Parses "x,y x,y …" into numbers. */
const corners = (points: string): [number, number][] =>
  points.split(' ').map((p) => p.split(',').map(Number) as [number, number]);

describe('formatStepDuration', () => {
  it('reads naturally', () => {
    expect(formatStepDuration(30)).toBe('30 s');
    expect(formatStepDuration(240)).toBe('4 min');
    expect(formatStepDuration(90)).toBe('1:30 min');
    expect(formatStepDuration(3600)).toBe('1 h');
    expect(formatStepDuration(3720)).toBe('1 h 2 min');
    expect(formatStepDuration(Number.NaN)).toBe('0 s');
  });
});

describe('nextText / modeText', () => {
  it('describes the next step', () => {
    expect(nextText({ label: 'On', targetPowerW: 240.4, durationS: 240 })).toBe(
      'Next: 4 min @ 240 W',
    );
    expect(nextText({ label: 'Free ride', targetPowerW: null, durationS: 1200 })).toBe(
      'Next: 20 min free ride',
    );
    expect(nextText(undefined)).toBe('Last step');
  });

  it('explains the trainer mode', () => {
    expect(modeText({ mode: 'erg', finished: false })).toMatch(/holds the target/);
    expect(modeText({ mode: 'free', finished: false })).toMatch(/free-ride mode/);
    expect(modeText({ mode: 'free', finished: false, ftpTest: 'twentyMinute' })).toBe(
      'All out for 20 minutes — pace yourself',
    );
    expect(modeText({ mode: 'free', finished: true })).toBe('Keep riding or finish');
  });
});

describe('classifyDeviation', () => {
  it('is calm within ±5 %', () => {
    expect(classifyDeviation(205, 200)).toMatchObject({ level: 'calm', direction: 'on' });
    expect(classifyDeviation(190, 200)).toMatchObject({ level: 'calm', text: 'On target' });
  });

  it('nudges up to ±10 % and insists beyond', () => {
    expect(classifyDeviation(216, 200)).toMatchObject({
      level: 'warn',
      direction: 'over',
      deltaW: 16,
      text: '16 W over',
    });
    expect(classifyDeviation(150, 200)).toMatchObject({
      level: 'alert',
      direction: 'under',
      text: '50 W under',
    });
  });

  it('copes with no target or bad input', () => {
    expect(classifyDeviation(100, 0).level).toBe('calm');
    expect(classifyDeviation(Number.NaN, 200).level).toBe('alert');
  });

  it('places the marker on a centred, clamped scale', () => {
    expect(deviationPosition(0)).toBe(50);
    expect(deviationPosition(0.1)).toBe(75);
    expect(deviationPosition(-1)).toBe(0);
    expect(deviationPosition(Number.NaN)).toBe(50);
  });
});

describe('nudgeIntensity / formatFtpChange', () => {
  it('steps by 5 % within 50–150 %', () => {
    expect(nudgeIntensity(1, 1)).toBe(1.05);
    expect(nudgeIntensity(1.05, -1)).toBe(1);
    expect(nudgeIntensity(1.5, 1)).toBe(1.5);
    expect(nudgeIntensity(0.5, -1)).toBe(0.5);
    expect(nudgeIntensity(1.03, 1)).toBe(1.1);
  });

  it('formats the FTP change', () => {
    expect(formatFtpChange(200, 238)).toBe('+38 W (+19 %)');
    expect(formatFtpChange(250, 240)).toBe('−10 W (−4 %)');
    expect(formatFtpChange(200, 200)).toBe('no change');
  });
});

describe('chartGeometry', () => {
  it('spans the width and stays inside the box', () => {
    const g = chartGeometry(sample);
    const all = g.shapes.flatMap((s) => corners(s.points));
    expect(Math.min(...all.map(([x]) => x))).toBe(0);
    expect(Math.max(...all.map(([x]) => x))).toBe(CHART_WIDTH);
    for (const [, y] of all) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(CHART_HEIGHT);
    }
    expect(g.ftpY).toBeGreaterThan(0);
    expect(g.ftpY).toBeLessThan(CHART_HEIGHT);
  });

  it('slices ramps so their colour follows the zones', () => {
    const g = chartGeometry(sample);
    // 120 s ramp → 4 slices of 30 s; 50 % → 80 % runs through zones 1, 2 and 3.
    const ramp = g.shapes.slice(0, 4);
    expect(new Set(ramp.map((s) => s.zone))).toEqual(new Set([1, 2, 3]));
    const rising = ramp.map((s) => corners(s.points)[2]![1]);
    expect([...rising].sort((a, b) => b - a)).toEqual(rising); // higher power = smaller y
  });

  it('draws free ride as a neutral block and steady blocks by zone', () => {
    const g = chartGeometry(sample);
    expect(g.shapes[4]?.zone).toBe(5); // 120 % = zone 5
    expect(g.shapes[5]?.zone).toBeNull();
    expect(g.shapes.filter((s) => s.zone === null)).toHaveLength(1);
  });

  it('crops open-ended workouts at the horizon', () => {
    const horizonS = openEndedHorizonS(RAMP_TEST.workout);
    expect(horizonS).toBeLessThan(RAMP_TEST.workout.steps.length * 60 + 300);
    const g = chartGeometry(RAMP_TEST.workout, { horizonS });
    expect(g.horizonS).toBe(horizonS);
    const maxX = Math.max(...g.shapes.flatMap((s) => corners(s.points).map(([x]) => x)));
    expect(maxX).toBe(CHART_WIDTH);
  });

  it('positions the progress marker', () => {
    expect(chartProgress(300, 600)).toBe(0.5);
    expect(chartProgress(900, 600)).toBe(1);
    expect(chartProgress(Number.NaN, 600)).toBe(0);
  });
});

describe('library helpers', () => {
  it('drops duplicate ids (the 20-minute test is in both lists)', () => {
    const entries: WorkoutEntry[] = [
      ...FTP_TESTS.map((p) => ({ workout: p.workout, source: 'ftpTest' as const, ftpTest: p })),
      ...BUILTIN_WORKOUTS.map((workout) => ({ workout, source: 'builtin' as const })),
    ];
    const unique = uniqueEntries(entries);
    expect(unique.length).toBeLessThan(entries.length);
    expect(new Set(unique.map((e) => e.workout.id)).size).toBe(unique.length);
    expect(unique.find((e) => e.workout.id === 'builtin-ftp-test-20')?.source).toBe('ftpTest');
  });

  it('lists steps with % FTP and watts', () => {
    const rows = stepRows(sample, 200);
    expect(rows[0]).toEqual({
      label: 'Warm-up',
      duration: '2 min',
      target: '50 % → 80 % FTP · 100 W → 160 W',
    });
    expect(rows[1]?.target).toBe('120 % FTP · 240 W');
    expect(rows[2]?.target).toMatch(/Free ride/);
    expect(rows[3]).toMatchObject({ label: 'Intervals', duration: '2 × (30 s + 30 s)' });
  });

  it('summarises zones and the chart for assistive tech', () => {
    const stats = workoutStats(sample, 200);
    const zones = zoneRows(stats);
    expect(zones.find((z) => z.zone === 0)?.seconds).toBe(60);
    const total = zones.reduce((n, z) => n + z.seconds, 0);
    expect(total).toBe(stats.durationS);
    const text = chartSummary(sample, stats);
    expect(text).toContain('Sample');
    expect(text).toContain('peaks at 120 % FTP');
    expect(text).toContain('free ride');
  });
});
