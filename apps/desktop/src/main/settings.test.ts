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
        useOwnServer: false,
        signallingUrl: url,
        relayUrls: [],
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

describe('power-ups', () => {
  it('are on by default, challenges too, and the side buttons use them', () => {
    expect(DEFAULT_SETTINGS.powerUps).toEqual({ enabled: true, challenges: true });
    expect(DEFAULT_SETTINGS.shifting.buttons.powerUpLeft).toBe('usePowerUp');
    expect(DEFAULT_SETTINGS.shifting.buttons.powerUpRight).toBe('usePowerUp');
  });

  it('validates the switches', () => {
    const problems: string[] = [];
    const s = sanitizeSettings(
      { powerUps: { enabled: false, challenges: 'yes' } },
      undefined,
      problems,
    );
    expect(s.powerUps).toEqual({ enabled: false, challenges: true });
    expect(problems.some((p) => p.startsWith('powerUps.challenges'))).toBe(true);
  });

  it('settings from before power-ups map the side buttons to "Use power-up" where they did nothing', () => {
    const old = {
      rider: { name: 'Old' },
      shifting: {
        buttons: { a: 'startPause', powerUpLeft: 'none', shiftUpRight: 'shiftUp' },
      },
    };
    const s = sanitizeSettings(migrateSettings(old));
    expect(s.shifting.buttons).toEqual({
      a: 'startPause',
      shiftUpRight: 'shiftUp',
      powerUpLeft: 'usePowerUp',
      powerUpRight: 'usePowerUp',
    });
    expect(s.powerUps).toEqual({ enabled: true, challenges: true });
    expect(old.shifting.buttons.powerUpLeft).toBe('none'); // not mutated
  });

  it('keeps a custom action on a side button', () => {
    const old = { shifting: { buttons: { powerUpLeft: 'shiftDown', powerUpRight: 'startPause' } } };
    const s = sanitizeSettings(migrateSettings(old));
    expect(s.shifting.buttons.powerUpLeft).toBe('shiftDown');
    expect(s.shifting.buttons.powerUpRight).toBe('startPause');
  });

  it('runs once: after power-ups exist, "Nothing" on a side button is the rider\'s choice', () => {
    const now = {
      powerUps: { enabled: true, challenges: true },
      shifting: { buttons: { powerUpLeft: 'none', powerUpRight: 'none' } },
    };
    const s = sanitizeSettings(migrateSettings(now));
    expect(s.shifting.buttons.powerUpLeft).toBe('none');
    expect(s.shifting.buttons.powerUpRight).toBe('none');
    // A file without buttons simply gets the defaults.
    expect(sanitizeSettings(migrateSettings({})).shifting.buttons.powerUpLeft).toBe('usePowerUp');
  });
});

describe('shifting.levers (analog lever directions)', () => {
  it('defaults follow the mirror-symmetric hypothesis with a 5 % dead zone', () => {
    expect(DEFAULT_SETTINGS.shifting.levers).toEqual({
      left: { positive: 'brake', negative: 'steerLeft' },
      right: { positive: 'steerRight', negative: 'brake' },
      deadzone: 0.05,
    });
  });

  it('a file from before the levers existed loads with the default levers and keeps its buttons', () => {
    const old = { shifting: { physicalRatio: 3, buttons: { a: 'startPause', left: 'shiftUp' } } };
    const s = sanitizeSettings(migrateSettings(old));
    expect(s.shifting.levers).toEqual(DEFAULT_SETTINGS.shifting.levers);
    // (plus the power-up default for the side buttons, see "power-ups" below)
    expect(s.shifting.buttons).toEqual({
      a: 'startPause',
      left: 'shiftUp',
      powerUpLeft: 'usePowerUp',
      powerUpRight: 'usePowerUp',
    });
    expect(s.shifting.physicalRatio).toBe(3);
  });

  it('keeps valid directions, replaces invalid ones and reports them', () => {
    const problems: string[] = [];
    const s = sanitizeSettings(
      {
        shifting: {
          levers: {
            left: { positive: 'steerRight', negative: 'launch' },
            right: 'both',
            deadzone: 0.9,
          },
        },
      },
      DEFAULT_SETTINGS,
      problems,
    );
    expect(s.shifting.levers).toEqual({
      left: { positive: 'steerRight', negative: 'steerLeft' },
      right: { positive: 'steerRight', negative: 'brake' },
      deadzone: 0.05,
    });
    expect(problems).toEqual([
      'shifting.levers.left.negative: unknown lever function',
      'shifting.levers.right: expected an object',
      'shifting.levers.deadzone: expected a number in [0, 0.5]',
    ]);
  });

  it('a patch changes one direction and leaves the rest alone', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      shifting: { levers: { right: { negative: 'none' }, deadzone: 0.1 } },
    });
    expect(next.shifting.levers).toEqual({
      left: { positive: 'brake', negative: 'steerLeft' },
      right: { positive: 'steerRight', negative: 'none' },
      deadzone: 0.1,
    });
    // An invalid patch field is a no-op.
    const same = applySettingsPatch(next, { shifting: { levers: { left: { positive: 7 } } } });
    expect(same.shifting.levers).toEqual(next.shifting.levers);
  });
});

describe('group: relays by default, own server and relay list as advanced options', () => {
  it('defaults to the public relays; a stored address alone does not switch to it', () => {
    expect(DEFAULT_SETTINGS.group).toEqual({
      useOwnServer: false,
      signallingUrl: '',
      relayUrls: [],
    });
    // Settings saved before the relay transport existed: still relays.
    const old = sanitizeSettings({ group: { signallingUrl: 'wss://nas.example.org/signal' } });
    expect(old.group.useOwnServer).toBe(false);
    expect(old.group.signallingUrl).toBe('wss://nas.example.org/signal');
  });

  it('validates the switch and the relay list', () => {
    const problems: string[] = [];
    const s = applySettingsPatch(
      DEFAULT_SETTINGS,
      {
        group: {
          useOwnServer: true,
          relayUrls: ['wss://r1.example', ' wss://r1.example ', 'https://nope', 'wss://r2.example'],
        },
      },
      problems,
    );
    expect(s.group.useOwnServer).toBe(true);
    expect(s.group.relayUrls).toEqual(['wss://r1.example', 'wss://r2.example']);
    expect(problems).toEqual(['group.relayUrls[2]: not a ws:// or wss:// URL, dropped']);
    const bad: string[] = [];
    const t = applySettingsPatch(s, { group: { useOwnServer: 'yes', relayUrls: 'x' } }, bad);
    expect(t.group).toEqual(s.group);
    expect(bad).toHaveLength(2);
    expect(applySettingsPatch(s, { group: { relayUrls: [] } }).group.relayUrls).toEqual([]);
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
