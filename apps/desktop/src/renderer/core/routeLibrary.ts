import type { BuildStats, RouteTimes, RouteTrack } from '@freilauf/routes';
import {
  builtinRoutes,
  decodeRoute,
  decodeRouteTimes,
  encodeRoute,
  normalizeRouteStart,
  outline,
  parseGpx,
  prepareRoute,
  profile,
  routeToGpx,
} from '@freilauf/routes';
import type { KeyValueStorage } from './workoutLibrary';

/** One route in the library, as the Routes tab lists it. */
export interface RouteEntry {
  id: string;
  name: string;
  description?: string;
  source: 'builtin' | 'imported';
  totalDistanceM: number;
  ascentM: number;
  descentM: number;
  loop: boolean;
  /** ≤ 200 elevations (m), evenly spaced from start to finish, for a thumbnail. */
  profile: number[];
  /** ≤ 200 x/y points (m east/north of the start) for a mini map. */
  outline: [number, number][];
  /**
   * Where the next ride on this route starts (m along it); absent = from the beginning. Chosen
   * on a profile or the map and remembered (docs/routes.md, "Choosing where to start, and jumping").
   */
  startM?: number;
}

export type RouteImportResult =
  | {
      ok: true;
      entry: RouteEntry;
      warnings: string[];
      stats?: BuildStats;
      /** When the recorded ride passed each place (a GPX with times); absent otherwise. */
      times?: RouteTimes;
    }
  | { ok: false; errors: string[] };

/** Index of imported routes (JSON array of ids); each route under `${PREFIX}<id>`. */
export const ROUTE_INDEX_KEY = 'freilauf.routes.v1';
export const ROUTE_KEY_PREFIX = 'freilauf.routes.v1.';
export const MAX_IMPORTED_ROUTES = 100;
/**
 * Characters all imported routes may take in localStorage (shared with the workout library
 * and the community state, ~5 M characters per origin in Chromium). At full resolution a
 * route takes ~4.7 characters per 10 m: a 30 km route ≈ 14 k, a 100 km route ≈ 47 k, the
 * largest possible (20 000 samples) ≈ 95 k. 2 M holds ~40 long or ~140 typical routes.
 */
export const ROUTE_STORAGE_BUDGET_CHARS = 2_000_000;
/** Start points per route id (JSON object id → metres); a separate, small key. */
export const ROUTE_STARTS_KEY = 'freilauf.routeStarts.v1';
/** Start points remembered at most (oldest dropped first). */
export const MAX_ROUTE_STARTS = 200;
/**
 * Recorded passage times of a GPX with `<time>` (≤ 200 numbers, ~1 k characters), per route,
 * for the weather of that day (docs/adr/0012-historical-wind.md).
 */
export const ROUTE_TIMES_KEY_PREFIX = 'freilauf.routeTimes.v1.';

const ENTRY_POINTS = 200;

function entryFor(track: RouteTrack, source: RouteEntry['source']): RouteEntry {
  return {
    id: track.id,
    name: track.name,
    ...(track.description ? { description: track.description } : {}),
    source,
    totalDistanceM: track.totalDistanceM,
    ascentM: track.ascentM,
    descentM: track.descentM,
    loop: track.loop,
    profile: profile(track, ENTRY_POINTS),
    outline: outline(track, ENTRY_POINTS),
  };
}

interface Stored {
  track: RouteTrack;
  entry: RouteEntry;
  /** Encoded size (characters) in storage. */
  chars: number;
}

/** Built-in routes and the rider's imported ones, kept in localStorage (one key per route). */
export class RouteLibrary {
  readonly #storage: KeyValueStorage | null;
  readonly #builtin: { track: RouteTrack; entry: RouteEntry }[];
  #imported: Stored[] = [];
  /** Start points by route id (metres > 0), in insertion order. */
  #starts = new Map<string, number>();
  /** Recorded passage times by route id (null = none), read from storage on first use. */
  readonly #times = new Map<string, RouteTimes | null>();
  /** Set when the last write to storage failed (quota or blocked). */
  saveFailed = false;

  constructor(storage: KeyValueStorage | null) {
    this.#storage = storage;
    this.#builtin = builtinRoutes().map((track) => ({ track, entry: entryFor(track, 'builtin') }));
    this.#load();
    this.#loadStarts();
  }

