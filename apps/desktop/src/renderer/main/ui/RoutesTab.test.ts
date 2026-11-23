// Server-side render tests of the Routes tab and of the Ride tab on a route.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { RoutePosition } from '@freilauf/routes';
import type { App, AppState } from '../appStore';
import type { LiveState } from '../../../shared/contract';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { CommunityService } from '../../core/communityService';
import { MainApp } from './index';
import type { RouteEntry } from './routesApi';
import { AppContext } from './hooks';
import { JumpConfirm } from './RoutePick';
import { importRouteFiles, MAX_ROUTE_IMPORT_BYTES, RouteDetails } from './RoutesTab';
import { syntheticTrack } from './scene/testTrack';

const track = syntheticTrack(
  [
    { lengthM: 1000 },
    { lengthM: 600, turnDeg: 80, gradePercent: 6 },
    { lengthM: 1400, turnDeg: -40, gradePercent: -2 },
  ],
  {},
);
track.id = 'r-hills';
track.name = 'Hill loop';

const entry = (over: Partial<RouteEntry> = {}): RouteEntry => ({
  id: 'r-hills',
  name: 'Hill loop',
  description: 'Up the hill and back down.',
  source: 'builtin',
  totalDistanceM: 3000,
  ascentM: 36,
  descentM: 28,
  loop: false,
  profile: [100, 100, 118, 136, 130, 122],
  outline: [
    [0, 0],
    [0, 1000],
    [400, 1500],
    [900, 1600],
  ],
  ...over,
});

function live(route: RoutePosition | null, state: 'idle' | 'riding' = 'riding'): LiveState {
  return {
    ride: {
      state,
      elapsedS: 600,
      distanceM: 1200,
      speedMps: 8,
      powerW: 230,
      power3sW: 228,
      wattsPerKg: 3.1,
      cadenceRpm: 88,
      heartRateBpm: 140,
      gear: 10,
      gearCount: 24,
      gradePercent: 6,
    },
    devices: {
      trainer: { name: 'Sim trainer', state: 'connected' },
      heartRate: null,
      controller: null,
    },
    group: {
      roomCode: 'ABCD',
      riders: [
        {
          peerId: 'p1',
          name: 'Bea',
          distanceM: 1260,
          speedMps: 8,
          powerW: 240,
          cadenceRpm: 90,
          heartRateBpm: null,
          gear: 11,
          gapM: 60,
          stale: false,
        },
      ],
    },
    localName: 'Ana',
    route,
  };
}

const position = (over: Partial<RoutePosition> = {}): RoutePosition => ({
  routeId: 'r-hills',
  name: 'Hill loop',
  totalDistanceM: 3000,
  distanceM: 1200,
  lap: 1,
  gradePercent: 6,
  elevationM: 112,
  remainingM: 1800,
  ascentRemainingM: 24,
  finished: false,
  ...over,
});

function state(
  extra: Record<string, unknown>,
  liveState: LiveState | null = live(null, 'idle'),
): AppState {
  return {
    ready: true,
    simMode: false,
    settings: structuredClone(DEFAULT_SETTINGS),
    live: liveState,
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
    ...extra,
  } as unknown as AppState;
}

function stubApp(s: AppState, methods: Record<string, unknown> = {}): App {
  const noop = (): void => undefined;
  return {
    store: createStore<AppState>(() => s),
    notify: noop,
    updateSettings: async () => undefined,
    setGradient: noop,
    importRoute: () => ({ ok: false, errors: [] }),
    selectRoute: () => true,
    deleteRoute: noop,
    exportRoute: () => null,
    ...methods,
  } as unknown as App;
}

const ROUTE_STATE = {
  routes: [entry(), entry({ id: 'mine', name: 'Evening loop', source: 'imported', loop: true })],
  selectedRouteId: null,
  routeTrack: null,
  sharedRoutes: [],
  sharingRouteId: null,
  lastRide: null,
};

const render = (s: AppState, tab: 'routes' | 'ride', methods?: Record<string, unknown>): string =>
  renderToString(createElement(MainApp, { app: stubApp(s, methods), initialScreen: tab }));

