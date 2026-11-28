import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_WEATHER_ARCHIVE_URL,
  MAX_WIND_CHOICES,
} from '../shared/contract';
import { applySettingsPatch, isWeatherArchiveUrl, sanitizeSettings } from './settings';

describe('settings: the weather of a day', () => {
  it('defaults to the public archive and nothing remembered; older settings get the default', () => {
    expect(DEFAULT_SETTINGS.weather).toEqual({
      archiveUrl: 'https://archive-api.open-meteo.com/v1/archive',
      rideWithWind: {},
    });
    const { weather: _drop, ...old } = structuredClone(DEFAULT_SETTINGS);
    expect(sanitizeSettings(old).weather).toEqual(DEFAULT_SETTINGS.weather);
  });

  it('takes an https endpoint or one on this computer; empty means the default', () => {
    expect(isWeatherArchiveUrl('https://weather.example.org/v1/archive')).toBe(true);
    expect(isWeatherArchiveUrl('http://localhost:8080/v1/archive')).toBe(true);
    expect(isWeatherArchiveUrl('http://weather.example.org/v1/archive')).toBe(false);
    expect(isWeatherArchiveUrl('https://user:pw@example.org/')).toBe(false);
    let s = applySettingsPatch(DEFAULT_SETTINGS, {
      weather: { archiveUrl: 'http://127.0.0.1:9000/v1/archive' },
    });
    expect(s.weather.archiveUrl).toBe('http://127.0.0.1:9000/v1/archive');
    s = applySettingsPatch(s, { weather: { archiveUrl: '' } });
    expect(s.weather.archiveUrl).toBe(DEFAULT_WEATHER_ARCHIVE_URL);
    s = applySettingsPatch(s, { weather: { archiveUrl: 'ftp://nope' } });
    expect(s.weather.archiveUrl).toBe(DEFAULT_WEATHER_ARCHIVE_URL);
  });

  it('remembers "Ride with that day’s wind" per route, validated and bounded', () => {
    let s = applySettingsPatch(DEFAULT_SETTINGS, {
      weather: { rideWithWind: { 'route-a': false } },
    });
    s = applySettingsPatch(s, { weather: { rideWithWind: { 'route-b': true } } });
    s = applySettingsPatch(s, { weather: { rideWithWind: { 'route-a': true } } });
    expect(s.weather.rideWithWind).toEqual({ 'route-a': true, 'route-b': true });
    const bad = sanitizeSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      weather: { rideWithWind: { 'Not An Id': false, 'route-c': 'yes', 'route-d': false } },
    });
    expect(bad.weather.rideWithWind).toEqual({ 'route-d': false });
    const many = Object.fromEntries(
      Array.from({ length: MAX_WIND_CHOICES + 5 }, (_, i) => [`route-${i}`, false]),
    );
    const bounded = sanitizeSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      weather: { rideWithWind: many },
    });
    expect(Object.keys(bounded.weather.rideWithWind)).toHaveLength(MAX_WIND_CHOICES);
    expect(bounded.weather.rideWithWind['route-0']).toBeUndefined();
  });
});
