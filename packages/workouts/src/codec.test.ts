import { describe, expect, it } from 'vitest';
import {
  MAX_ENCODED_WORKOUT_BYTES,
  WORKOUT_FILE_EXTENSION,
  WORKOUT_FORMAT,
  decodeWorkout,
  encodeWorkout,
} from './codec';
import { BUILTIN_WORKOUTS, getBuiltinWorkout } from './library';
import type { Workout } from './model';
import { utf8ByteLength } from './zwo';

const sample = getBuiltinWorkout('builtin-sweet-spot-3x12') as Workout;

describe('codec', () => {
  it('round-trips every built-in workout', () => {
    for (const w of BUILTIN_WORKOUTS) {
      const r = decodeWorkout(encodeWorkout(w));
      expect(r.ok && r.workout).toEqual(w);
    }
  });

  it('writes a versioned envelope', () => {
    const env = JSON.parse(encodeWorkout(sample));
    expect(env).toMatchObject({ format: WORKOUT_FORMAT, version: 1, workout: { id: sample.id } });
    expect(WORKOUT_FILE_EXTENSION).toBe('.freilauf-workout.json');
  });

  it('keeps a typical 1 h workout small', () => {
    const sizes = BUILTIN_WORKOUTS.map((w) => utf8ByteLength(encodeWorkout(w)));
    // Sweet spot 3×12 is 64 minutes with cues.
    const bytes = utf8ByteLength(encodeWorkout(sample));
    expect(bytes).toBeLessThan(1500);
    expect(Math.max(...sizes)).toBeLessThan(2048);
  });

  it('refuses to encode an invalid workout', () => {
    expect(() => encodeWorkout({ ...sample, steps: [] })).toThrow(TypeError);
  });

  it('accepts minor versions and drops unknown fields', () => {
    const text = JSON.stringify({
      format: WORKOUT_FORMAT,
      version: 1.3,
      extra: true,
      workout: { ...sample, futureField: 'x' },
    });
    const r = decodeWorkout(text);
    expect(r.ok && r.workout).toEqual(sample);
    expect(decodeWorkout('﻿' + encodeWorkout(sample)).ok).toBe(true);
  });

  const garbage: [string, string][] = [
    ['empty', ''],
    ['not JSON', 'hello'],
    ['truncated', encodeWorkout(sample).slice(0, 50)],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON number', '42'],
    ['wrong format', JSON.stringify({ format: 'other', version: 1, workout: sample })],
    ['missing version', JSON.stringify({ format: WORKOUT_FORMAT, workout: sample })],
    ['string version', JSON.stringify({ format: WORKOUT_FORMAT, version: '1', workout: sample })],
    ['version 2', JSON.stringify({ format: WORKOUT_FORMAT, version: 2, workout: sample })],
    ['version 0', JSON.stringify({ format: WORKOUT_FORMAT, version: 0, workout: sample })],
    ['missing workout', JSON.stringify({ format: WORKOUT_FORMAT, version: 1 })],
    [
      'invalid workout',
      JSON.stringify({
        format: WORKOUT_FORMAT,
        version: 1,
        workout: { ...sample, steps: [{ kind: 'x' }] },
      }),
    ],
    ['__proto__ pollution attempt', '{"__proto__":{"format":"freilauf-workout","version":1}}'],
  ];
  it.each(garbage)('rejects %s', (_, text) => {
    const r = decodeWorkout(text);
    expect(r.ok).toBe(false);
  });

  it('rejects oversize input before parsing', () => {
    const big = JSON.stringify({
      format: WORKOUT_FORMAT,
      version: 1,
      workout: { ...sample, description: 'x'.repeat(MAX_ENCODED_WORKOUT_BYTES) },
    });
    const r = decodeWorkout(big);
    expect(!r.ok && r.errors[0]).toMatch(/larger than/);
    expect(decodeWorkout(undefined as unknown as string).ok).toBe(false);
  });
});
