/**
 * Scenery files (docs/adr/0011-osm-scenery.md): `<dir>/<routeId>.json`, one per route, written
 * atomically and validated on the way in and out. No Electron imports (unit-tested).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { decodeScenery, MAX_SCENERY_BYTES } from '@freilauf/routes';
import type { SceneryFileInfo } from '../shared/contract';
import { writeFileAtomic } from './atomicWrite';

/** Route ids are `route-<base36>` or the built-ins' names: lower-case, digits and dashes. */
const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isRouteId(v: unknown): v is string {
  return typeof v === 'string' && ROUTE_ID.test(v);
}

export class SceneryStore {
  readonly dir: string;
  readonly #log: (m: string) => void;

  constructor(dir: string, log: (m: string) => void = (m) => console.warn(`[scenery] ${m}`)) {
    this.dir = path.resolve(dir);
    this.#log = log;
  }

  pathFor(routeId: string): string {
    if (!isRouteId(routeId)) throw new Error('invalid route id');
    const p = path.resolve(this.dir, `${routeId}.json`);
    if (path.dirname(p) !== this.dir) throw new Error('scenery path escapes its directory');
    return p;
  }

  async load(routeId: string): Promise<string | null> {
    try {
      const text = await fsp.readFile(this.pathFor(routeId), 'utf8');
      const decoded = decodeScenery(text);
      if (!decoded.ok || decoded.model.routeId !== routeId) {
        this.#log(
          `ignoring unreadable scenery of ${routeId}: ${decoded.ok ? 'other route' : decoded.error}`,
        );
        return null;
      }
      return text;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.#log(`could not read scenery of ${routeId}: ${String(e)}`);
      return null;
    }
  }

  async save(routeId: string, text: string): Promise<void> {
    if (typeof text !== 'string' || text.length > MAX_SCENERY_BYTES + 1024)
      throw new Error('scenery too large');
    const decoded = decodeScenery(text);
    if (!decoded.ok) throw new Error(`invalid scenery: ${decoded.error}`);
    if (decoded.model.routeId !== routeId) throw new Error('scenery of another route');
    await writeFileAtomic(this.pathFor(routeId), text);
  }

  async remove(routeId: string): Promise<void> {
    await fsp.rm(this.pathFor(routeId), { force: true });
  }

  async list(): Promise<SceneryFileInfo[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: SceneryFileInfo[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const routeId = name.slice(0, -'.json'.length);
      if (!isRouteId(routeId)) continue;
      try {
        const st = await fsp.stat(path.join(this.dir, name));
        out.push({ routeId, bytes: st.size });
      } catch {
        // gone in the meantime
      }
    }
    return out.sort((a, b) => (a.routeId < b.routeId ? -1 : 1));
  }
}
