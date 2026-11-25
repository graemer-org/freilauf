import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_WATCH_RELAY } from '../shared/contract';
import { applySettingsPatch, sanitizeSettings } from './settings';

describe('Settings.watchRelay', () => {
  it('defaults to off, sharing heart rate, power and speed but not the trainer', () => {
    expect(sanitizeSettings({}).watchRelay).toEqual({
      enabled: false,
      share: { heartRate: true, power: true, speedCadence: true, trainer: false },
    });
    expect(DEFAULT_SETTINGS.watchRelay).toEqual(DEFAULT_WATCH_RELAY);
  });

  it('takes valid values and drops bad ones field by field', () => {
    const problems: string[] = [];
    const s = sanitizeSettings(
      JSON.parse(
        '{"watchRelay":{"enabled":true,"share":{"heartRate":false,"trainer":"yes","ant":true,"__proto__":{"x":1}}}}',
      ),
      DEFAULT_SETTINGS,
      problems,
    );
    expect(s.watchRelay).toEqual({
      enabled: true,
      share: { heartRate: false, power: true, speedCadence: true, trainer: false },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'watchRelay.share.trainer: expected a boolean',
        'watchRelay.share.ant: unknown kind',
      ]),
    );
  });

  it('keeps the current value for a malformed section', () => {
    const current = applySettingsPatch(DEFAULT_SETTINGS, { watchRelay: { enabled: true } });
    expect(applySettingsPatch(current, { watchRelay: 'on' as never }).watchRelay.enabled).toBe(
      true,
    );
    expect(
      applySettingsPatch(current, { watchRelay: { enabled: 1 as never } }).watchRelay.enabled,
    ).toBe(true);
  });

  it('patches one kind without touching the others', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      watchRelay: { share: { trainer: true } },
    });
    expect(next.watchRelay.share).toEqual({
      heartRate: true,
      power: true,
      speedCadence: true,
      trainer: true,
    });
    expect(next.watchRelay.enabled).toBe(false);
  });
});