describe('Routes tab (SSR)', () => {
  it('is a picker reached from the start screen, with a way back', () => {
    const html = render(state(ROUTE_STATE), 'routes');
    expect(html).toContain('data-testid="panel-routes"');
    expect(html).toContain('data-testid="screen-back"');
    expect(html).not.toContain('role="tablist"');
  });

  it('lists built-in and imported routes as cards with thumbnails', () => {
    const html = render(state(ROUTE_STATE), 'routes');
    expect(html.match(/data-testid="route-row"/g)).toHaveLength(2);
    expect(html).toContain('data-route-id="r-hills"');
    expect(html).toContain('data-route-id="mine"');
    expect(html).toContain('3.0 km · ↑ 36 m · ↓ 28 m · Point to point');
    expect(html).toContain('Loop');
    expect(html).toContain('aria-label="Shape of Hill loop: point-to-point route of 3.0 km');
    expect(html).toContain('aria-label="Elevation profile of Hill loop');
    expect(html).toContain('data-testid="route-import"');
    expect(html).toContain('accept=".gpx,application/gpx+xml"');
    expect(html).toMatch(/recorded rides/);
    expect(html.match(/data-testid="route-select"/g)).toHaveLength(2);
    expect(html).not.toContain('data-testid="routes-locked"');
  });

  it('shows the selected route and its actions', () => {
    const html = render(state({ ...ROUTE_STATE, selectedRouteId: 'mine' }), 'routes');
    expect(html).toContain('data-testid="route-selected"');
    expect(html).toContain('Selected for next ride');
    expect(html).toContain('data-testid="route-clear"');
    expect(html).toContain('data-testid="route-go-ride"');
  });

  it('locks the choice while riding, and says why', () => {
    const html = render(
      state({ ...ROUTE_STATE, selectedRouteId: 'mine' }, live(position())),
      'routes',
    );
    expect(html).toContain('data-testid="routes-locked"');
    expect(html).toMatch(
      /data-testid="route-select"[^>]*disabled=""|disabled=""[^>]*data-testid="route-select"/,
    );
    expect(html).toMatch(
      /disabled=""[^>]*data-testid="route-clear"|data-testid="route-clear"[^>]*disabled=""/,
    );
  });

  it('shows an empty state without imported routes', () => {
    const html = render(state({ ...ROUTE_STATE, routes: [entry()] }), 'routes');
    expect(html).toContain('No imported routes yet');
  });

  it('offers routes shared by the group when in a group', () => {
    const group = {
      phase: 'joined',
      roomCode: 'ABCD',
      joinLink: 'x',
      inviteCode: 'ABCD',
      transport: 'relays',
      relay: 'ready',
      role: 'host',
      signallingUrl: '',
      peers: [],
      notes: [],
    };
    const s = state({
      ...ROUTE_STATE,
      group,
      sharedRoutes: [
        { peerId: 'p1', peerName: 'Bea', entry: entry({ id: 'bea-route', name: "Bea's hills" }) },
      ],
    });
    const sharingMethods = {
      shareRoute: () => undefined,
      stopSharingRoute: () => undefined,
      useSharedRoute: () => true,
    };
    const html = render(s, 'routes', sharingMethods);
    expect(html).toContain('data-testid="routes-shared"');
    expect(html).toContain('Shared by Bea');
    expect(html).toContain('data-testid="shared-route-use"');
    // Without the methods there is no shared section.
    expect(render(s, 'routes')).not.toContain('data-testid="routes-shared"');
  });

  it('says so when this build has no routes', () => {
    const html = render(state({}), 'routes');
    expect(html).toContain('data-testid="routes-unavailable"');
  });
});

describe('Ride tab on a route (SSR)', () => {
  const onRoute = (pos: RoutePosition | null, extra: Record<string, unknown> = {}) =>
    state({ ...ROUTE_STATE, selectedRouteId: 'r-hills', routeTrack: track, ...extra }, live(pos));

  it('shows the perspective scene, the map and the whole profile', () => {
    const html = render(onRoute(position()), 'ride');
    expect(html).toMatch(
      /data-testid="ride-scene"[^>]*data-view="road"|data-view="road"[^>]*data-testid="ride-scene"/,
    );
    expect(html).toContain('data-testid="ride-route"');
    expect(html).toContain('data-testid="route-map"');
    expect(html).toContain('data-testid="route-profile"');
    expect(html).toContain('data-testid="route-ahead"');
    expect(html).toContain('data-position="0.4000"');
    expect(html).toContain('1.8 km');
    expect(html).toContain('24 m');
    expect(html).toContain('ride-grid has-route');
    expect(html).toContain('data-testid="scene-view-road"');
    // The old "ahead unknown" strip is not used on a route.
    expect(html).not.toContain('data-testid="ride-profile"');
  });

  it('disables the manual gradient and says why', () => {
    const html = render(onRoute(position()), 'ride');
    expect(html).toContain('The route sets the gradient');
    expect(html).toMatch(
      /data-testid="gradient-up"[^>]*disabled=""|disabled=""[^>]*data-testid="gradient-up"/,
    );
    expect(html).toMatch(
      /id="gradient-slider"[^>]*disabled=""|disabled=""[^>]*id="gradient-slider"/,
    );
  });

  it('shows the lap on a loop and the complete state at the end', () => {
    const loop = { ...track, loop: true };
    const lapHtml = render(onRoute(position({ lap: 3 }), { routeTrack: loop }), 'ride');
    expect(lapHtml).toContain('Loop · Lap 3');
    expect(lapHtml).toContain('data-testid="route-lap"');
    const done = render(
      onRoute(position({ finished: true, distanceM: 3000, remainingM: 0 })),
      'ride',
    );
    expect(done).toContain('data-testid="route-complete"');
    expect(done).toContain('Route complete');
    expect(done).not.toContain('data-testid="route-ahead"');
  });

  it('notes a reduced climb difficulty on the route card', () => {
    expect(render(onRoute(position()), 'ride')).not.toContain(
      'data-testid="route-difficulty-note"',
    );
    const settings = { ...structuredClone(DEFAULT_SETTINGS), route: { difficulty: 50 } };
    const html = render(onRoute(position(), { settings }), 'ride');
    expect(html).toContain('climbs felt at 50 %');
  });

  it('keeps the side-on scene and the manual gradient without a route', () => {
    const html = render(state(ROUTE_STATE, live(null)), 'ride');
    expect(html).toContain('data-view="side"');
    expect(html).toContain('data-testid="ride-profile"');
    expect(html).not.toContain('data-testid="ride-route"');
    expect(html).not.toContain('The route sets the gradient');
  });
});

