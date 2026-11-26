import { describe, expect, it } from 'vitest';
import { COUNTDOWN_CHOICES, DEFAULT_SETTINGS, POWER_SMOOTHING_CHOICES } from '../shared/contract';
import { applySettingsPatch, migrateSettings, sanitizeSettings } from './settings';

describe('Settings.ride.countdownS (countdown before the start)', () => {
  it('defaults to 3 s, also for settings from before the countdown (no problem noted)', () => {
    expect(DEFAULT_SETTINGS.ride).toEqual({ countdownS: 3, powerSmoothingS: 3 });
    const problems: string[] = [];
    expect(sanitizeSettings({ rider: { name: 'Ana' } }, DEFAULT_SETTINGS, problems).ride).toEqual({
      countdownS: 3,
      powerSmoothingS: 3,
    });
    expect(problems).toEqual([]);
  });

  it('takes 0 (off), 3, 5 and 10', () => {
    expect(COUNTDOWN_CHOICES).toEqual([0, 3, 5, 10]);
    for (const countdownS of COUNTDOWN_CHOICES) {
      expect(sanitizeSettings({ ride: { countdownS } }).ride.countdownS).toBe(countdownS);
    }
  });

  it('rejects anything else and keeps the fallback', () => {
    for (const bad of [4, -3, 3.5, 11, 600, Number.NaN, '3', null, true, {}, [3]]) {
      const problems: string[] = [];
      const s = sanitizeSettings({ ride: { countdownS: bad } }, DEFAULT_SETTINGS, problems);
      expect(s.ride.countdownS, String(bad)).toBe(3);
      expect(problems).toEqual(['ride.countdownS: expected one of 0, 3, 5, 10']);
    }
    const problems: string[] = [];
    expect(sanitizeSettings({ ride: 'fast' }, DEFAULT_SETTINGS, problems).ride.countdownS).toBe(3);
    expect(problems).toEqual(['ride: expected an object']);
  });

  it('a patch changes it; a bad patch is a no-op', () => {
    const off = applySettingsPatch(DEFAULT_SETTINGS, { ride: { countdownS: 0 } });
    expect(off.ride.countdownS).toBe(0);
    const problems: string[] = [];
    expect(applySettingsPatch(off, { ride: { countdownS: 7 } }, problems).ride.countdownS).toBe(0);
    expect(problems).toHaveLength(1);
    expect(applySettingsPatch(off, { ride: { countdownS: 10 } }).ride.countdownS).toBe(10);
  });
});

describe('Settings.ride.powerSmoothingS (display smoothing of power)', () => {
  it('defaults to 3 s; settings from before it get 3 s on load (no problem noted)', () => {
    expect(DEFAULT_SETTINGS.ride.powerSmoothingS).toBe(3);
    const old = { rider: { name: 'Ana' }, ride: { countdownS: 5 } };
    const migrated = migrateSettings(old);
    expect(migrated).toEqual({
      rider: { name: 'Ana' },
      ride: { countdownS: 5, powerSmoothingS: 3 },
    });
    expect(old.ride).toEqual({ countdownS: 5 }); // not mutated
    const problems: string[] = [];
    expect(sanitizeSettings(migrated, DEFAULT_SETTINGS, problems).ride).toEqual({
      countdownS: 5,
      powerSmoothingS: 3,
    });
    expect(problems).toEqual([]);
    // Older still (no ride at all) and empty files get it from the fallback.
    for (const raw of [{}, { rider: { name: 'Ana' } }]) {
      expect(sanitizeSettings(migrateSettings(raw)).ride.powerSmoothingS).toBe(3);
    }
  });

  it('keeps a stored choice, including off, and leaves overlay tiles alone', () => {
    const raw = {
      ride: { countdownS: 3, powerSmoothingS: 0 },
      overlay: { tiles: [{ stat: 'power3s', size: 'l' }] },
    };
    expect(migrateSettings(raw)).toBe(raw);
    const s = sanitizeSettings(migrateSettings(raw));
    expect(s.ride.powerSmoothingS).toBe(0);
    expect(s.overlay.tiles).toEqual([{ stat: 'power3s', size: 'l' }]);
    // Settings from before the feature keep their 3 s power tile too.
    const before = {
      ride: { countdownS: 3 },
      overlay: { tiles: [{ stat: 'power3s', size: 'l' }] },
    };
    expect(sanitizeSettings(migrateSettings(before)).overlay.tiles).toEqual([
      { stat: 'power3s', size: 'l' },
    ]);
  });

  it('takes off, 1, 3 and 5 s and rejects anything else', () => {
    expect(POWER_SMOOTHING_CHOICES).toEqual([0, 1, 3, 5]);
    for (const powerSmoothingS of POWER_SMOOTHING_CHOICES) {
      expect(sanitizeSettings({ ride: { powerSmoothingS } }).ride.powerSmoothingS).toBe(
        powerSmoothingS,
      );
    }
    for (const bad of [2, -1, 3.5, 10, Number.NaN, '3', null, true, {}]) {
      const problems: string[] = [];
      const s = sanitizeSettings({ ride: { powerSmoothingS: bad } }, DEFAULT_SETTINGS, problems);
      expect(s.ride.powerSmoothingS, String(bad)).toBe(3);
      expect(problems).toEqual(['ride.powerSmoothingS: expected one of 0, 1, 3, 5']);
    }
  });

  it('a patch changes it without touching the countdown; a bad patch is a no-op', () => {
    const off = applySettingsPatch(DEFAULT_SETTINGS, { ride: { powerSmoothingS: 0 } });
    expect(off.ride).toEqual({ countdownS: 3, powerSmoothingS: 0 });
    expect(applySettingsPatch(off, { ride: { powerSmoothingS: 4 } }).ride.powerSmoothingS).toBe(0);
    expect(applySettingsPatch(off, { ride: { powerSmoothingS: 5 } }).ride.powerSmoothingS).toBe(5);
  });

  it('new installs show the smoothed power tile on the overlay; 3 s power stays available', () => {
    expect(DEFAULT_SETTINGS.overlay.tiles[0]).toEqual({ stat: 'power', size: 'l' });
    const s = applySettingsPatch(DEFAULT_SETTINGS, {
      overlay: {
        tiles: [
          { stat: 'power3s', size: 'm' },
          { stat: 'avgPower', size: 's' },
        ],
      },
    });
    expect(s.overlay.tiles).toEqual([
      { stat: 'power3s', size: 'm' },
      { stat: 'avgPower', size: 's' },
    ]);
  });
});
