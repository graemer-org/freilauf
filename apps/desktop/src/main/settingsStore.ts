/**
 * Settings persistence: `settings.json` in userData. Loaded synchronously at
 * start (windows need it before they are created), saved debounced and
 * atomically. No Electron imports (unit-tested with a temp dir).
 */
import fs from 'node:fs';
import type { DeviceKind } from '@freilauf/devices';
import type { DeepPartial, Settings } from '../shared/contract';
import { DEFAULT_SETTINGS } from '../shared/contract';
import { writeFileAtomicSync } from './atomicWrite';
import { applySettingsPatch, forgetDevice, migrateSettings, sanitizeSettings } from './settings';

export interface SettingsStoreOptions {
  debounceMs?: number;
  log?: (msg: string) => void;
}

export class SettingsStore {
  private current: Settings;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private readonly listeners = new Set<(s: Settings) => void>();
  private readonly debounceMs: number;
  private readonly log: (msg: string) => void;

  readonly filePath: string;

  constructor(filePath: string, options: SettingsStoreOptions = {}) {
    this.filePath = filePath;
    this.debounceMs = options.debounceMs ?? 300;
    this.log = options.log ?? ((m) => console.warn(`[settings] ${m}`));
    this.current = this.load();
  }

  private load(): Settings {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.log(`could not read ${this.filePath}: ${String(e)}`);
      return sanitizeSettings(undefined, DEFAULT_SETTINGS);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    } catch (e) {
      const bak = `${this.filePath}.bak`;
      this.log(
        `unparseable settings file (${String(e)}); keeping a copy at ${bak} and using defaults`,
      );
      try {
        fs.copyFileSync(this.filePath, bak);
      } catch (copyErr) {
        this.log(`could not write ${bak}: ${String(copyErr)}`);
      }
      return sanitizeSettings(undefined, DEFAULT_SETTINGS);
    }
    const problems: string[] = [];
    const settings = sanitizeSettings(migrateSettings(raw), DEFAULT_SETTINGS, problems);
    if (problems.length > 0) this.log(`ignored invalid settings: ${problems.join('; ')}`);
    return settings;
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  update(patch: DeepPartial<Settings> | unknown): Settings {
    const problems: string[] = [];
    const next = applySettingsPatch(this.current, patch, problems);
    if (problems.length > 0) this.log(`rejected parts of update: ${problems.join('; ')}`);
    return this.set(next);
  }

  forgetDevice(kind: DeviceKind | unknown): Settings {
    return this.set(forgetDevice(this.current, kind));
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(next: Settings): Settings {
    const changed = JSON.stringify(next) !== JSON.stringify(this.current);
    this.current = next;
    if (changed) {
      this.schedule();
      for (const l of this.listeners) {
        try {
          l(this.get());
        } catch (e) {
          this.log(`listener failed: ${String(e)}`);
        }
      }
    }
    return this.get();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, this.debounceMs);
  }

  /**
   * Writes pending changes. Synchronous on purpose: the file is a few KB, the
   * write is debounced, and a single synchronous writer can never land an older
   * snapshot after a newer one (also on quit).
   */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeFileAtomicSync(this.filePath, `${JSON.stringify(this.current, null, 2)}\n`);
    } catch (e) {
      this.log(`save failed: ${String(e)}`);
    }
  }
}
