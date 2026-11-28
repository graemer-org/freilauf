/**
 * The weather of a day along a route (docs/adr/0012-historical-wind.md): one GET to the
 * historical weather archive in the settings, sent from the main process like the map query
 * (overpassClient.ts) so the renderer's CSP stays closed and the request carries the generic
 * User-Agent naming the app. Only the configured endpoint is asked, with a query of the
 * archive's own parameters (checked here); one request at a time is the renderer's job
 * (weatherFetch). The fetch implementation is injected (Electron's net.fetch in the app).
 */
import { OVERPASS_USER_AGENT } from '@freilauf/routes';
import type { OverpassReply } from '../shared/contract';
import { readLimited, retryAfterSeconds } from './overpassClient';
import { isWeatherArchiveUrl } from './settings';

/** The subset of fetch used here. */
export type GetLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

/** Longest answer accepted (bytes): 10 places × 16 days of hourly values is ~150 KB. */
export const MAX_WEATHER_ANSWER_BYTES = 4 * 1024 * 1024;
export const WEATHER_CLIENT_TIMEOUT_MS = 60_000;
export const MAX_WEATHER_QUERY_CHARS = 2_000;
/** Parameter names the renderer may send (the archive's, as weather.ts builds them). */
const PARAMS = new Set([
  'latitude',
  'longitude',
  'start_date',
  'end_date',
  'hourly',
  'wind_speed_unit',
  'timezone',
  'timeformat',
]);

/** A query of the archive's parameters only, with plain values. */
export function isWeatherQuery(q: unknown): q is string {
  if (typeof q !== 'string' || q.length === 0 || q.length > MAX_WEATHER_QUERY_CHARS) return false;
  if (!/^[A-Za-z0-9_=&.,:%/-]+$/.test(q)) return false;
  return q.split('&').every((part) => {
    const eq = part.indexOf('=');
    return eq > 0 && PARAMS.has(part.slice(0, eq)) && part.length > eq + 1;
  });
}

export class WeatherClient {
  readonly #fetch: GetLike;
  readonly #endpoint: () => string;
  readonly #log: (m: string) => void;
  readonly #timeoutMs: number;
  readonly #inFlight = new Map<string, AbortController>();

  constructor(options: {
    fetch: GetLike;
    endpoint: () => string;
    log?: (m: string) => void;
    timeoutMs?: number;
  }) {
    this.#fetch = options.fetch;
    this.#endpoint = options.endpoint;
    this.#log = options.log ?? (() => undefined);
    this.#timeoutMs = options.timeoutMs ?? WEATHER_CLIENT_TIMEOUT_MS;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  async query(requestId: string, query: string): Promise<OverpassReply> {
    const base = this.#endpoint();
    if (!isWeatherArchiveUrl(base)) throw new Error('No valid weather server address is set.');
    if (!isWeatherQuery(query)) throw new Error('invalid query');
    const url = `${base}${base.includes('?') ? '&' : '?'}${query}`;
    this.#inFlight.get(requestId)?.abort();
    const ctl = new AbortController();
    this.#inFlight.set(requestId, ctl);
    const timer = setTimeout(() => ctl.abort(new Error('timed out')), this.#timeoutMs);
    const started = Date.now();
    try {
      const res = await this.#fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': OVERPASS_USER_AGENT, Accept: 'application/json' },
        signal: ctl.signal,
      });
      const text = await readLimited(res, MAX_WEATHER_ANSWER_BYTES);
      this.#log(
        `weather ${res.status} in ${Date.now() - started} ms, ${Math.round(text.length / 1024)} KB`,
      );
      return {
        status: res.status,
        text,
        retryAfterS: retryAfterSeconds(res.headers.get('retry-after')),
      };
    } catch (e) {
      const reason = ctl.signal.aborted
        ? ctl.signal.reason instanceof Error
          ? ctl.signal.reason.message
          : 'cancelled'
        : e instanceof Error
          ? e.message
          : String(e);
      this.#log(`weather request failed: ${reason}`);
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
      if (this.#inFlight.get(requestId) === ctl) this.#inFlight.delete(requestId);
    }
  }

  cancel(requestId: string): void {
    const ctl = this.#inFlight.get(requestId);
    if (!ctl) return;
    ctl.abort(new Error('cancelled'));
    this.#inFlight.delete(requestId);
  }

  cancelAll(): void {
    for (const id of [...this.#inFlight.keys()]) this.cancel(id);
  }
}