  list(): RouteEntry[] {
    return [...this.#builtin.map((b) => b.entry), ...this.#imported.map((i) => i.entry)].map(
      (e) => {
        const startM = this.#starts.get(e.id);
        return startM === undefined ? e : { ...e, startM };
      },
    );
  }

  /** Where the next ride on route `id` starts (m); 0 = from the beginning. */
  startOf(id: string): number {
    const found = this.get(id);
    const m = this.#starts.get(id) ?? 0;
    return found ? normalizeRouteStart(found.track, m) : 0;
  }

  /**
   * Remembers where the next ride on route `id` starts (0 = from the beginning). Returns the
   * start point in effect (wrapped on a loop, kept short of the finish), or null for an unknown
   * route. The library is not changed by a failed write (saveFailed tells).
   */
  setStart(id: string, distanceM: number): number | null {
    const found = this.get(id);
    if (!found) return null;
    const m = normalizeRouteStart(found.track, distanceM);
    this.#starts.delete(id);
    if (m > 0) this.#starts.set(id, Math.round(m * 10) / 10);
    while (this.#starts.size > MAX_ROUTE_STARTS) {
      const oldest = this.#starts.keys().next().value;
      if (oldest === undefined) break;
      this.#starts.delete(oldest);
    }
    this.#write(ROUTE_STARTS_KEY, JSON.stringify(Object.fromEntries(this.#starts)));
    return this.#starts.get(id) ?? 0;
  }

  get(id: string): { entry: RouteEntry; track: RouteTrack } | null {
    return (
      this.#builtin.find((b) => b.track.id === id) ??
      this.#imported.find((i) => i.track.id === id) ??
      null
    );
  }

  /** Characters the imported routes take in storage. */
  get storedChars(): number {
    return this.#imported.reduce((n, i) => n + i.chars, 0);
  }

  /** Summary for a route that is not (yet) in the library, e.g. one offered by the group. */
  describe(track: RouteTrack): RouteEntry {
    return entryFor(track, 'imported');
  }

  /** GPX, or our own format (decided by content). `fileName` names a nameless GPX. */
  importText(text: string, fileName?: string): RouteImportResult {
    const trimmed = typeof text === 'string' ? text.replace(/^﻿/, '').trimStart() : '';
    if (trimmed.startsWith('{')) {
      const decoded = decodeRoute(trimmed);
      if (!decoded.ok) return decoded;
      return this.add(decoded.track);
    }
    const parsed = parseGpx(text);
    if (!parsed.ok) return parsed;
    const fallbackName = fileName
      ?.replace(/^.*[\\/]/, '')
      .replace(/\.gpx$/i, '')
      .trim();
    const name =
      parsed.track.name === 'Imported route' && fallbackName ? fallbackName : parsed.track.name;
    const prepared = prepareRoute({ ...parsed.track, name });
    if (!prepared.ok) return prepared;
    const added = this.add(prepared.track);
    if (!added.ok) return added;
    const times = prepared.times;
    if (times && added.entry.source === 'imported') {
      this.#times.set(added.entry.id, times);
      this.#write(ROUTE_TIMES_KEY_PREFIX + added.entry.id, JSON.stringify(times));
    }
    return {
      ok: true,
      entry: added.entry,
      warnings: [...parsed.warnings, ...prepared.warnings, ...added.warnings],
      stats: prepared.stats,
      ...(times ? { times } : {}),
    };
  }

