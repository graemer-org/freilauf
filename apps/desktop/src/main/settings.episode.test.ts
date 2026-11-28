import { describe, expect, it } from 'vitest';
import { DEFAULT_EPISODE, DEFAULT_SETTINGS } from '../shared/contract';
import { applySettingsPatch, migrateSettings, sanitizeSettings } from './settings';

describe('Settings.episode (last "Fit to an episode" choices)', () => {
  it('defaults to 42 min, medium, spread — also for settings from before it (no problem noted)', () => {
    expect(DEFAULT_SETTINGS.episode).toEqual({
      lengthMin: 42,
      effort: 'medium',
      pattern: 'spread',
    });
    expect(DEFAULT_EPISODE).toBe(DEFAULT_SETTINGS.episode);
    for (const old of [{}, { rider: { name: 'Ana' } }, { ride: { countdownS: 5 } }]) {
      const problems: string[] = [];
      expect(sanitizeSettings(migrateSettings(old), DEFAULT_SETTINGS, problems).episode).toEqual(
        DEFAULT_EPISODE,
      );
      expect(problems).toEqual([]);
    }
  });

  it('keeps stored choices across a save and load', () => {
    const saved = applySettingsPatch(DEFAULT_SETTINGS, {
      episode: { lengthMin: 22, effort: 'hard', pattern: 'finale' },
    });
    expect(saved.episode).toEqual({ lengthMin: 22, effort: 'hard', pattern: 'finale' });
    const loaded = sanitizeSettings(JSON.parse(JSON.stringify(saved)));
    expect(loaded.episode).toEqual({ lengthMin: 22, effort: 'hard', pattern: 'finale' });
    // A partial patch changes only that part.
    expect(applySettingsPatch(saved, { episode: { pattern: 'steady' } }).episode).toEqual({
      lengthMin: 22,
      effort: 'hard',
      pattern: 'steady',
    });
  });

  it('clamps the length and rejects unknown effort / pattern part by part', () => {
    const problems: string[] = [];
    const s = sanitizeSettings(
      { episode: { lengthMin: 500, effort: 'brutal', pattern: 'early' } },
      DEFAULT_SETTINGS,
      problems,
    );
    expect(s.episode).toEqual({ lengthMin: 180, effort: 'medium', pattern: 'early' });
    expect(problems).toEqual([
      'episode.lengthMin: expected whole minutes from 10 to 180',
      'episode.effort: expected "easy", "medium" or "hard"',
    ]);
    expect(sanitizeSettings({ episode: { lengthMin: 3 } }).episode.lengthMin).toBe(10);
    expect(sanitizeSettings({ episode: { lengthMin: '42' } }).episode.lengthMin).toBe(42);
    expect(sanitizeSettings({ episode: { lengthMin: 55.4 } }).episode.lengthMin).toBe(55);
    const bad: string[] = [];
    expect(sanitizeSettings({ episode: 'long' }, DEFAULT_SETTINGS, bad).episode).toEqual(
      DEFAULT_EPISODE,
    );
    expect(bad).toEqual(['episode: expected an object']);
    // A bad patch is a no-op.
    const current = applySettingsPatch(DEFAULT_SETTINGS, { episode: { effort: 'easy' } });
    expect(applySettingsPatch(current, { episode: { effort: 'max' } }).episode.effort).toBe('easy');
  });

  it('accepts "hard now" as a controller button action', () => {
    const problems: string[] = [];
    const s = sanitizeSettings(
      { shifting: { buttons: { y: 'hardNow', z: 'nonsense' } } },
      DEFAULT_SETTINGS,
      problems,
    );
    expect(s.shifting.buttons.y).toBe('hardNow');
    expect(s.shifting.buttons.z).toBeUndefined();
    expect(problems).toHaveLength(1);
  });
});
