import type { Settings } from '../../../shared/contract';
import { DEFAULT_SETTINGS } from '../../../shared/contract';

/**
 * Small UI-only memory kept in the window's local storage (never in the settings file): whether
 * the first-run questions were answered or skipped, and what the last ride was, so the start
 * screen can offer it again. Losing it is harmless.
 */
export interface UiPrefs {
  /** The first-run questions were answered or skipped: never ask again. */
  firstRunDone: boolean;
  /** The workout and route the last ride started with (null = none). */
  lastWorkoutId: string | null;
  lastRouteId: string | null;
}

export const PREFS_KEY = 'freilauf.ui.v1';

const DEFAULT_PREFS: UiPrefs = { firstRunDone: false, lastWorkoutId: null, lastRouteId: null };

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): PrefsStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage access denied
  }
}

const idOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;

export function readPrefs(store: PrefsStorage | null = storage()): UiPrefs {
  try {
    const raw = store?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object') return { ...DEFAULT_PREFS };
    return {
      firstRunDone: v.firstRunDone === true,
      lastWorkoutId: idOrNull(v.lastWorkoutId),
      lastRouteId: idOrNull(v.lastRouteId),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(
  patch: Partial<UiPrefs>,
  store: PrefsStorage | null = storage(),
): UiPrefs {
  const next = { ...readPrefs(store), ...patch };
  try {
    store?.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // full or blocked: remembered for nothing, which is fine
  }
  return next;
}

/**
 * Ask the first-run questions? Only while they were never answered and the rider data is still
 * the untouched default — someone who already set a name, mass or FTP is not asked.
 */
export function needsFirstRun(prefs: UiPrefs, rider: Settings['rider'] | undefined): boolean {
  if (prefs.firstRunDone || !rider) return false;
  const d = DEFAULT_SETTINGS.rider;
  return rider.name === d.name && rider.massKg === d.massKg && rider.ftpW === d.ftpW;
}
