/**
 * Scenery along routes in the app (docs/routes.md, docs/adr/0011-osm-scenery.md): loading it
 * once from an Overpass server when the rider asks for it, keeping it next to the route
 * (FreilaufApi.scenery), and handing the selected route's model to the ride scenes. Never
 * fetches on its own and never at ride time: a ride only ever reads the stored model.
 *
 * One fetch runs at a time (the Overpass fair-use policy); further requests wait in a queue.
 */
import type { RouteTrack, SceneryModel, ScenerySummary } from '@freilauf/routes';
import {
  CancelSource,
  decodeScenery,
  fetchScenery,
  type FetchSceneryOptions,
  type OverpassTransport,
  summarizeScenery,
  utf8ByteLength,
} from '@freilauf/routes';
import type { FreilaufApi } from '../../shared/contract';
import type { ScopedLog } from './logger';

/** What the Routes tab shows for one route. */
export type SceneryStatus =
  | { state: 'none' }
  | { state: 'queued' }
  | { state: 'loading'; done: number; total: number; waitS: number | null }
  | { state: 'ready'; bytes: number; summary: ScenerySummary | null }
  | { state: 'error'; message: string };

export interface SceneryServiceDeps {
  api: FreilaufApi['scenery'];
  log: ScopedLog;
  /** Status of every route with something to show changed. */
  onStatus(statuses: Record<string, SceneryStatus>): void;
  /** A fetch finished (or failed): a short message for the rider. */
  onNotice(kind: 'info' | 'error', message: string): void;
  /** Options for fetchScenery (tests: fast sleeps). */
  fetchOptions?: Partial<FetchSceneryOptions>;
}

let requestCounter = 0;

/** Models kept decoded in memory (the selected route's, and a few recent). */
const CACHE_SIZE = 3;

export class SceneryService {
  readonly #deps: SceneryServiceDeps;
  #statuses: Record<string, SceneryStatus> = {};
  readonly #cache = new Map<string, SceneryModel>();
  readonly #queue: { track: RouteTrack; cancel: CancelSource }[] = [];
  #running: { routeId: string; cancel: CancelSource } | null = null;
  #disposed = false;

  constructor(deps: SceneryServiceDeps) {
    this.#deps = deps;
  }

  get statuses(): Readonly<Record<string, SceneryStatus>> {
    return this.#statuses;
  }

  status(routeId: string): SceneryStatus {
    return this.#statuses[routeId] ?? { state: 'none' };
  }

  #set(routeId: string, status: SceneryStatus): void {
    const next = { ...this.#statuses };
    if (status.state === 'none') delete next[routeId];
    else next[routeId] = status;
    this.#statuses = next;
    this.#deps.onStatus(next);
  }

