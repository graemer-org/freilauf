// The ghost rider's UI (docs/ghost.md): the pure view logic, and server-side renders of the
// start screen picker, the ride chip, the overlay pill and the summary. A .ts file on purpose:
// the root Vitest config only collects *.test.ts.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { getBuiltinRoute } from '@freilauf/routes';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState, GhostState } from '../appStore';
import { NO_GHOST } from '../appStore';
import type { GhostLive, LiveState } from '../../../shared/contract';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { CommunityService } from '../../core/communityService';
import type { GhostCandidate } from '../../core/ghost';
import { OverlayView } from '../../overlay/ui/OverlayView';
import { overlayGhostPill } from '../../overlay/ui/logic';
import {
  NO_ROUTE_GHOST_NOTE,
  ghostChip,
  ghostHint,
  ghostOptions,
  ghostPill,
  ghostSummary,
  selectedGhostOption,
} from './ghostView';
import { MainApp } from './index';

const track = getBuiltinRoute('builtin-rolling-loop') ?? getBuiltinRoute('builtin-steady-climb')!;
const shape = { lengthM: track.totalDistanceM, loop: track.loop };
const NOW = new Date(2026, 10, 26, 12).getTime();

const cand = (
  id: string,
  day: number,
  fullTimeS: number | null,
  extra: Partial<GhostCandidate> = {},
): GhostCandidate => ({
  rideId: id,
  name: track.name,
  startedAt: new Date(2026, 10, day, 18).getTime(),
  fullTimeS,
  fromM: 0,
  toM: track.totalDistanceM,
  continuous: true,
  ...extra,
});

const ghostState = (over: Partial<GhostState> = {}): GhostState => ({
  ...NO_GHOST,
  routeId: track.id,
  candidates: [
    cand('c', 20, 1500),
    cand('b', 12, 1452),
    cand('a', 2, null, { continuous: false, fromM: 3000, toM: 7000 }),
  ],
  bestRideId: 'b',
  choice: 'best',
  active: { kind: 'best', rideId: 'b', label: 'Best time · 24:12' },
  ...over,
});

const racing = (over: Partial<GhostLive> = {}): GhostLive => ({
  status: 'racing',
  label: 'Best time · 24:12',
  gapM: 12.3,
  gapS: 2.06,
  aheadM: -12.3,
  speedMps: 9,
  ghostDone: false,
  note: null,
  splits: [],
  ...over,
});

describe('ghost view logic', () => {
  it('picker: best, last, imported, every earlier ride, none', () => {
    const opts = ghostOptions(
      ghostState({ imported: { name: 'anna', label: 'anna · 23:50', note: null } }),
      shape,
      NOW,
    );
    expect(opts.map((o) => o.value)).toEqual([
      'best',
      'last',
      'import',
      'ride:c',
      'ride:b',
      'ride:a',
      'none',
    ]);
    expect(opts[0]!.label).toBe('My best time · 24:12 (12 Nov)');
    expect(opts[1]!.label).toBe('My last ride · 20 Nov · 25:00');
    expect(opts.find((o) => o.value === 'ride:a')!.label).toBe('2 Nov · jumped · km 3.0–km 7.0');
    expect(selectedGhostOption(ghostState())).toBe('best');
    expect(selectedGhostOption(ghostState({ active: null }))).toBe('none');
    expect(
      selectedGhostOption(ghostState({ active: { kind: 'ride', rideId: 'a', label: '' } })),
    ).toBe('ride:a');
  });

  it('hints: what happens, nothing yet, errors, switched off', () => {
    expect(ghostHint(ghostState(), true)).toBe(
      'Starts when the countdown ends, pauses when you pause.',
    );
    expect(ghostHint(ghostState({ candidates: [], active: null, bestRideId: null }), true)).toMatch(
      /^No earlier ride of this route yet/,
    );
    expect(
      ghostHint(ghostState({ error: 'The ride goes the other way along this route.' }), true),
    ).toBe('The ride goes the other way along this route.');
    expect(ghostHint(ghostState(), false)).toMatch(/off/);
  });

  it('chip: gap with tone, notes while waiting, final gap, a fresh split', () => {
    expect(ghostChip(racing(), 100)).toEqual({
      text: '+12 m · +2.1 s',
      tone: 'ahead',
      title: 'Ghost',
      split: null,
    });
    expect(ghostChip(racing({ gapM: -40, gapS: -4.44, ghostDone: true }), 100)).toMatchObject({
      text: '−40 m · −4.4 s',
      tone: 'behind',
      title: 'Ghost waits at the finish',
    });
    expect(
      ghostChip(racing({ status: 'stopped', note: 'Ghost stopped: it never rode km 7.0' }), 0),
    ).toMatchObject({
      text: 'Ghost stopped: it never rode km 7.0',
      tone: 'quiet',
    });
    expect(ghostChip(racing({ status: 'finished', gapS: -3 }), 0)).toMatchObject({
      text: '−3.0 s',
      title: 'Ghost · final gap',
    });
    const split = { label: 'Lap 1', atM: 4000, gapS: 3.4, atS: 95 };
    expect(ghostChip(racing({ splits: [split] }), 100)!.split).toBe('Lap 1 · +3.4 s');
    expect(ghostChip(racing({ splits: [split] }), 120)!.split).toBeNull();
    expect(ghostChip(null, 0)).toBeNull();
  });

  it('overlay pill only during the ride', () => {
    expect(ghostPill(racing())).toEqual({ text: 'Ghost', detail: '+12 m · +2.1 s', tone: 'ahead' });
    expect(ghostPill(racing({ status: 'ready' }))).toBeNull();
    expect(ghostPill(racing({ status: 'finished', gapS: 1.2 }))).toMatchObject({
      text: 'Ghost · final',
      detail: '+1.2 s',
    });
  });

  it('summary: the verdict, splits and a new best time', () => {
    const v = ghostSummary({
      ghost: {
        label: 'Best time · 24:12',
        gapS: 12.44,
        complete: true,
        splits: [{ label: 'Lap 1', atM: 1, gapS: 4, atS: 1 }],
      },
      routeTime: { timeS: 1440, previousS: 1452 },
    })!;
    expect(v.verdict).toBe('You beat your ghost by 12.4 s');
    expect(v.tone).toBe('ahead');
    expect(v.splits).toEqual(['Lap 1 · +4.0 s']);
    expect(v.best).toBe('New best time on this route: 24:00 (was 24:12)');
    expect(
      ghostSummary({
        ghost: { label: 'x', gapS: -3, complete: false, splits: [] },
        routeTime: null,
      })!.verdict,
    ).toBe('Your ghost was 3.0 s faster (as far as you both rode)');
    expect(ghostSummary({ ghost: null, routeTime: { timeS: 1500, previousS: null } })!.best).toBe(
      'Your first time for the whole route: 25:00',
    );
    expect(ghostSummary({ ghost: null, routeTime: { timeS: 1500, previousS: 1400 } })).toBeNull();
  });
});

