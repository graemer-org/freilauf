/**
 * What changed in a settings update, for the diagnostic log. Pure
 * (unit-tested in settingsLog.test.ts). Values of personal settings (the
 * rider's name, mass, FTP and the group signalling URL) are never included,
 * only the fact that they changed.
 */
import type { Settings } from '../shared/contract';
import { isPlainObject } from './settings';

/** Key paths (and everything below them) whose values stay out of the log. */
export const PERSONAL_SETTING_PATHS: readonly string[] = ['rider', 'group'];

export function isPersonalPath(p: string): boolean {
  return PERSONAL_SETTING_PATHS.some((x) => p === x || p.startsWith(`${x}.`));
}

/** Dotted paths of every leaf that differs; arrays are compared as a whole. */
export function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const out: string[] = [];
    for (const k of [...keys].sort()) {
      out.push(...changedPaths(before[k], after[k], prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix || '(root)'];
}

export function getPath(obj: unknown, p: string): unknown {
  let cur: unknown = obj;
  for (const part of p.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export interface SettingsChange {
  changed: string[];
  /** New values of the non-personal changed paths ("(removed)" when a key went away). */
  values: Record<string, unknown>;
}

export function describeSettingsChange(before: Settings, after: Settings): SettingsChange {
  const changed = changedPaths(before, after);
  const values: Record<string, unknown> = {};
  for (const p of changed) {
    if (isPersonalPath(p)) continue;
    const v = getPath(after, p);
    values[p] = v === undefined ? '(removed)' : v;
  }
  return { changed, values };
}
