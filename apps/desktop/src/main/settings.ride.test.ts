import { describe, expect, it } from 'vitest';
import { COUNTDOWN_CHOICES, DEFAULT_SETTINGS } from '../shared/contract';
import { applySettingsPatch, sanitizeSettings } from './settings';

describe('Settings.ride.countdownS (countdown before the start)', () => {
  it('defaults to 3 s, also for settings from before the countdown (no problem noted)', () => {
    expect(DEFAULT_SETTINGS.ride).toEqual({ countdownS: 3 });
    const problems: string[] = [];
    expect(sanitizeSettings({ rider: { name: 'Ana' } }, DEFAULT_SETTINGS, problems).ride).toEqual({
      countdownS: 3,
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
