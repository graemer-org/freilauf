// Server-side render tests of the scenery controls in the Routes tab (docs/routes.md).
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState, SceneryStatus } from '../appStore';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { CommunityService } from '../../core/communityService';
import { AppContext } from './hooks';
import type { RouteEntry } from './routesApi';
import { importRouteFiles, RouteDetails, RoutesTab } from './RoutesTab';
import { sceneryProgressText, scenerySummaryText } from './SceneryUi';

const entry = (over: Partial<RouteEntry> = {}): RouteEntry => ({
  id: 'route-mine',
  name: 'Evening loop',
  source: 'imported',
  totalDistanceM: 12_000,
  ascentM: 80,
  descentM: 80,
  loop: true,
  profile: [100, 120, 110],
  outline: [
    [0, 0],
    [100, 100],
  ],
  ...over,
});

function state(scenery: Record<string, SceneryStatus> = {}): AppState {
  return {
    ready: true,
    simMode: false,
    settings: structuredClone(DEFAULT_SETTINGS),
    live: null,
    picker: null,
    busy: {},
    rides: [],
    group: { phase: 'idle' },
    notices: [],
    overlayEditMode: false,
    simEffortW: 180,
    workouts: [],
    selectedWorkoutId: null,
    ftpOutcome: null,
    sharedWorkouts: [],
    sharingWorkoutId: null,
    groupCountdownS: null,
    community: new CommunityService({ storage: null }).view,
    lastButton: null,
    levers: null,
    routes: [entry(), entry({ id: 'builtin-a', name: 'Rolling loop', source: 'builtin' })],
    selectedRouteId: null,
    routeTrack: null,
    sharedRoutes: [],
    sharingRouteId: null,
    lastRide: null,
    scenery,
    routeScenery: null,
  } as unknown as AppState;
}

function stubApp(s: AppState): App {
  const noop = (): void => undefined;
  return {
    store: createStore<AppState>(() => s),
    notify: noop,
    updateSettings: async () => undefined,
    importRoute: () => ({ ok: false, errors: [] }),
    selectRoute: () => true,
    deleteRoute: noop,
    exportRoute: () => null,
    loadScenery: () => true,
    cancelScenery: noop,
    removeScenery: async () => undefined,
    scenerySummary: async () => undefined,
  } as unknown as App;
}

const actions = {
  importRoute: () => ({ ok: false as const, errors: [] }),
  select: () => undefined,
  remove: () => undefined,
  exportRoute: () => null,
};

const details = (e: RouteEntry, s: AppState): string =>
  renderToString(
    createElement(
      AppContext.Provider,
      { value: stubApp(s) },
      createElement(RouteDetails, { entry: e, id: 'd', actions, sharing: null }),
    ),
  );

describe('scenery controls (SSR)', () => {
  it('offers "Load surroundings" on import, unticked, with the privacy note', () => {
    const html = renderToString(
      createElement(
        AppContext.Provider,
        { value: stubApp(state()) },
        createElement(RoutesTab, { onGoToRide: () => undefined }),
      ),
    );
    expect(html).toContain('data-testid="route-import-scenery"');
    expect(html).toContain('Load surroundings from OpenStreetMap');
    const box = /<input[^>]*data-testid="route-import-scenery"[^>]*>/.exec(html)![0];
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain('checked');
    expect(html).toContain('The map server learns roughly where the route runs');
  });

  it('passes the option to every file of an import', async () => {
    const seen: unknown[] = [];
    const file = { name: 'a.gpx', size: 3, text: async () => 'gpx' } as unknown as File;
    await importRouteFiles(
      {
        ...actions,
        importRoute: (_t, _n, o) => {
          seen.push(o);
          return { ok: false, errors: ['x'] };
        },
      },
      [file, file],
      () => 1,
    );
    await importRouteFiles(
      {
        ...actions,
        importRoute: (_t, _n, o) => {
          seen.push(o);
          return { ok: false, errors: ['x'] };
        },
      },
      [file],
      () => 2,
      { scenery: true },
    );
    expect(seen).toEqual([{}, {}, { scenery: true }]);
  });

  it('offers loading later in an imported route’s details, never for a built-in one', () => {
    const html = details(entry(), state());
    expect(html).toContain('data-testid="route-scenery-load"');
    expect(html).toContain('Load surroundings');
    expect(details(entry({ id: 'builtin-a', source: 'builtin' }), state())).not.toContain(
      'route-scenery',
    );
  });

  it('shows progress with a cancel, and the summary with the attribution once stored', () => {
    const loading = details(
      entry(),
      state({ 'route-mine': { state: 'loading', done: 2, total: 7, waitS: null } }),
    );
    expect(loading).toContain('Loading surroundings… part 3 of 7');
    expect(loading).toContain('data-testid="route-scenery-details-cancel"');
    const ready = details(
      entry(),
      state({
        'route-mine': {
          state: 'ready',
          bytes: 61_000,
          summary: {
            buildings: 132,
            forestM: 2500,
            waterM: 6400,
            places: ['Kleinmoos', 'Auhof'],
            bytes: 61_000,
            fetchedAt: 1,
            truncated: false,
          },
        },
      }),
    );
    expect(ready).toContain(
      '132 buildings · woods 2.5 km · water 6.4 km · Kleinmoos, Auhof · 60 KB',
    );
    expect(ready).toContain('© OpenStreetMap contributors');
    expect(ready).toContain('data-testid="route-scenery-remove"');
    expect(ready).toContain('Remove surroundings');
  });

  it('words the waiting and error states', () => {
    expect(sceneryProgressText({ state: 'loading', done: 0, total: 3, waitS: 12 })).toBe(
      'The map server is busy; trying again in 12 s…',
    );
    expect(sceneryProgressText({ state: 'queued' })).toBe('Waiting to load surroundings…');
    expect(scenerySummaryText({ state: 'ready', bytes: 2048, summary: null })).toBe(
      'Stored (2 KB).',
    );
    const err = details(entry(), state({ 'route-mine': { state: 'error', message: 'Busy.' } }));
    expect(err).toContain('Busy.');
    expect(err).toContain('Try again');
  });
});
