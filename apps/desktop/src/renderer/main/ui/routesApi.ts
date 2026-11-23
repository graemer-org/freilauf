/**
 * Route state and actions, feature-detected on `App` / `AppState`.
 *
 * Routes (GPX import, the route library, the track that drives the ride) are
 * wired into the app store separately from this UI. This is the ONE place
 * that looks them up by name, so the rest of the UI typechecks and renders
 * whether or not they exist yet; without them the Routes tab says routes are
 * unavailable and the Ride tab behaves as before. Expected shape:
 *
 *   state.routes: RouteEntry[]
 *   state.selectedRouteId: string | null
 *   state.routeTrack: RouteTrack | null
 *   state.sharedRoutes: { peerId, peerName, entry }[]
 *   state.sharingRouteId: string | null
 *   app.importRoute(text, fileName?) → { ok: true, entry, warnings } | { ok: false, errors }
 *   app.selectRoute(id | null): boolean
 *   app.deleteRoute(id) · app.exportRoute(id) → { fileName, text } | null
 *   app.shareRoute(id) · app.stopSharingRoute() · app.useSharedRoute(peerId)
 *   app.setRouteStart(id, m) → m | null · app.jumpTo(m) → m | null · app.routeTrackFor(id)
 *
 * Once these are part of `App`'s type this file can read them directly.
 */
import type { RouteTrack } from '@freilauf/routes';
import type { App, AppState } from '../appStore';
import { useApp, useAppState } from './hooks';

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
  /** Elevation in metres at evenly spaced points from start to finish. */
  profile: number[];
  /** The route's shape: [x, y] points (east, north), any unit. */
  outline: [number, number][];
  /** Where the next ride starts (m along the route); absent = from the beginning. */
  startM?: number;
}

export interface SharedRoute {
  peerId: string;
  peerName: string;
  entry: RouteEntry;
}

export type RouteImportResult =
  { ok: true; entry: RouteEntry; warnings: string[] } | { ok: false; errors: string[] };

const EMPTY_ROUTES: readonly RouteEntry[] = [];
const EMPTY_SHARED: readonly SharedRoute[] = [];

type Loose = Record<string, unknown>;
const loose = (s: AppState): Loose => s as unknown as Loose;

// ───────────── state ─────────────

/** True when this build's store knows about routes at all. */
export function hasRouteState(s: AppState): boolean {
  return Array.isArray(loose(s).routes);
}

export function routesOf(s: AppState): readonly RouteEntry[] {
  const r = loose(s).routes;
  return Array.isArray(r) ? (r as RouteEntry[]) : EMPTY_ROUTES;
}

export function selectedRouteIdOf(s: AppState): string | null {
  const id = loose(s).selectedRouteId;
  return typeof id === 'string' ? id : null;
}

export function routeTrackOf(s: AppState): RouteTrack | null {
  const t = loose(s).routeTrack as RouteTrack | null | undefined;
  return t && Array.isArray(t.elevationM) && t.count >= 2 ? t : null;
}

export function sharedRoutesOf(s: AppState): readonly SharedRoute[] {
  const r = loose(s).sharedRoutes;
  return Array.isArray(r) ? (r as SharedRoute[]) : EMPTY_SHARED;
}

export function sharingRouteIdOf(s: AppState): string | null {
  const id = loose(s).sharingRouteId;
  return typeof id === 'string' ? id : null;
}

/** The route difficulty in percent (0 … 100), when the settings carry one. */
export function routeDifficultyOf(s: AppState): number | null {
  const route = (s.settings as unknown as Loose | null)?.route as Loose | undefined;
  const d = route?.difficulty;
  return typeof d === 'number' && Number.isFinite(d) ? d : null;
}

export const useRouteTrack = (): RouteTrack | null => useAppState(routeTrackOf);
export const useRoutes = (): readonly RouteEntry[] => useAppState(routesOf);
export const useSelectedRouteId = (): string | null => useAppState(selectedRouteIdOf);
export const useHasRoutes = (): boolean => useAppState(hasRouteState);

