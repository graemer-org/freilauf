import { describe, expect, it } from 'vitest';
import { ALL_STATS, DEFAULT_SETTINGS } from '../shared/contract';
import { applySettingsPatch, sanitizeSettings } from './settings';

describe('rider age and sex (for the heart-rate energy estimate)', () => {
  it('are unset by default', () => {
    expect(DEFAULT_SETTINGS.rider.ageYears).toBeNull();
    expect(DEFAULT_SETTINGS.rider.sex).toBeNull();
    // A settings file from before they existed loads as unset.
    const s = sanitizeSettings({ rider: { name: 'Anna', massKg: 60, bikeMassKg: 8, ftpW: 210 } });
    expect(s.rider).toMatchObject({ ageYears: null, sex: null });
  });

  it('accepts ages 10–100 (rounded) and female / male / undisclosed', () => {
    const problems: string[] = [];
    const s = sanitizeSettings(
      { rider: { ageYears: 41.6, sex: 'female' } },
      DEFAULT_SETTINGS,
      problems,
    );
    expect(s.rider).toMatchObject({ ageYears: 42, sex: 'female' });
    expect(problems).toEqual([]);
    for (const sex of ['male', 'undisclosed'] as const) {
      expect(sanitizeSettings({ rider: { sex } }).rider.sex).toBe(sex);
    }
    expect(sanitizeSettings({ rider: { ageYears: 10 } }).rider.ageYears).toBe(10);
    expect(sanitizeSettings({ rider: { ageYears: 100 } }).rider.ageYears).toBe(100);
  });

  it('rejects out-of-range ages and unknown values, keeping the fallback', () => {
    const current = applySettingsPatch(DEFAULT_SETTINGS, { rider: { ageYears: 40, sex: 'male' } });
    for (const bad of [9, 101, -1, Number.NaN, '40', true, {}]) {
      const problems: string[] = [];
      const next = applySettingsPatch(current, { rider: { ageYears: bad } }, problems);
      expect(next.rider.ageYears).toBe(40);
      expect(problems.join()).toContain('rider.ageYears');
    }
    for (const bad of ['divers', '', 1, 'MALE']) {
      const problems: string[] = [];
      const next = applySettingsPatch(current, { rider: { sex: bad } }, problems);
      expect(next.rider.sex).toBe('male');
      expect(problems.join()).toContain('rider.sex');
    }
  });

  it('can be cleared with null', () => {
    const current = applySettingsPatch(DEFAULT_SETTINGS, { rider: { ageYears: 40, sex: 'male' } });
    const next = applySettingsPatch(current, { rider: { ageYears: null, sex: null } });
    expect(next.rider).toMatchObject({ ageYears: null, sex: null });
  });
});

describe('energy overlay tiles', () => {
  it('calories and fatGrams are valid tiles', () => {
    expect(ALL_STATS).toContain('calories');
    expect(ALL_STATS).toContain('fatGrams');
    const tiles = [
      { stat: 'calories', size: 'm' },
      { stat: 'fatGrams', size: 's' },
    ];
    expect(sanitizeSettings({ overlay: { tiles } }).overlay.tiles).toEqual(tiles);
  });
});