describe('start point and jumps (SSR)', () => {
  const JUMP_METHODS = {
    jumpTo: () => 0,
    setRouteStart: () => 0,
    routeTrackFor: (id: string) => (id === 'r-hills' ? track : null),
  };
  const control = (over: Record<string, unknown> = {}) => ({
    gradientLocked: true,
    difficulty: 100,
    trainerGradePercent: 6,
    startM: 0,
    jumps: 0,
    lastJumpM: null,
    ...over,
  });
  const onRoute = (
    pos: RoutePosition,
    rideState: 'idle' | 'riding',
    routeControl: Record<string, unknown>,
  ): AppState => {
    const l = live(pos, rideState);
    return state({ ...ROUTE_STATE, selectedRouteId: 'r-hills', routeTrack: track }, {
      ...l,
      routeControl: control(routeControl),
    } as LiveState);
  };
  const attr = (html: string, testId: string, name: string): string | null => {
    const tag = html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
    return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
  };

  it('the confirmation names the place, for a jump and for a start', () => {
    const info = { distanceM: 42_312, elevationM: 811.6, gradePercent: 3.06 };
    const noop = (): void => undefined;
    const jump = renderToString(
      createElement(JumpConfirm, { mode: 'jump', info, onConfirm: noop, onCancel: noop }),
    );
    expect(jump).toContain('role="dialog"');
    expect(jump).toContain('Jump to km 42.3 · 812 m · +3.1 %');
    expect(jump).toMatch(/data-testid="route-jump-ok"[^>]*>Jump</);
    expect(jump).toMatch(/data-testid="route-jump-cancel"[^>]*>Cancel</);
    expect(attr(jump, 'route-jump-confirm', 'data-distance')).toBe('42312.0');
    const start = renderToString(
      createElement(JumpConfirm, { mode: 'start', info, onConfirm: noop, onCancel: noop }),
    );
    expect(start).toContain('Start at km 42.3 · 812 m · +3.1 %');
    expect(start).toMatch(/data-testid="route-jump-ok"[^>]*>Start here</);
  });

  it('before the ride: the profile sets the start point, which is marked and can be reset', () => {
    const html = render(
      onRoute(position({ distanceM: 1000, remainingM: 2000 }), 'idle', { startM: 1000 }),
      'ride',
      JUMP_METHODS,
    );
    expect(attr(html, 'route-profile-pick', 'role')).toBe('slider');
    expect(attr(html, 'route-profile-pick', 'data-mode')).toBe('start');
    expect(attr(html, 'route-profile-pick', 'tabindex')).toBe('0');
    expect(attr(html, 'route-profile-pick', 'aria-valuetext')).toMatch(/^km 1\.0 · \d+ m · /);
    expect(attr(html, 'route-profile-pick', 'aria-label')).toContain('Enter sets it as the start');
    expect(attr(html, 'route-ahead-pick', 'role')).toBe('slider');
    expect(html).toContain('data-testid="route-map-pick"');
    expect(attr(html, 'route-start-marker', 'data-at')).toBe('0.3333');
    expect(html).toContain('data-testid="route-map-start-marker"');
    expect(html).toMatch(/data-testid="route-start-note"[^>]*>Starts at km 1\.0</);
    expect(html).toMatch(
      /aria-label="Start from the beginning"[^>]*data-testid="route-start-reset"|data-testid="route-start-reset"[^>]*aria-label="Start from the beginning"/,
    );
    // No confirmation until someone clicks.
    expect(html).not.toContain('data-testid="route-jump-confirm"');
  });

  it('during the ride: the same controls jump, the start is noted, no reset', () => {
    const html = render(
      onRoute(position({ distanceM: 1500 }), 'riding', { startM: 1000 }),
      'ride',
      JUMP_METHODS,
    );
    expect(attr(html, 'route-profile-pick', 'data-mode')).toBe('jump');
    expect(attr(html, 'route-profile-pick', 'aria-label')).toContain('Enter jumps there');
    expect(html).toMatch(/data-testid="route-start-note"[^>]*>Started at km 1\.0</);
    expect(html).not.toContain('data-testid="route-start-reset"');
    // From the beginning: no marker, no note.
    const plain = render(onRoute(position(), 'riding', {}), 'ride', JUMP_METHODS);
    expect(plain).not.toContain('data-testid="route-start-marker"');
    expect(plain).toMatch(/data-testid="route-start-note"[^>]*><\/span>/);
  });

  it('without the methods the route card is as before (no pickers)', () => {
    const html = render(onRoute(position(), 'riding', {}), 'ride');
    expect(html).toContain('data-testid="route-profile"');
    expect(html).not.toContain('data-testid="route-profile-pick"');
    expect(html).not.toContain('data-testid="route-map-pick"');
  });

  const details = (e: RouteEntry, liveState: LiveState | null = live(null, 'idle')): string =>
    renderToString(
      createElement(
        AppContext.Provider,
        { value: stubApp(state(ROUTE_STATE, liveState), JUMP_METHODS) },
        createElement(RouteDetails, {
          entry: e,
          id: 'd1',
          actions: {
            importRoute: () => ({ ok: false as const, errors: [] }),
            select: () => undefined,
            remove: () => undefined,
            exportRoute: () => null,
          },
          sharing: null,
        }),
      ),
    );

  it('Routes tab details: pick a start on the large profile; the stored one is marked', () => {
    const fresh = details(entry());
    expect(attr(fresh, 'route-details-profile-pick', 'role')).toBe('slider');
    expect(attr(fresh, 'route-details-profile-pick', 'data-mode')).toBe('start');
    expect(fresh).toContain(
      'Rides start at the beginning. Click the profile to start somewhere else.',
    );
    expect(fresh).not.toContain('data-testid="route-start-marker"');
    expect(fresh).not.toContain('data-testid="route-start-reset"');

    const stored = details(entry({ startM: 1200 }));
    expect(stored).toContain('The next ride starts at km 1.2.');
    expect(attr(stored, 'route-start-marker', 'data-at')).toBe('0.4000');
    expect(stored).toContain('data-testid="route-map-start-marker"');
    expect(stored).toMatch(/data-testid="route-start-reset"[^>]*>Start from the beginning</);
  });

  it('Routes tab details: locked while riding', () => {
    const html = details(entry({ startM: 1200 }), live(position(), 'riding'));
    expect(attr(html, 'route-details-profile-pick', 'aria-disabled')).toBe('true');
    expect(attr(html, 'route-details-profile-pick', 'tabindex')).toBe('-1');
    expect(html).toMatch(
      /data-testid="route-start-reset"[^>]*disabled=""|disabled=""[^>]*data-testid="route-start-reset"/,
    );
  });
});

