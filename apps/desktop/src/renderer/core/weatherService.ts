/**
 * The weather of a day along routes in the app (docs/routes.md, "The weather of that day";
 * docs/adr/0012-historical-wind.md): loading it once from the weather archive when the rider
 * asks for it, keeping the compact wind profile next to the route (route storage, one small
 * key per route), and handing the selected route's profile to the ride. Never fetches on its
 * own and never at ride time: a ride only ever reads the stored profile.
 *
 * One fetch runs at a time; further requests wait in a queue.
 */
import type { RouteTrack, WeatherSummary, WeatherWhen, WindProfile } from '@freilauf/routes';
import {
  CancelSource,
  decodeWindProfile,
  fetchWeather,
  type FetchWeatherOptions,
  summarizeWind,
  weatherDayLabel,
  type WeatherTransport,
  windConditionsKey,
} from '@freilauf/routes';
import type { FreilaufApi } from '../../shared/contract';
import type { ScopedLog } from './logger';
import type { KeyValueStorage } from './workoutLibrary';

/** What the Routes tab shows for one route. */
export type WeatherStatus =
  | { state: 'none' }
  | { state: 'queued' }
  | { state: 'loading'; done: number; total: number; waitS: number | null }
  | { state: 'ready'; summary: WeatherSummary; label: string; key: string }
  | { state: 'error'; message: string };

/** One profile per route under this prefix (a few hundred bytes to a few KB each). */
export const WEATHER_KEY_PREFIX = 'freilauf.routeWeather.v1.';

export interface WeatherServiceDeps {
  api: FreilaufApi['weather'];
  /** Route storage (localStorage); null = memory only. */
  storage: KeyValueStorage | null;
  log: ScopedLog;
  onStatus(statuses: Record<string, WeatherStatus>): void;
  onNotice(kind: 'info' | 'error', message: string): void;
  /** Options for fetchWeather (tests: fast sleeps, a fixed clock). */
  fetchOptions?: Partial<FetchWeatherOptions>;
}

let requestCounter = 0;

export class WeatherService {
  readonly #deps: WeatherServiceDeps;
  #statuses: Record<string, WeatherStatus> = {};
  readonly #profiles = new Map<string, WindProfile>();
  readonly #queue: { track: RouteTrack; when: WeatherWhen; cancel: CancelSource }[] = [];
  #running: { routeId: string; cancel: CancelSource } | null = null;
  #disposed = false;

  constructor(deps: WeatherServiceDeps) {
    this.#deps = deps;
  }

  get statuses(): Readonly<Record<string, WeatherStatus>> {
    return this.#statuses;
  }

  status(routeId: string): WeatherStatus {
    return this.#statuses[routeId] ?? { state: 'none' };
  }

  #set(routeId: string, status: WeatherStatus): void {
    const next = { ...this.#statuses };
    if (status.state === 'none') delete next[routeId];
    else next[routeId] = status;
    this.#statuses = next;
    this.#deps.onStatus(next);
  }

