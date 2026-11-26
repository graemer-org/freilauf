/**
 * Scenery along routes in the browser build (docs/adr/0011-osm-scenery.md): the stored files
 * in IndexedDB (or memory), and the Overpass request made with fetch. Overpass allows CORS;
 * the request is a "simple" form POST, so there is no preflight. A browser does not let a
 * page set the User-Agent: the server sees the browser's own, and this page's origin.
 */
import { decodeScenery, MAX_SCENERY_BYTES } from '@freilauf/routes';
import { overpassBody } from '@freilauf/routes';
import type { OverpassReply, SceneryFileInfo } from '../../desktop/src/shared/contract';
import { isOverpassUrl } from '../../desktop/src/main/settings';
import { done, openRideDatabase, request, SCENERY } from './idbRideStore';

export interface SceneryRecordStore {
  get(routeId: string): Promise<string | null>;
  put(routeId: string, text: string): Promise<void>;
  delete(routeId: string): Promise<void>;
  list(): Promise<SceneryFileInfo[]>;
}

function validated(routeId: string, text: string): void {
  if (typeof text !== 'string' || text.length > MAX_SCENERY_BYTES + 1024)
    throw new Error('scenery too large');
  const d = decodeScenery(text);
  if (!d.ok) throw new Error(`invalid scenery: ${d.error}`);
  if (d.model.routeId !== routeId) throw new Error('scenery of another route');
}

export class MemorySceneryStore implements SceneryRecordStore {
  readonly #map = new Map<string, string>();
  async get(routeId: string): Promise<string | null> {
    return this.#map.get(routeId) ?? null;
  }
  async put(routeId: string, text: string): Promise<void> {
    validated(routeId, text);
    this.#map.set(routeId, text);
  }
  async delete(routeId: string): Promise<void> {
    this.#map.delete(routeId);
  }
  async list(): Promise<SceneryFileInfo[]> {
    return [...this.#map].map(([routeId, text]) => ({ routeId, bytes: text.length }));
  }
}

export class IndexedDbSceneryStore implements SceneryRecordStore {
  readonly #db: Promise<IDBDatabase>;
  constructor(db: Promise<IDBDatabase> = openRideDatabase()) {
    this.#db = db;
  }
  async get(routeId: string): Promise<string | null> {
    const tx = (await this.#db).transaction(SCENERY, 'readonly');
    const rec = (await request(tx.objectStore(SCENERY).get(routeId))) as
      { routeId: string; text: string } | undefined;
    if (!rec || typeof rec.text !== 'string') return null;
    const d = decodeScenery(rec.text);
    return d.ok && d.model.routeId === routeId ? rec.text : null;
  }
  async put(routeId: string, text: string): Promise<void> {
    validated(routeId, text);
    const tx = (await this.#db).transaction(SCENERY, 'readwrite');
    tx.objectStore(SCENERY).put({ routeId, text });
    await done(tx);
  }
  async delete(routeId: string): Promise<void> {
    const tx = (await this.#db).transaction(SCENERY, 'readwrite');
    tx.objectStore(SCENERY).delete(routeId);
    await done(tx);
  }
  async list(): Promise<SceneryFileInfo[]> {
    const tx = (await this.#db).transaction(SCENERY, 'readonly');
    const all = (await request(tx.objectStore(SCENERY).getAll())) as {
      routeId: string;
      text: string;
    }[];
    return all.map((r) => ({ routeId: r.routeId, bytes: r.text.length }));
  }
}

/** The subset of fetch used for Overpass. */
export type BrowserFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(n: string): string | null };
  text(): Promise<string>;
}>;

export const BROWSER_OVERPASS_TIMEOUT_MS = 150_000;

/** Overpass from the page: one AbortController per request id. */
export function browserOverpass(fetchFn: BrowserFetch, endpoint: () => string) {
  const inFlight = new Map<string, AbortController>();
  return {
    async query(requestId: string, query: string): Promise<OverpassReply> {
      const url = endpoint();
      if (!isOverpassUrl(url)) throw new Error('No valid map server address is set.');
      inFlight.get(requestId)?.abort();
      const ctl = new AbortController();
      inFlight.set(requestId, ctl);
      const timer = setTimeout(() => ctl.abort(), BROWSER_OVERPASS_TIMEOUT_MS);
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          // A CORS-safelisted content type: no preflight request.
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: overpassBody(query),
          signal: ctl.signal,
        });
        const text = await res.text();
        const ra = res.headers.get('retry-after');
        const n = ra === null ? Number.NaN : Number(ra);
        return { status: res.status, text, retryAfterS: Number.isFinite(n) ? n : null };
      } catch (e) {
        throw new Error(
          ctl.signal.aborted ? 'cancelled' : e instanceof Error ? e.message : String(e),
        );
      } finally {
        clearTimeout(timer);
        if (inFlight.get(requestId) === ctl) inFlight.delete(requestId);
      }
    },
    cancel(requestId: string): void {
      inFlight.get(requestId)?.abort();
      inFlight.delete(requestId);
    },
  };
}
