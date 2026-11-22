import { describe, expect, it } from 'vitest';
import type { Workout } from './model';
import { WORKOUT_LIMITS, stepDurationS, totalDurationS, validateWorkout } from './model';

const base = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'w1',
  name: 'Test',
  steps,
  ...extra,
});
const steady = (extra: Record<string, unknown> = {}) => ({
  kind: 'steady',
  durationS: 60,
  power: 0.75,
  ...extra,
});

describe('validateWorkout', () => {
  it('accepts every step kind and returns a clean copy', () => {
    const input = base(
      [
        { kind: 'ramp', durationS: 300, powerStart: 0.4, powerEnd: 0.7, cadenceRpm: 90 },
        steady({ cadenceRpm: 95, label: 'Block', cues: [{ atS: 10, message: 'Go' }] }),
        {
          kind: 'intervals',
          repeat: 5,
          onDurationS: 30,
          onPower: 1.2,
          offDurationS: 30,
          offPower: 0.5,
          onCadenceRpm: 100,
          offCadenceRpm: 85,
        },
        { kind: 'freeRide', durationS: 600, gradePercent: 2, expectedPower: 0.9 },
      ],
      { description: 'd', author: 'a', tags: ['VO2', 'vo2', 'x'], unknownField: 1 },
    );
    const r = validateWorkout(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workout).not.toBe(input);
    expect(r.workout).not.toHaveProperty('unknownField');
    expect(r.workout.tags).toEqual(['vo2', 'x']);
    expect(r.workout.steps).toHaveLength(4);
    expect(r.workout.steps[1]).toEqual(
      steady({ cadenceRpm: 95, label: 'Block', cues: [{ atS: 10, message: 'Go' }] }),
    );
    expect(Object.keys(r.workout).at(-1)).toBe('steps');
  });

  it('strips control and bidi characters, collapses whitespace and caps lengths', () => {
    const r = validateWorkout(
      base([steady()], {
        name: '  Hello\u0000‮ World\n\tagain  ',
        description: 'line 1\r\nline 2\u0007\n\n\n\nline 3',
        author: 'x'.repeat(500),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workout.name).toBe('Hello World again');
    expect(r.workout.description).toBe('line 1\nline 2\n\nline 3');
    expect(r.workout.author).toHaveLength(WORKOUT_LIMITS.maxAuthorLength);
  });

  it('does not split surrogate pairs when truncating', () => {
    const r = validateWorkout(base([steady()], { name: '🚴'.repeat(100) }));
    expect(r.ok && Array.from(r.workout.name)).toHaveLength(WORKOUT_LIMITS.maxNameLength);
  });

  it('sorts cues', () => {
    const r = validateWorkout(
      base([
        steady({
          cues: [
            { atS: 30, message: 'b' },
            { atS: 5, message: 'a' },
          ],
        }),
      ]),
    );
    expect(r.ok && r.workout.steps[0]?.cues).toEqual([
      { atS: 5, message: 'a' },
      { atS: 30, message: 'b' },
    ]);
  });

  const rejects: [string, unknown][] = [
    ['null', null],
    ['a string', 'workout'],
    ['an array', []],
    ['missing id', { name: 'x', steps: [steady()] }],
    ['bad id characters', base([steady()], { id: 'a/b' })],
    ['too long id', base([steady()], { id: 'a'.repeat(65) })],
    ['missing name', { id: 'x', steps: [steady()] }],
    ['name only control chars', base([steady()], { name: '\u0001\u0002' })],
    ['number name', base([steady()], { name: 42 })],
    ['no steps', base([])],
    ['steps not an array', base([], { steps: {} })],
    ['too many steps', base(Array.from({ length: 501 }, () => steady({ durationS: 1 })))],
    ['unknown kind', base([{ kind: 'sprint', durationS: 10 }])],
    ['step not an object', base([42])],
    ['power above 300 %', base([steady({ power: 3.01 })])],
    ['negative power', base([steady({ power: -0.1 })])],
    ['NaN power', base([steady({ power: Number.NaN })])],
    ['Infinity duration', base([steady({ durationS: Number.POSITIVE_INFINITY })])],
    ['string power', base([steady({ power: '0.7' })])],
    ['zero duration', base([steady({ durationS: 0 })])],
    ['fractional duration', base([steady({ durationS: 1.5 })])],
    ['step over 4 h', base([steady({ durationS: 4 * 3600 + 1 })])],
    ['total over 12 h', base(Array.from({ length: 4 }, () => steady({ durationS: 4 * 3600 })))],
    ['cadence too high', base([steady({ cadenceRpm: 250 })])],
    ['ramp missing end', base([{ kind: 'ramp', durationS: 60, powerStart: 0.5 }])],
    [
      'repeat 0',
      base([
        {
          kind: 'intervals',
          repeat: 0,
          onDurationS: 1,
          onPower: 1,
          offDurationS: 1,
          offPower: 0.5,
        },
      ]),
    ],
    [
      'repeat 101',
      base([
        {
          kind: 'intervals',
          repeat: 101,
          onDurationS: 1,
          onPower: 1,
          offDurationS: 1,
          offPower: 0.5,
        },
      ]),
    ],
    ['free ride grade 30 %', base([{ kind: 'freeRide', durationS: 60, gradePercent: 30 }])],
    ['cue after step end', base([steady({ cues: [{ atS: 60, message: 'late' }] })])],
    ['cue empty message', base([steady({ cues: [{ atS: 1, message: ' ' }] })])],
    ['cues not an array', base([steady({ cues: 'x' })])],
    [
      'too many cues',
      base([steady({ cues: Array.from({ length: 51 }, () => ({ atS: 1, message: 'x' })) })]),
    ],
    ['tags not strings', base([steady()], { tags: [1] })],
    ['too many tags', base([steady()], { tags: Array.from({ length: 17 }, (_, i) => `t${i}`) })],
  ];
  it.each(rejects)('rejects %s', (_, input) => {
    const r = validateWorkout(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('accepts the limits exactly', () => {
    const r = validateWorkout(
      base([
        steady({ durationS: 4 * 3600, power: 3 }),
        steady({ durationS: 4 * 3600, power: 0 }),
        steady({ durationS: 4 * 3600 }),
      ]),
    );
    expect(r.ok).toBe(true);
  });

  it('never throws on hostile objects', () => {
    const hostile = {
      id: 'x',
      name: 'x',
      get steps(): unknown {
        throw new Error('boom');
      },
    };
    const proxy = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom');
        },
      },
    );
    expect(validateWorkout(hostile).ok).toBe(false);
    expect(validateWorkout(proxy).ok).toBe(false);
  });

  it('reports errors with paths', () => {
    const r = validateWorkout(base([steady(), steady({ power: 9 })]));
    expect(!r.ok && r.errors[0]).toContain('steps[1].power');
  });
});

describe('durations', () => {
  it('computes step and total durations', () => {
    const w: Workout = {
      id: 'x',
      name: 'x',
      steps: [
        { kind: 'steady', durationS: 60, power: 0.5 },
        {
          kind: 'intervals',
          repeat: 3,
          onDurationS: 30,
          onPower: 1,
          offDurationS: 15,
          offPower: 0.5,
        },
      ],
    };
    expect(stepDurationS(w.steps[1]!)).toBe(135);
    expect(totalDurationS(w)).toBe(195);
  });
});
