/**
 * Fetching the weather of one day along a route once from a historical weather archive
 * (docs/adr/0012-historical-wind.md), with the same manners as the surroundings
 * (sceneryFetch.ts): one request at a time, a pause between requests, retries with
 * exponential backoff when the server is busy (429, 502–504, timeouts; Retry-After is
 * honoured), cancellable at any point, with progress. A route needs one request per
 * WEATHER_LOCATIONS_PER_REQUEST grid cells — one for most routes. The HTTP request itself is
 * the host's (`WeatherTransport`): the desktop app sends it from the main process, the browser
 * build with fetch.
 */
import type { RouteTrack } from './types';
import {
  type CancelSignal,
  CancelledError,
  cancellableSleep,
  isRetryableStatus,
  type OverpassResponse,
  type SceneryProgress,
  untilCancelled,
} from './sceneryFetch';
import {
  buildWindProfile,
  encodeWindProfile,
  parseWeatherJson,
  planWeather,
  summarizeWind,
  type WeatherSeries,
  type WeatherSummary,
  type WeatherWhen,
  type WindProfile,
} from './weather';

/** Sends one archive query (the part after "?"); rejects on a network failure or timeout. */
export type WeatherTransport = (query: string, signal: CancelSignal) => Promise<OverpassResponse>;

export type WeatherProgress = Omit<SceneryProgress, 'phase'> & { phase: 'fetching' | 'waiting' };

export interface FetchWeatherOptions {
  transport: WeatherTransport;
  signal?: CancelSignal;
  onProgress?: (p: WeatherProgress) => void;
  sleep?: (ms: number, signal: CancelSignal) => Promise<void>;
  now?: () => number;
  /** Tries per request after the first one (default 4). */
  retries?: number;
  /** First backoff (ms, default 5000), doubled per try, at most maxBackoffMs (default 120 s). */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Pause between two requests (ms, default 1000). */
  pauseMs?: number;
}

export type FetchWeatherResult =
  | { ok: true; profile: WindProfile; text: string; summary: WeatherSummary; requests: number }
  | { ok: false; cancelled: boolean; error: string; requests: number };

const NEVER: CancelSignal = { cancelled: false, onCancel: () => () => undefined };

function statusMessage(status: number): string {
  if (status === 429)
    return 'The weather server is busy (too many requests). Try again in a few minutes.';
  if (status >= 500)
    return `The weather server is not available right now (HTTP ${status}). Try again later.`;
  return `The weather server answered HTTP ${status}.`;
}

/** Fetches the weather of `when` along the route and builds its wind profile. Never throws. */
export async function fetchWeather(
  track: RouteTrack,
  when: WeatherWhen,
  options: FetchWeatherOptions,
): Promise<FetchWeatherResult> {
  const signal = options.signal ?? NEVER;
  const sleep = options.sleep ?? cancellableSleep;
  const now = options.now ?? Date.now;
  const retries = options.retries ?? 4;
  const backoff = options.backoffMs ?? 5_000;
  const maxBackoff = options.maxBackoffMs ?? 120_000;
  const pause = options.pauseMs ?? 1_000;
  let requests = 0;
  const progress = (p: WeatherProgress): void => {
    try {
      options.onProgress?.(p);
    } catch {
      // the UI's trouble does not stop the fetch
    }
  };
  const cancelled = (): FetchWeatherResult => ({
    ok: false,
    cancelled: true,
    error: 'Cancelled.',
    requests,
  });
  const plan = planWeather(track, when, now());
  if (!plan.ok) return { ok: false, cancelled: false, error: plan.error, requests };
  const series: WeatherSeries[] = [];
  const total = plan.queries.length;
  try {
    for (let b = 0; b < total; b++) {
      progress({ done: b, total, phase: 'fetching' });
      if (b > 0 && pause > 0) await sleep(pause, signal);
      const query = plan.queries[b]!;
      const expected = plan.batches[b]!.length;
      let lastError = '';
      let done = false;
      for (let attempt = 0; attempt <= retries && !done; attempt++) {
        if (signal.cancelled) return cancelled();
        if (attempt > 0) progress({ done: b, total, phase: 'fetching' });
        let waitS: number | null = null;
        try {
          requests++;
          const res = await untilCancelled(options.transport(query, signal), signal);
          if (signal.cancelled) return cancelled();
          if (res.status === 200 || res.status === 400) {
            const parsed = parseWeatherJson(res.text, expected);
            if (parsed.ok && res.status === 200) {
              series.push(...parsed.series);
              done = true;
              break;
            }
            // 400 carries {"error":true,"reason":…}: no point in trying again.
            lastError = parsed.ok ? statusMessage(res.status) : parsed.error;
            return { ok: false, cancelled: false, error: lastError, requests };
          }
          lastError = statusMessage(res.status);
          if (!isRetryableStatus(res.status))
            return { ok: false, cancelled: false, error: lastError, requests };
          if (typeof res.retryAfterS === 'number' && Number.isFinite(res.retryAfterS))
            waitS = Math.max(0, res.retryAfterS);
        } catch (err) {
          if (signal.cancelled || err instanceof CancelledError) return cancelled();
          lastError = `The weather server could not be reached (${err instanceof Error ? err.message : String(err)}).`;
        }
        if (attempt === retries) break;
        const ms = Math.min(maxBackoff, waitS !== null ? waitS * 1000 : backoff * 2 ** attempt);
        progress({ done: b, total, phase: 'waiting', waitS: Math.ceil(ms / 1000) });
        await sleep(ms, signal);
      }
      if (!done)
        return {
          ok: false,
          cancelled: false,
          error: `${lastError} (gave up after ${retries + 1} tries)`,
          requests,
        };
    }
    if (signal.cancelled) return cancelled();
    const built = buildWindProfile(track, when, plan.samples, plan.index, series, now());
    if (!built.ok) return { ok: false, cancelled: false, error: built.error, requests };
    const text = encodeWindProfile(built.profile);
    progress({ done: total, total, phase: 'fetching' });
    return {
      ok: true,
      profile: built.profile,
      text,
      summary: summarizeWind(built.profile),
      requests,
    };
  } catch (err) {
    if (signal.cancelled || err instanceof CancelledError) return cancelled();
    return {
      ok: false,
      cancelled: false,
      error: `Building the weather failed (${err instanceof Error ? err.message : String(err)}).`,
      requests,
    };
  }
}