describe('importRouteFiles', () => {
  const file = (name: string, text: string, size = text.length): File =>
    ({ name, size, text: async () => text }) as unknown as File;
  let key = 0;
  const next = (): number => ++key;

  it('rejects files over 20 MB without reading them', async () => {
    let read = false;
    const big = {
      name: 'big.gpx',
      size: MAX_ROUTE_IMPORT_BYTES + 1,
      text: async () => ((read = true), ''),
    } as unknown as File;
    const out = await importRouteFiles(
      {
        importRoute: () => ({ ok: false, errors: [] }),
        select: () => undefined,
        remove: () => undefined,
        exportRoute: () => null,
      },
      [big],
      next,
    );
    expect(out[0]!.ok).toBe(false);
    expect(out[0]!.messages[0]).toMatch(/20 MB/);
    expect(read).toBe(false);
  });

  it('reports warnings and errors per file', async () => {
    const actions = {
      importRoute: (text: string) =>
        text === 'good'
          ? {
              ok: true as const,
              entry: entry({ name: 'Good one' }),
              warnings: ['The file has no elevation: the route will be flat.'],
            }
          : { ok: false as const, errors: ['This file has no track points.'] },
      select: () => undefined,
      remove: () => undefined,
      exportRoute: () => null,
    };
    const out = await importRouteFiles(
      actions,
      [file('a.gpx', 'good'), file('b.gpx', 'bad')],
      next,
    );
    expect(out.map((o) => o.ok)).toEqual([true, false]);
    expect(out[0]!.name).toBe('Good one');
    expect(out[0]!.messages[0]).toBe('Note: The file has no elevation: the route will be flat.');
    expect(out[1]!.messages).toEqual(['This file has no track points.']);
  });
});