  /** Reads which routes have stored scenery (on start). */
  async init(): Promise<void> {
    try {
      const files = await this.#deps.api.list();
      const next = { ...this.#statuses };
      for (const f of files) {
        if (!next[f.routeId]) next[f.routeId] = { state: 'ready', bytes: f.bytes, summary: null };
      }
      this.#statuses = next;
      this.#deps.onStatus(next);
    } catch (e) {
      this.#deps.log.warn('could not list stored scenery', { error: String(e) });
    }
  }

  /** The stored model of a route (decoded, cached), or null. */
  async model(routeId: string): Promise<SceneryModel | null> {
    const cached = this.#cache.get(routeId);
    if (cached) return cached;
    const st = this.status(routeId);
    if (st.state !== 'ready') return null;
    let text: string | null = null;
    try {
      text = await this.#deps.api.load(routeId);
    } catch (e) {
      this.#deps.log.warn('could not load scenery', { routeId, error: String(e) });
    }
    if (!text) return null;
    const d = decodeScenery(text);
    if (!d.ok || d.model.routeId !== routeId) {
      this.#deps.log.warn('stored scenery unreadable', {
        routeId,
        error: d.ok ? 'other route' : d.error,
      });
      return null;
    }
    this.#remember(d.model);
    const bytes = utf8ByteLength(text);
    if (this.status(routeId).state === 'ready')
      this.#set(routeId, { state: 'ready', bytes, summary: summarizeScenery(d.model, bytes) });
    return d.model;
  }

  #remember(m: SceneryModel): void {
    this.#cache.delete(m.routeId);
    this.#cache.set(m.routeId, m);
    while (this.#cache.size > CACHE_SIZE) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  /** Queues a fetch for a route (replacing what is stored once it succeeds). */
  load(track: RouteTrack): void {
    const id = track.id;
    if (this.#running?.routeId === id || this.#queue.some((q) => q.track.id === id)) return;
    this.#queue.push({ track, cancel: new CancelSource() });
    this.#set(id, { state: 'queued' });
    void this.#pump();
  }

  /** Stops a queued or running fetch; what was stored before stays. */
  cancel(routeId: string): void {
    const i = this.#queue.findIndex((q) => q.track.id === routeId);
    if (i >= 0) {
      this.#queue.splice(i, 1);
      void this.#restore(routeId);
    }
    if (this.#running?.routeId === routeId) this.#running.cancel.cancel();
  }

  /** Deletes a route's stored scenery (and stops a fetch for it). */
  async remove(routeId: string): Promise<void> {
    this.cancel(routeId);
    this.#cache.delete(routeId);
    try {
      await this.#deps.api.remove(routeId);
    } catch (e) {
      this.#deps.log.warn('could not remove scenery', { routeId, error: String(e) });
    }
    this.#set(routeId, { state: 'none' });
    this.#deps.log.info('scenery removed', { routeId });
  }

  /** After a cancel: back to what is stored. */
  async #restore(routeId: string): Promise<void> {
    try {
      const files = await this.#deps.api.list();
      const f = files.find((x) => x.routeId === routeId);
      const cached = this.#cache.get(routeId);
      this.#set(
        routeId,
        f
          ? {
              state: 'ready',
              bytes: f.bytes,
              summary: cached ? summarizeScenery(cached, f.bytes) : null,
            }
          : { state: 'none' },
      );
    } catch {
      this.#set(routeId, { state: 'none' });
    }
  }

  async #pump(): Promise<void> {
    if (this.#running || this.#disposed) return;
    const job = this.#queue.shift();
    if (!job) return;
    const { track, cancel } = job;
    const routeId = track.id;
    this.#running = { routeId, cancel };
    const log = this.#deps.log;
    const api = this.#deps.api;
    const transport: OverpassTransport = async (query, signal) => {
      const requestId = `osm-${Date.now().toString(36)}-${++requestCounter}`;
      const off = signal.onCancel(() => api.cancelOverpass(requestId));
      try {
        return await api.overpass(requestId, query);
      } finally {
        off();
      }
    };
    const started = Date.now();
    log.info('scenery fetch started', {
      routeId,
      distanceKm: Math.round(track.totalDistanceM / 1000),
    });
    this.#set(routeId, { state: 'loading', done: 0, total: 0, waitS: null });
    const res = await fetchScenery(track, {
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
    this.#running = null;
    if (res.ok) {
      try {
        await api.save(routeId, res.text);
        this.#remember(res.model);
        const bytes = utf8ByteLength(res.text);
        this.#set(routeId, { state: 'ready', bytes, summary: res.summary });
        log.info('scenery stored', {
          routeId,
          requests: res.requests,
          seconds: Math.round((Date.now() - started) / 1000),
          buildings: res.summary.buildings,
          kb: Math.round(bytes / 1024),
          truncated: res.summary.truncated,
        });
        const what =
          res.summary.buildings > 0 || res.summary.forestM > 0 || res.summary.waterM > 0
            ? `${res.summary.buildings} buildings`
            : 'nothing to draw near this road';
        this.#deps.onNotice('info', `Surroundings of “${track.name}” loaded (${what}).`);
      } catch (e) {
        log.warn('scenery could not be stored', { routeId, error: String(e) });
        this.#set(routeId, { state: 'error', message: 'The surroundings could not be saved.' });
        this.#deps.onNotice('error', 'The surroundings could not be saved on this computer.');
      }
    } else if (res.cancelled) {
      log.info('scenery fetch cancelled', { routeId, requests: res.requests });
      await this.#restore(routeId);
    } else {
      log.warn('scenery fetch failed', { routeId, requests: res.requests, error: res.error });
      this.#set(routeId, { state: 'error', message: res.error });
      this.#deps.onNotice('error', `Surroundings of “${track.name}” not loaded: ${res.error}`);
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