  static #ready(p: WindProfile): WeatherStatus {
    return {
      state: 'ready',
      summary: summarizeWind(p),
      label: weatherDayLabel(p),
      key: windConditionsKey(p),
    };
  }

  /** Reads the stored profiles of these routes (on start). */
  init(routeIds: readonly string[]): void {
    const next = { ...this.#statuses };
    for (const id of routeIds) {
      const p = this.#read(id);
      if (p && !next[id]) next[id] = WeatherService.#ready(p);
    }
    this.#statuses = next;
    this.#deps.onStatus(next);
  }

  #read(routeId: string): WindProfile | null {
    const known = this.#profiles.get(routeId);
    if (known) return known;
    let text: string | null = null;
    try {
      text = this.#deps.storage?.getItem(WEATHER_KEY_PREFIX + routeId) ?? null;
    } catch {
      return null;
    }
    if (!text) return null;
    const d = decodeWindProfile(text);
    if (!d.ok || d.profile.routeId !== routeId) {
      this.#deps.log.warn('stored weather unreadable', {
        routeId,
        error: d.ok ? 'other route' : d.error,
      });
      return null;
    }
    this.#profiles.set(routeId, d.profile);
    return d.profile;
  }

  /** The stored profile of a route, or null. */
  profile(routeId: string): WindProfile | null {
    return this.status(routeId).state === 'ready' ? this.#read(routeId) : null;
  }

  /** Queues a fetch (replacing what is stored once it succeeds). */
  load(track: RouteTrack, when: WeatherWhen): void {
    const id = track.id;
    if (this.#running?.routeId === id) this.#running.cancel.cancel();
    const i = this.#queue.findIndex((q) => q.track.id === id);
    if (i >= 0) this.#queue.splice(i, 1);
    this.#queue.push({ track, when, cancel: new CancelSource() });
    this.#set(id, { state: 'queued' });
    void this.#pump();
  }

  /** Stops a queued or running fetch; what was stored before stays. */
  cancel(routeId: string): void {
    const i = this.#queue.findIndex((q) => q.track.id === routeId);
    if (i >= 0) {
      this.#queue.splice(i, 1);
      this.#restore(routeId);
    }
    if (this.#running?.routeId === routeId) this.#running.cancel.cancel();
  }

  /** Deletes a route's stored weather (and stops a fetch for it). */
  remove(routeId: string): void {
    this.cancel(routeId);
    this.#profiles.delete(routeId);
    try {
      if (this.#deps.storage?.removeItem)
        this.#deps.storage.removeItem(WEATHER_KEY_PREFIX + routeId);
      else this.#deps.storage?.setItem(WEATHER_KEY_PREFIX + routeId, '');
    } catch (e) {
      this.#deps.log.warn('could not remove weather', { routeId, error: String(e) });
    }
    this.#set(routeId, { state: 'none' });
    this.#deps.log.info('weather removed', { routeId });
  }

  #restore(routeId: string): void {
    const p = this.#read(routeId);
    this.#set(routeId, p ? WeatherService.#ready(p) : { state: 'none' });
  }

  async #pump(): Promise<void> {
    if (this.#running || this.#disposed) return;
    const job = this.#queue.shift();
    if (!job) return;
    const { track, when, cancel } = job;
    const routeId = track.id;
    this.#running = { routeId, cancel };
    const log = this.#deps.log;
    const api = this.#deps.api;
    const transport: WeatherTransport = async (query, signal) => {
      const requestId = `wx-${Date.now().toString(36)}-${++requestCounter}`;
      const off = signal.onCancel(() => api.cancelArchive(requestId));
      try {
        return await api.archive(requestId, query);
      } finally {
        off();
      }
    };
    log.info('weather fetch started', {
      routeId,
      when: when.kind,
      distanceKm: Math.round(track.totalDistanceM / 1000),
    });
    this.#set(routeId, { state: 'loading', done: 0, total: 0, waitS: null });
    const res = await fetchWeather(track, when, {
      ...this.#deps.fetchOptions,
      transport,
      signal: cancel.signal,
      onProgress: (p) =>
        this.#set(routeId, {
          state: 'loading',
          done: p.done,
          total: p.total,
          waitS: p.phase === 'waiting' ? (p.waitS ?? null) : null,
        }),
    });
    if (this.#running?.routeId === routeId) this.#running = null;
    if (res.ok) {
      let saved = true;
      try {
        this.#deps.storage?.setItem(WEATHER_KEY_PREFIX + routeId, res.text);
      } catch (e) {
        saved = false;
        log.warn('weather could not be stored', { routeId, error: String(e) });
      }
      this.#profiles.set(routeId, res.profile);
      this.#set(routeId, WeatherService.#ready(res.profile));
      log.info('weather stored', {
        routeId,
        requests: res.requests,
        points: res.profile.points.length,
        bytes: res.text.length,
      });
      this.#deps.onNotice(
        saved ? 'info' : 'error',
        saved
          ? `Weather of ${weatherDayLabel(res.profile)} loaded for “${track.name}”.`
          : `Weather of “${track.name}” loaded, but it could not be saved on this device.`,
      );
    } else if (res.cancelled) {
      log.info('weather fetch cancelled', { routeId, requests: res.requests });
      // A newer request for the same route may already be queued.
      if (!this.#queue.some((q) => q.track.id === routeId)) this.#restore(routeId);
    } else {
      log.warn('weather fetch failed', { routeId, requests: res.requests, error: res.error });
      this.#set(routeId, { state: 'error', message: res.error });
      this.#deps.onNotice('error', `Weather of “${track.name}” not loaded: ${res.error}`);
    }
    void this.#pump();
  }

  dispose(): void {
    this.#disposed = true;
    this.#running?.cancel.cancel();
    for (const q of this.#queue) q.cancel.cancel();
    this.#queue.length = 0;
  }
}