// ───────────── server-side renders ─────────────

function live(over: Partial<LiveState> = {}): LiveState {
  return {
    ride: {
      state: 'riding',
      elapsedS: 300,
      distanceM: 2500,
      speedMps: 9,
      powerW: 220,
      power3sW: 220,
      wattsPerKg: 3,
      cadenceRpm: 90,
      heartRateBpm: null,
      gear: 12,
      gearCount: 24,
      gradePercent: 1,
    },
    devices: { trainer: { name: 'Sim', state: 'connected' }, heartRate: null, controller: null },
    group: null,
    localName: 'Ana',
    ...over,
  };
}

function state(over: Partial<AppState> = {}): AppState {
  return {
    ready: true,
    simMode: true,
    settings: structuredClone(DEFAULT_SETTINGS),
    live: live({ ride: { ...live().ride, state: 'idle', elapsedS: 0, distanceM: 0 } }),
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
    routes: [],
    selectedRouteId: null,
    routeTrack: null,
    sharedRoutes: [],
    sharingRouteId: null,
    lastRide: null,
    ...over,
  };
}

function stubApp(s: AppState): App {
  const store = createStore<AppState>(() => s);
  return new Proxy({ store } as unknown as App, {
    get: (target, key) =>
      key in target ? (target as unknown as Record<PropertyKey, unknown>)[key] : () => undefined,
  });
}

const render = (s: AppState, screen: 'start' | 'ride' | 'summary') =>
  renderToString(createElement(MainApp, { app: stubApp(s), initialScreen: screen }));

const entry = {
  id: track.id,
  name: track.name,
  source: 'builtin' as const,
  totalDistanceM: track.totalDistanceM,
  ascentM: track.ascentM,
  descentM: track.descentM,
  loop: track.loop,
  profile: [0, 1],
  outline: [
    [0, 0],
    [1, 1],
  ] as [number, number][],
};

describe('ghost UI (SSR)', () => {
  it('start screen: the picker under the route, with the best time chosen', () => {
    const html = render(
      state({ routes: [entry], selectedRouteId: track.id, routeTrack: track, ghost: ghostState() }),
      'start',
    );
    expect(html).toContain('data-testid="start-ghost"');
    expect(html).toContain('data-active="best"');
    expect(html).toMatch(/<option value="best" selected="">My best time · 24:12/);
    expect(html).toContain('Pick an earlier ride');
    expect(html).toContain('Import a ride file');
    expect(html).not.toContain('data-testid="start-ghost-none"');
  });

  it('start screen: free ride explains why there is no ghost', () => {
    const html = render(state(), 'start');
    expect(html).not.toContain('data-testid="start-ghost"');
    expect(html).toContain(NO_ROUTE_GHOST_NOTE);
  });

  it('ride: the gap chip on the scene', () => {
    const html = render(
      state({
        routes: [entry],
        selectedRouteId: track.id,
        routeTrack: track,
        live: live({ ghost: racing() }),
      }),
      'ride',
    );
    expect(html).toMatch(/data-testid="ghost-chip"[^>]*class|class="ghost-chip is-ahead"/);
    expect(html).toContain('+12 m · +2.1 s');
  });

  it('overlay: the ghost pill', () => {
    const l = live({ ghost: racing({ gapM: -8, gapS: -1.4 }) });
    expect(overlayGhostPill(l)).toMatchObject({ tone: 'behind' });
    expect(overlayGhostPill({ ...l, ride: { ...l.ride, state: 'idle' } })).toBeNull();
    const html = renderToString(
      createElement(OverlayView, { live: l, settings: DEFAULT_SETTINGS.overlay, editMode: false }),
    );
    expect(html).toContain('data-testid="overlay-ghost"');
    expect(html).toContain('−8 m · −1.4 s');
  });

  it('summary: beat your ghost, and the new best time', () => {
    const html = render(
      state({
        lastRide: {
          rideId: 'r',
          durationS: 1440,
          distanceM: 12_000,
          avgPowerW: 200,
          points: 30,
          bests: [],
          workoutName: null,
          routeName: track.name,
          ghost: { label: 'Best time · 24:12', gapS: 12.4, complete: true, splits: [] },
          routeTime: { timeS: 1440, previousS: 1452 },
        },
      }),
      'summary',
    );
    expect(html).toContain('You beat your ghost by 12.4 s');
    expect(html).toContain('New best time on this route: 24:00 (was 24:12)');
  });
});
