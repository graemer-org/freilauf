/**
 * Main window bounds memory (`userData/window-state.json`). Kept out of
 * `Settings` because the renderer has no business with it. No Electron imports.
 */
import fs from 'node:fs';
import type { Bounds } from '../shared/contract';
import { writeFileAtomicSync } from './atomicWrite';
import { isBounds, isPlainObject } from './settings';

export interface WindowState {
  bounds: Bounds | null;
  maximized: boolean;
}

export function loadWindowState(filePath: string): WindowState {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (isPlainObject(raw)) {
      return {
        bounds: isBounds(raw.bounds) ? raw.bounds : null,
        maximized: raw.maximized === true,
      };
    }
  } catch {
    // missing or corrupt: start with defaults
  }
  return { bounds: null, maximized: false };
}

export function saveWindowState(filePath: string, state: WindowState): void {
  try {
    writeFileAtomicSync(filePath, JSON.stringify(state));
  } catch (e) {
    console.warn(`[window-state] save failed: ${String(e)}`);
  }
}
