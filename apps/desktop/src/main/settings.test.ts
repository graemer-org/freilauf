import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/contract';
import {
  applySettingsPatch,
  deepMerge,
  forgetDevice,
  migrateSettings,
  sanitizeSettings,
} from './settings';
import { SettingsStore } from './settingsStore';

describe('deepMerge', () => {
  it('merges objects recursively, replaces arrays, does not mutate', () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 'x' };
    const out = deepMerge(base, { a: { c: [3] } });
    expect(out).toEqual({ a: { b: 1, c: [3] }, d: 'x' });
    expect(base.a.c).toEqual([1, 2]);
  });

  it('lets null replace and ignores undefined', () => {
    expect(
      deepMerge({ a: { x: 1 } as { x: number } | null, b: 2 }, { a: null, b: undefined }),
    ).toEqual({
      a: null,
      b: 2,
    });
  });

  it('ignores prototype-polluting keys', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as unknown;
    const out = deepMerge({ a: 0 }, patch) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('sanitizeSettings', () => {
  it('returns defaults for garbage', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it('fills in keys missing from an older file', () => {
    const s = sanitizeSettings({ rider: { name: 'Anna' } });
    expect(s.rider).toEqual({ ...DEFAULT_SETTINGS.rider, name: 'Anna' });
    expect(s.overlay).toEqual(DEFAULT_SETTINGS.overlay);
  });

  it('replaces only the invalid parts and reports them', () => {
    const problems: string[] = [];
    const s = sanitizeSettings(
      {
        rider: { name: 'Bo', massKg: 'heavy', bikeMassKg: 9 },
        overlay: {
          backdropOpacity: 7,
          bounds: { x: 10, y: 20, width: 'wide', height: 100 },
          tiles: [{ stat: 'power', size: 'm' }, { stat: 'nope', size: 'm' }, 'x'],
          editHotkey: '',
        },
        group: { signallingUrl: 'http://evil' },
        devices: {
          trainer: { id: 'abc', name: 'KICKR' },
          toaster: { id: 'x', name: 'y' },
          heartRate: 5,
        },
        shifting: { buttons: { a: 'shiftUp', b: 'explode', nope: 'none' }, trainerMassKg: 'x' },
      },
      DEFAULT_SETTINGS,
      problems,
    );
    expect(s.rider).toEqual({
      name: 'Bo',
      massKg: DEFAULT_SETTINGS.rider.massKg,
      bikeMassKg: 9,
      ftpW: DEFAULT_SETTINGS.rider.ftpW,
    });
    expect(s.overlay.backdropOpacity).toBe(DEFAULT_SETTINGS.overlay.backdropOpacity);
    expect(s.overlay.bounds).toBeNull();
    expect(s.overlay.tiles).toEqual([{ stat: 'power', size: 'm' }]);
    expect(s.overlay.editHotkey).toBe(DEFAULT_SETTINGS.overlay.editHotkey);
    expect(s.group.signallingUrl).toBe(DEFAULT_SETTINGS.group.signallingUrl);
    expect(s.devices).toEqual({ trainer: { id: 'abc', name: 'KICKR' } });
    expect(s.shifting.buttons).toEqual({ a: 'shiftUp' });
    expect(s.shifting.trainerMassKg).toBeNull();
    expect(problems.length).toBeGreaterThanOrEqual(8);
  });

  it('accepts and rounds valid bounds', () => {
    const s = sanitizeSettings({
      overlay: { bounds: { x: 10.4, y: -20.6, width: 300.2, height: 200 } },
    });
    expect(s.overlay.bounds).toEqual({ x: 10, y: -21, width: 300, height: 200 });
  });

  it('does not share references with the fallback', () => {
    const s = sanitizeSettings({});
    s.overlay.tiles.push({ stat: 'gear', size: 's' });
    expect(DEFAULT_SETTINGS.overlay.tiles).toHaveLength(7);
  });
});

describe('group.signallingUrl', () => {
  it('defaults to none set up and accepts clearing it', () => {
    expect(DEFAULT_SETTINGS.group.signallingUrl).toBe('');
    const set = applySettingsPatch(DEFAULT_SETTINGS, {
      group: { signallingUrl: 'wss://nas.example.org/signal' },
    });
    expect(set.group.signallingUrl).toBe('wss://nas.example.org/signal');
    expect(applySettingsPatch(set, { group: { signallingUrl: '  ' } }).group.signallingUrl).toBe(
      '',
    );
    const problems: string[] = [];
    expect(
      applySettingsPatch(set, { group: { signallingUrl: 'https://x' } }, problems).group
        .signallingUrl,
    ).toBe('wss://nas.example.org/signal');
    expect(problems).toHaveLength(1);
  });

  it('migrates the old localhost default to none, and only on load', () => {
    const old = { rider: { name: 'Old' }, group: { signallingUrl: 'ws://localhost:8787' } };
    const migrated = migrateSettings(old);
    expect(sanitizeSettings(migrated).group.signallingUrl).toBe('');
    expect(sanitizeSettings(migrated).rider.name).toBe('Old');
    expect(old.group.signallingUrl).toBe('ws://localhost:8787'); // not mutated
    // The explicit "server on this computer" choice and real servers stay.
    for (const url of ['ws://127.0.0.1:8787', 'wss://nas.example.org/signal']) {
      expect(sanitizeSettings(migrateSettings({ group: { signallingUrl: url } })).group).toEqual({
        signallingUrl: url,
      });
    }
    // In the browser the fallback is the page's own /signal.
    const web = deepMerge(DEFAULT_SETTINGS, { group: { signallingUrl: 'wss://nas/signal' } });
    expect(sanitizeSettings(migrateSettings(old), web).group.signallingUrl).toBe(
      'wss://nas/signal',
    );
    for (const raw of [null, 5, {}, { group: 3 }]) expect(migrateSettings(raw)).toBe(raw);
  });
});

describe('applySettingsPatch', () => {
  it('deep-merges, arrays replace', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      rider: { massKg: 80 },
      overlay: { tiles: [{ stat: 'power', size: 'l' }] },
    });
    expect(next.rider).toEqual({ ...DEFAULT_SETTINGS.rider, massKg: 80 });
    expect(next.overlay.tiles).toEqual([{ stat: 'power', size: 'l' }]);
    expect(next.overlay.showGroup).toBe(true);
  });

  it('keeps the current value for invalid patch fields', () => {
    const current = applySettingsPatch(DEFAULT_SETTINGS, { rider: { massKg: 90 } });
    const next = applySettingsPatch(current, { rider: { massKg: -1, name: 'X' } });
    expect(next.rider.massKg).toBe(90);
    expect(next.rider.name).toBe('X');
  });

  it('merges remembered devices and can set bounds to null', () => {
    let s = applySettingsPatch(DEFAULT_SETTINGS, { devices: { trainer: { id: 't', name: 'T' } } });
    s = applySettingsPatch(s, { devices: { heartRate: { id: 'h', name: 'H' } } });
    expect(Object.keys(s.devices).sort()).toEqual(['heartRate', 'trainer']);
    s = applySettingsPatch(s, { overlay: { bounds: { x: 0, y: 0, width: 200, height: 100 } } });
    s = applySettingsPatch(s, { overlay: { bounds: null } });
    expect(s.overlay.bounds).toBeNull();
    s = forgetDevice(s, 'trainer');
    expect(Object.keys(s.devices)).toEqual(['heartRate']);
  });

  it('rejects a non-object patch', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, 'x')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('SettingsStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-settings-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts with defaults when there is no file and persists updates', () => {
    const file = path.join(dir, 'settings.json');
    const store = new SettingsStore(file, { log: () => undefined });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const changes = vi.fn();
    store.onChange(changes);
    store.update({ rider: { name: 'Persisted' } });
    expect(changes).toHaveBeenCalledTimes(1);
    store.flushSync();
    const reloaded = new SettingsStore(file, { log: () => undefined });
    expect(reloaded.get().rider.name).toBe('Persisted');
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it('does not notify or write when nothing changed', () => {
    const file = path.join(dir, 'settings.json');
    const store = new SettingsStore(file, { log: () => undefined });
    const changes = vi.fn();
    store.onChange(changes);
    store.update({ rider: { name: DEFAULT_SETTINGS.rider.name } });
    store.flushSync();
    expect(changes).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps a .bak of an unparseable file and falls back to defaults', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{ "rider": { nope');
    const log = vi.fn();
    const store = new SettingsStore(file, { log });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe('{ "rider": { nope');
    expect(log).toHaveBeenCalled();
  });

  it('keeps valid parts of a hand-edited file', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ rider: { name: 'Hand', massKg: 'x' }, overlay: { visible: false } }),
    );
    const store = new SettingsStore(file, { log: () => undefined });
    expect(store.get().rider).toEqual({ ...DEFAULT_SETTINGS.rider, name: 'Hand' });
    expect(store.get().overlay.visible).toBe(false);
  });

  it('loads a file with the old localhost default as "none set up"', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ group: { signallingUrl: 'ws://localhost:8787' } }));
    expect(new SettingsStore(file, { log: () => undefined }).get().group.signallingUrl).toBe('');
  });

  it('debounces writes', async () => {
    vi.useFakeTimers();
    try {
      const file = path.join(dir, 'settings.json');
      const store = new SettingsStore(file, { debounceMs: 100, log: () => undefined });
      store.update({ rider: { massKg: 70 } });
      store.update({ rider: { massKg: 71 } });
      expect(fs.existsSync(file)).toBe(false);
      await vi.advanceTimersByTimeAsync(150);
      expect(
        (JSON.parse(fs.readFileSync(file, 'utf8')) as typeof DEFAULT_SETTINGS).rider.massKg,
      ).toBe(71);
    } finally {
      vi.useRealTimers();
    }
  });
});