// ───────────── actions ─────────────

type AnyMethod = (...args: unknown[]) => unknown;

function method(app: App, name: string): AnyMethod | null {
  const fn = (app as unknown as Loose)[name];
  if (typeof fn !== 'function') return null;
  return (...args: unknown[]) => (fn as AnyMethod).apply(app, args);
}

/** Ignores the result; reports a rejected promise as a notice instead of an unhandled error. */
function fire(app: App, call: () => unknown): unknown {
  try {
    const result = call();
    if (result instanceof Promise) {
      result.catch((err: unknown) => app.notify('error', String(err)));
    }
    return result;
  } catch (err) {
    app.notify('error', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

export interface RouteActions {
  importRoute(text: string, fileName?: string): RouteImportResult | Promise<RouteImportResult>;
  select(id: string | null): void;
  remove(id: string): void;
  exportRoute(id: string): { fileName: string; text: string } | null;
}

export interface RouteSharing {
  share(id: string): void;
  stop(): void;
  /** Selects a route another rider shared (named so it does not read as a React hook). */
  adopt(peerId: string): void;
}

/** Import/select/delete/export, or null when this build's `App` has no routes. */
export function routeActions(app: App): RouteActions | null {
  const imp = method(app, 'importRoute');
  const select = method(app, 'selectRoute');
  const del = method(app, 'deleteRoute');
  const exp = method(app, 'exportRoute');
  if (!imp || !select) return null;
  return {
    importRoute: (text, fileName) => imp(text, fileName) as RouteImportResult,
    select: (id) => void fire(app, () => select(id)),
    remove: (id) => void (del && fire(app, () => del(id))),
    exportRoute: (id) => {
      if (!exp) return null;
      const r = fire(app, () => exp(id)) as { fileName: string; text: string } | null | undefined;
      return r && typeof r.text === 'string' ? r : null;
    },
  };
}

/** Share/stop/use, or null when this build's `App` cannot share routes. */
export function routeSharing(app: App): RouteSharing | null {
  const share = method(app, 'shareRoute');
  const stop = method(app, 'stopSharingRoute');
  const adopt = method(app, 'useSharedRoute');
  if (!share || !stop || !adopt) return null;
  return {
    share: (id) => void fire(app, () => share(id)),
    stop: () => void fire(app, () => stop()),
    adopt: (peerId) => void fire(app, () => adopt(peerId)),
  };
}

/** Writes the route difficulty (percent). */
export function setRouteDifficulty(app: App, value: number): void {
  void fire(app, () =>
    app.updateSettings({ route: { difficulty: value } } as unknown as Parameters<
      App['updateSettings']
    >[0]),
  );
}

export function useRouteActions(): RouteActions | null {
  return routeActions(useApp());
}

export interface RouteJumps {
  /** Before the ride: sets (and remembers) the start point; during it: jumps there. */
  jumpTo(distanceM: number): void;
  /** Sets the remembered start point of a route (0 = from the beginning). */
  setStart(id: string, distanceM: number): void;
  /** The full track of a library route (for exact elevation and gradient), if available. */
  trackFor(id: string): RouteTrack | null;
}

/** Start points and jumps (docs/routes.md, "Choosing where to start, and jumping"), or null when this build cannot. */
export function routeJumps(app: App): RouteJumps | null {
  const jump = method(app, 'jumpTo');
  const start = method(app, 'setRouteStart');
  const track = method(app, 'routeTrackFor');
  if (!jump || !start) return null;
  return {
    jumpTo: (d) => void fire(app, () => jump(d)),
    setStart: (id, d) => void fire(app, () => start(id, d)),
    trackFor: (id) => {
      const t = track ? (track(id) as RouteTrack | null | undefined) : null;
      return t && Array.isArray(t.elevationM) && t.count >= 2 ? t : null;
    },
  };
}
