import { BUILTIN_WORKOUTS, FTP_TESTS, encodeWorkout } from '@freilauf/workouts';
import type { Workout } from '@freilauf/workouts';
import { describe, expect, it } from 'vitest';
import { WorkoutLibrary } from './workoutLibrary';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const custom: Workout = {
  id: 'my-2x5',
  name: 'My 2×5 / test',
  steps: [
    { kind: 'steady', durationS: 300, power: 0.6 },
    { kind: 'intervals', repeat: 2, onDurationS: 300, onPower: 1, offDurationS: 120, offPower: 0.5 },
  ],
};

const ZWO = `<?xml version="1.0"?>
<workout_file><name>Imported ride</name><workout>
<Warmup Duration="300" PowerLow="0.4" PowerHigh="0.7"/>
<SteadyState Duration="600" Power="0.9"/>
</workout></workout_file>`;

describe('WorkoutLibrary', () => {
  it('lists FTP tests and built-ins without any storage', () => {
    const library = new WorkoutLibrary(null);
    const list = library.list();
    expect(list).toHaveLength(FTP_TESTS.length + BUILTIN_WORKOUTS.length);
    expect(list.filter((e) => e.source === 'ftpTest').every((e) => e.ftpTest)).toBe(true);
    expect(library.get(BUILTIN_WORKOUTS[0]!.id)?.source).toBe('builtin');
    expect(library.get('nope')).toBeNull();
  });

  it('imports both formats, persists them and reloads them', () => {
    const storage = memoryStorage();
    const library = new WorkoutLibrary(storage);
    expect(library.importText(encodeWorkout(custom))).toMatchObject({ ok: true });
    const zwo = library.importText(ZWO);
    expect(zwo.ok && zwo.workout.name).toBe('Imported ride');

    const reloaded = new WorkoutLibrary(storage);
    expect(reloaded.list().filter((e) => e.source === 'imported')).toHaveLength(2);
    expect(reloaded.get('my-2x5')?.workout.steps).toHaveLength(2);
  });

  it('re-importing the same workout replaces it instead of duplicating', () => {
    const library = new WorkoutLibrary(memoryStorage());
    library.importText(encodeWorkout(custom));
    library.importText(encodeWorkout({ ...custom, name: 'Renamed' }));
    const imported = library.list().filter((e) => e.source === 'imported');
    expect(imported).toHaveLength(1);
    expect(imported[0]!.workout.name).toBe('Renamed');
  });

  it('rejects garbage with errors and leaves the library unchanged', () => {
    const storage = memoryStorage();
    const library = new WorkoutLibrary(storage);
    for (const bad of ['', 'hello', '{"format":"x"}', '<workout_file><workout>', '<!DOCTYPE x><a/>']) {
      const result = library.importText(bad);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors.length).toBeGreaterThan(0);
    }
    expect(storage.map.size).toBe(0);
  });

  it('does not let an import shadow or delete a built-in', () => {
    const library = new WorkoutLibrary(memoryStorage());
    const builtin = BUILTIN_WORKOUTS[0]!;
    library.add({ ...builtin, name: 'Hijacked' });
    expect(library.get(builtin.id)?.workout.name).toBe(builtin.name);
    expect(library.remove(builtin.id)).toBe(false);
  });

  it('removes imported workouts and exports in both formats with safe file names', () => {
    const library = new WorkoutLibrary(memoryStorage());
    library.importText(encodeWorkout(custom));
    const native = library.export('my-2x5', 'freilauf')!;
    expect(native.fileName).toBe('My 25  test.freilauf-workout.json');
    expect(new WorkoutLibrary(memoryStorage()).importText(native.text).ok).toBe(true);
    const zwo = library.export('my-2x5', 'zwo')!;
    expect(zwo.fileName.endsWith('.zwo')).toBe(true);
    expect(zwo.text).toContain('<workout_file>');
    expect(library.remove('my-2x5')).toBe(true);
    expect(library.export('my-2x5', 'zwo')).toBeNull();
  });

  it('survives corrupt or blocked storage', () => {
    const storage = memoryStorage();
    storage.map.set('freilauf.workouts.v1', '{not json');
    expect(new WorkoutLibrary(storage).list().some((e) => e.source === 'imported')).toBe(false);
    storage.map.set('freilauf.workouts.v1', JSON.stringify(['garbage', 5, encodeWorkout(custom)]));
    expect(new WorkoutLibrary(storage).list().filter((e) => e.source === 'imported')).toHaveLength(1);
    const blocked = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const library = new WorkoutLibrary(blocked);
    expect(library.importText(encodeWorkout(custom)).ok).toBe(true);
    expect(library.get('my-2x5')).not.toBeNull();
  });
});