  /** The recorded passage times of an imported route (from its GPX), or null. */
  timesOf(id: string): RouteTimes | null {
    if (!this.#imported.some((i) => i.track.id === id)) return null;
    const known = this.#times.get(id);
    if (known !== undefined) return known;
    let times: RouteTimes | null = null;
    try {
      const text = this.#storage?.getItem(ROUTE_TIMES_KEY_PREFIX + id) ?? null;
      times = text ? decodeRouteTimes(JSON.parse(text)) : null;
    } catch {
      times = null;
    }
    this.#times.set(id, times);
    return times;
  }

  /** Adds (or replaces, by id) an imported route. Never shadows a built-in. */
  add(track: RouteTrack): RouteImportResult {
    const builtin = this.#builtin.find((b) => b.track.id === track.id);
    if (builtin) return { ok: true, entry: builtin.entry, warnings: [] };
    const text = encodeRoute(track);
    const others = this.#imported.filter((i) => i.track.id !== track.id);
    if (others.length >= MAX_IMPORTED_ROUTES) {
      return {
        ok: false,
        errors: [
          `The route library is full (${MAX_IMPORTED_ROUTES} routes). Delete a route first.`,
        ],
      };
    }
    const used = others.reduce((n, i) => n + i.chars, 0);
    if (used + text.length > ROUTE_STORAGE_BUDGET_CHARS) {
      return {
        ok: false,
        errors: [
          `Not enough room for this route (it needs ${Math.ceil(text.length / 1000)} k of ${Math.round((ROUTE_STORAGE_BUDGET_CHARS - used) / 1000)} k characters left). Delete a route first.`,
        ],
      };
    }
    const stored: Stored = { track, entry: entryFor(track, 'imported'), chars: text.length };
    this.#imported = [...others, stored];
    const saved = this.#write(ROUTE_KEY_PREFIX + track.id, text) && this.#saveIndex();
    return {
      ok: true,
      entry: stored.entry,
      warnings: saved
        ? []
        : [
            'The route could not be saved permanently (storage full or blocked); it is available until the app closes.',
          ],
    };
  }

  remove(id: string): boolean {
    const before = this.#imported.length;
    this.#imported = this.#imported.filter((i) => i.track.id !== id);
    if (this.#imported.length === before) return false;
    this.#saveIndex();
    if (this.#starts.delete(id)) {
      this.#write(ROUTE_STARTS_KEY, JSON.stringify(Object.fromEntries(this.#starts)));
    }
    this.#times.delete(id);
    for (const key of [ROUTE_KEY_PREFIX + id, ROUTE_TIMES_KEY_PREFIX + id]) {
      try {
        if (this.#storage?.removeItem) this.#storage.removeItem(key);
        else this.#storage?.setItem(key, '');
      } catch {
        // the index no longer lists it; a leftover value is harmless
      }
    }
    return true;
  }

  /** GPX of the prepared route, for saving or sending. */
  export(id: string): { fileName: string; text: string } | null {
    const found = this.get(id);
    if (!found) return null;
    const base = found.track.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'route';
    return { fileName: `${base}.gpx`, text: routeToGpx(found.track) };
  }

  #write(key: string, value: string): boolean {
    try {
      this.#storage?.setItem(key, value);
      this.saveFailed = false;
      return true;
    } catch {
      this.saveFailed = true;
      return false;
    }
  }

  #saveIndex(): boolean {
    return this.#write(ROUTE_INDEX_KEY, JSON.stringify(this.#imported.map((i) => i.track.id)));
  }

  #loadStarts(): void {
    let raw: unknown;
    try {
      const text = this.#storage?.getItem(ROUTE_STARTS_KEY) ?? null;
      if (!text) return;
      raw = JSON.parse(text);
    } catch {
      return; // blocked or corrupt: every route starts at the beginning
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    for (const [id, m] of Object.entries(raw as Record<string, unknown>).slice(
      0,
      MAX_ROUTE_STARTS,
    )) {
      if (id.length > 64 || typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m > 1e6) {
        continue;
      }
      this.#starts.set(id, m);
    }
  }

  #load(): void {
    let ids: unknown;
    try {
      const raw = this.#storage?.getItem(ROUTE_INDEX_KEY) ?? null;
      if (!raw) return;
      ids = JSON.parse(raw);
    } catch {
      return; // blocked or corrupt index: start empty for this session
    }
    if (!Array.isArray(ids)) return;
    for (const id of ids.slice(0, MAX_IMPORTED_ROUTES)) {
      if (typeof id !== 'string' || this.#imported.some((i) => i.track.id === id)) continue;
      let text: string | null = null;
      try {
        text = this.#storage?.getItem(ROUTE_KEY_PREFIX + id) ?? null;
      } catch {
        continue;
      }
      if (!text) continue;
      const decoded = decodeRoute(text);
      if (!decoded.ok || decoded.track.id !== id) continue;
      this.#imported.push({
        track: decoded.track,
        entry: entryFor(decoded.track, 'imported'),
        chars: text.length,
      });
    }
  }
}
