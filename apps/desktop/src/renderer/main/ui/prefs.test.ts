import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { needsFirstRun, PREFS_KEY, readPrefs, writePrefs } from './prefs';
import type { PrefsStorage } from './prefs';

function memory(
  initial: Record<string, string> = {},
): PrefsStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('UI prefs', () => {
  it('defaults when nothing (or garbage) is stored, or storage is missing', () => {
    const empty = { firstRunDone: false, lastWorkoutId: null, lastRouteId: null };
    expect(readPrefs(memory())).toEqual(empty);
    expect(readPrefs(memory({ [PREFS_KEY]: '{not json' }))).toEqual(empty);
    expect(readPrefs(memory({ [PREFS_KEY]: '{"firstRunDone":"yes","lastWorkoutId":5}' }))).toEqual(
      empty,
    );
    expect(readPrefs(null)).toEqual(empty);
  });

  it('merges writes and reads them back', () => {
    const store = memory();
    writePrefs({ lastWorkoutId: 'builtin-openers-30' }, store);
    writePrefs({ firstRunDone: true }, store);
    expect(readPrefs(store)).toEqual({
      firstRunDone: true,
      lastWorkoutId: 'builtin-openers-30',
      lastRouteId: null,
    });
  });

  it('survives a storage that throws', () => {
    const broken: PrefsStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(writePrefs({ firstRunDone: true }, broken).firstRunDone).toBe(true);
    expect(readPrefs(broken).firstRunDone).toBe(false);
  });

  it('asks the first-run questions only once, and only with untouched rider data', () => {
    const rider = structuredClone(DEFAULT_SETTINGS.rider);
    const fresh = readPrefs(memory());
    expect(needsFirstRun(fresh, rider)).toBe(true);
    expect(needsFirstRun({ ...fresh, firstRunDone: true }, rider)).toBe(false);
    expect(needsFirstRun(fresh, { ...rider, name: 'Ana' })).toBe(false);
    expect(needsFirstRun(fresh, { ...rider, ftpW: 250 })).toBe(false);
    expect(needsFirstRun(fresh, undefined)).toBe(false);
  });
});
