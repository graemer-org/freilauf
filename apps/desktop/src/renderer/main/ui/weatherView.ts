/**
 * What the weather of a day along a route looks like in the UI (docs/routes.md, "The weather
 * of that day"), as pure functions: the summary in a route's details, the progress line, the
 * wind indicator on the ride scene and the start screen's line.
 */
import type { WeatherSummary } from '@freilauf/routes';
import {
  WEATHER_ATTRIBUTION,
  WEATHER_LICENCE,
  compassWord,
  conditionsText,
} from '@freilauf/routes';
import type { LiveWind } from '../../../shared/contract';
import type { WeatherStatus } from '../appStore';

/** The one-line privacy note next to every "load" control. */
export const WEATHER_PRIVACY_NOTE =
  'The weather server learns roughly where (to about 10 km) and which day; nothing about you is sent.';

/** "Weather data by Open-Meteo.com (CC BY 4.0)" */
export const WEATHER_CREDIT = `${WEATHER_ATTRIBUTION} (${WEATHER_LICENCE})`;

const kmh = (mps: number): number => Math.round(mps * 3.6);

/** "14 km/h" */
export const formatWind = (mps: number): string => `${kmh(Math.abs(mps))} km/h`;

/** "14 June 2025, 09:12–13:40 · wind 14 km/h from the south-west, gusts 32 km/h · 12–17 °C · Partly cloudy" */
export function weatherSummaryText(s: WeatherSummary): string {
  const parts = [s.span];
  parts.push(
    `wind ${formatWind(s.meanMps)} from the ${compassWord(s.mainFromDeg)}${
      kmh(s.maxMps) > kmh(s.meanMps) + 2 ? `, up to ${formatWind(s.maxMps)}` : ''
    }`,
  );
  const t0 = Math.round(s.minTempC);
  const t1 = Math.round(s.maxTempC);
  parts.push(t0 === t1 ? `${t0} °C` : `${t0}–${t1} °C`);
  if (s.conditions) parts.push(s.conditions);
  if (s.wet && !/Rain|Drizzle|Showers|Snow|Thunder/.test(s.conditions)) parts.push('some rain');
  return parts.join(' · ');
}

/** "Times of the recorded ride" / "Chosen day, from 10:00 at 25 km/h" */
export function weatherWhenText(s: WeatherSummary): string {
  return s.when === 'recorded'
    ? 'At the times of the recorded ride.'
    : 'For the chosen day, as if ridden at 25 km/h from the start time.';
}

export function weatherProgressText(status: WeatherStatus): string {
  if (status.state === 'queued') return 'Waiting to load the weather…';
  if (status.state !== 'loading') return '';
  if (status.waitS !== null)
    return `The weather server is busy; trying again in ${Math.max(1, status.waitS)} s…`;
  if (status.total > 1)
    return `Loading the weather… part ${Math.min(status.done + 1, status.total)} of ${status.total}`;
  return 'Loading the weather…';
}

/** The latest day the archive is likely to have (a few days back), as YYYY-MM-DD. */
export function latestWeatherDay(now = Date.now()): string {
  return new Date(now - 5 * 86_400_000).toISOString().slice(0, 10);
}

export interface WindIndicator {
  /** "Headwind 14 km/h" / "Tailwind 9 km/h" / "Crosswind 12 km/h" / "Calm" */
  text: string;
  /** Arrow rotation (degrees) on screen: the way the wind blows relative to riding up the screen. */
  arrowDeg: number;
  kind: 'head' | 'tail' | 'cross' | 'calm';
  /** "17 °C · Rain" */
  weather: string;
  /** For the title: "Wind of 14 June 2025: 22 km/h from the south-west at 10 m" */
  title: string;
  /** Precipitation worth drawing (mm in the hour). */
  rain: number;
}

/** The wind chip on the ride scene; null without wind. */
export function windIndicator(w: LiveWind | null | undefined): WindIndicator | null {
  if (!w) return null;
  const head = w.headMps;
  const cross = w.crossMps;
  const strength = Math.hypot(head, cross);
  let kind: WindIndicator['kind'];
  let text: string;
  if (!w.active) {
    kind = 'calm';
    text = 'Wind off in group rides';
  } else if (kmh(strength) < 2) {
    kind = 'calm';
    text = 'Calm';
  } else if (Math.abs(head) >= Math.abs(cross) * 0.6) {
    kind = head > 0 ? 'head' : 'tail';
    text = `${head > 0 ? 'Headwind' : 'Tailwind'} ${formatWind(head)}`;
  } else {
    kind = 'cross';
    text = `Crosswind ${formatWind(cross)}`;
  }
  const temp = Number.isFinite(w.tempC) ? `${Math.round(w.tempC)} °C` : '';
  const cond = conditionsText(w.code);
  return {
    text,
    // The wind comes from relativeDeg (0 = ahead): it blows the other way.
    arrowDeg: Math.round(w.relativeDeg + 180),
    kind,
    weather: [temp, cond].filter(Boolean).join(' · '),
    title: `Wind of ${w.label}: ${formatWind(w.speed10Mps)} from the ${compassWord(w.fromDeg)} at 10 m`,
    rain: w.precipMm >= 0.1 ? w.precipMm : 0,
  };
}
