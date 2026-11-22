import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKOUTS, getBuiltinWorkout } from './library';
import { validateWorkout } from './model';
import { workoutStats } from './timeline';

describe('built-in library', () => {
  it('contains 6–8 workouts with unique ids and one-line descriptions', () => {
    expect(BUILTIN_WORKOUTS.length).toBeGreaterThanOrEqual(6);
    expect(BUILTIN_WORKOUTS.length).toBeLessThanOrEqual(8);
    expect(new Set(BUILTIN_WORKOUTS.map((w) => w.id)).size).toBe(BUILTIN_WORKOUTS.length);
    for (const w of BUILTIN_WORKOUTS) {
      expect(w.description, w.id).toBeTruthy();
      expect(w.description).not.toContain('\n');
      expect(w.id.startsWith('builtin-')).toBe(true);
    }
  });

  it.each(BUILTIN_WORKOUTS.map((w) => [w.id, w] as const))('%s validates unchanged', (_, w) => {
    const r = validateWorkout(w);
    expect(r.ok && r.workout).toEqual(w);
  });

  it.each(BUILTIN_WORKOUTS.map((w) => [w.id, w] as const))('%s has sensible stats', (_, w) => {
    const s = workoutStats(w, 250);
    expect(s.durationS).toBeGreaterThanOrEqual(25 * 60);
    expect(s.durationS).toBeLessThanOrEqual(90 * 60);
    expect(s.intensityFactor).toBeGreaterThan(0.55);
    expect(s.intensityFactor).toBeLessThan(1.0);
    expect(s.tss).toBeGreaterThan(15);
    expect(s.tss).toBeLessThan(120);
  });

  it('finds workouts by id', () => {
    expect(getBuiltinWorkout('builtin-threshold-2x20')?.name).toBe('Threshold 2×20');
    expect(getBuiltinWorkout('nope')).toBeUndefined();
  });
});
