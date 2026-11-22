import type { FtpTestProtocol, Workout } from '@freilauf/workouts';
import {
  BUILTIN_WORKOUTS,
  FTP_TESTS,
  WORKOUT_FILE_EXTENSION,
  decodeWorkout,
  encodeWorkout,
  parseZwo,
  workoutToZwo,
} from '@freilauf/workouts';

export interface WorkoutEntry {
  workout: Workout;
  source: 'builtin' | 'ftpTest' | 'imported';
  /** Set for FTP tests; needed to evaluate the result after the ride. */
  ftpTest?: FtpTestProtocol;
}

/** Where imported workouts are kept; localStorage in the app, a Map in tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ImportResult =
  | { ok: true; workout: Workout; warnings: string[] }
  | { ok: false; errors: string[] };

const STORAGE_KEY = 'freilauf.workouts.v1';
const MAX_IMPORTED = 200;

/** Built-in workouts, FTP tests and the rider's imported workouts. */
export class WorkoutLibrary {
  readonly #storage: KeyValueStorage | null;
  #imported: Workout[] = [];

  constructor(storage: KeyValueStorage | null) {
    this.#storage = storage;
    this.#load();
  }

  list(): WorkoutEntry[] {
    return [
      ...FTP_TESTS.map((p): WorkoutEntry => ({ workout: p.workout, source: 'ftpTest', ftpTest: p })),
      ...BUILTIN_WORKOUTS.map((workout): WorkoutEntry => ({ workout, source: 'builtin' })),
      ...this.#imported.map((workout): WorkoutEntry => ({ workout, source: 'imported' })),
    ];
  }

  get(id: string): WorkoutEntry | null {
    return this.list().find((e) => e.workout.id === id) ?? null;
  }

  /** Accepts our own share format or the common .zwo XML, decided by content. */
  importText(text: string): ImportResult {
    const looksLikeXml = text.trimStart().replace(/^﻿/, '').startsWith('<');
    let workout: Workout;
    let warnings: string[] = [];
    if (looksLikeXml) {
      const parsed = parseZwo(text);
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      ({ workout, warnings } = parsed);
    } else {
      const parsed = decodeWorkout(text);
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      workout = parsed.workout;
    }
    const result = this.add(workout);
    return result.ok ? { ok: true, workout: result.workout, warnings } : result;
  }

  /** Adds (or replaces, by id) an imported workout, e.g. one received from the group. */
  add(workout: Workout): ImportResult {
    // Never let an import shadow a built-in entry.
    if (this.list().some((e) => e.source !== 'imported' && e.workout.id === workout.id)) {
      return { ok: true, workout, warnings: [] };
    }
    const others = this.#imported.filter((w) => w.id !== workout.id);
    if (others.length >= MAX_IMPORTED) {
      return { ok: false, errors: [`The library is full (${MAX_IMPORTED} imported workouts).`] };
    }
    this.#imported = [...others, workout];
    this.#save();
    return { ok: true, workout, warnings: [] };
  }

  remove(id: string): boolean {
    const before = this.#imported.length;
    this.#imported = this.#imported.filter((w) => w.id !== id);
    if (this.#imported.length === before) return false;
    this.#save();
    return true;
  }

  /** The text to save to a file or send to friends. */
  export(id: string, format: 'freilauf' | 'zwo'): { fileName: string; text: string } | null {
    const entry = this.get(id);
    if (!entry) return null;
    const base = entry.workout.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'workout';
    return format === 'zwo'
      ? { fileName: `${base}.zwo`, text: workoutToZwo(entry.workout) }
      : { fileName: `${base}${WORKOUT_FILE_EXTENSION}`, text: encodeWorkout(entry.workout) };
  }

  #load(): void {
    let raw: string | null = null;
    try {
      raw = this.#storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return; // storage blocked: the library still works for this session
    }
    if (!raw) return;
    try {
      const items: unknown = JSON.parse(raw);
      if (!Array.isArray(items)) return;
      for (const item of items.slice(0, MAX_IMPORTED)) {
        if (typeof item !== 'string') continue;
        const decoded = decodeWorkout(item);
        if (decoded.ok) this.#imported.push(decoded.workout);
      }
    } catch {
      // Corrupt entry: start with an empty imported list rather than failing.
    }
  }

  #save(): void {
    try {
      this.#storage?.setItem(STORAGE_KEY, JSON.stringify(this.#imported.map(encodeWorkout)));
    } catch {
      // Quota or blocked storage: keep the in-memory copy.
    }
  }
}
