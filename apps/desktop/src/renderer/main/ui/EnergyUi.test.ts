// Server-side render tests of the energy estimates (docs/energy.md) in the main window and the
// overlay. A .ts file on purpose: the root Vitest config only collects *.test.ts.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState } from '../appStore';
import type { LiveEnergy, LiveState, Settings } from '../../../shared/contract';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { CommunityService } from '../../core/communityService';
import { OverlayView } from '../../overlay/ui/OverlayView';
import { PLACEHOLDER_LIVE } from '../../overlay/ui/logic';
import { formatGrams, formatKcal, statLabel, statUnit, statValue } from './format';
import { MainApp } from './index';

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    ready: true,
    simMode: true,
    settings: structuredClone(DEFAULT_SETTINGS),
    live: live(),
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
    ...overrides,
  };
}

const ENERGY: LiveEnergy = {
  kcal: 611.6,
  source: 'power',
  kcalPower: 611.6,
  kcalHr: 655.2,
  fatG: 30.6,
  carbG: 79.4,
};

function live(overrides: Partial<LiveState> = {}): LiveState {
  return {
    ride: {
      state: 'riding',
      elapsedS: 3600,
      distanceM: 30_000,
      speedMps: 9.5,
      powerW: 213,
      power3sW: 207,
      displayPowerW: 213,
      avgPowerW: 213,
      wattsPerKg: 2.84,
      cadenceRpm: 90,
      heartRateBpm: 142,
      gear: 12,
      gearCount: 24,
      gradePercent: 0,
    },
    devices: {
      trainer: { name: 'Sim trainer', state: 'connected' },
      heartRate: null,
      controller: null,
    },
    group: null,
    localName: 'Ana',
    ...overrides,
  };
}

/** Just enough of `App` for rendering; actions are never called during SSR. */
function stubApp(state: AppState): App {
  const store = createStore<AppState>(() => state);
  return new Proxy({ store } as unknown as App, {
    get: (target, key) =>
      key in target ? (target as unknown as Record<PropertyKey, unknown>)[key] : () => undefined,
  });
}

const render = (
  state: AppState,
  screen: 'ride' | 'summary' | 'settings' | 'history' | 'community',
) => renderToString(createElement(MainApp, { app: stubApp(state), initialScreen: screen }));

const SUMMARY: NonNullable<AppState['lastRide']> = {
  rideId: 'ride-1',
  durationS: 3600,
  distanceM: 30_000,
  avgPowerW: 170,
  points: 40,
  bests: [],
  workoutName: null,
  routeName: null,
  energy: ENERGY,
};

describe('format: energy stats', () => {
  it('labels, units and values', () => {
    expect(statLabel('calories')).toBe('Calories');
    expect(statUnit('calories')).toBe('kcal');
    expect(statLabel('fatGrams')).toBe('Fat (est.)');
    expect(statUnit('fatGrams')).toBe('g');
    const ride = live().ride;
    expect(statValue('calories', ride, null, null, ENERGY)).toBe('612');
    expect(statValue('fatGrams', ride, null, null, ENERGY)).toBe('31');
    expect(statValue('calories', ride)).toBe('–');
    expect(statValue('fatGrams', ride, null, null, { ...ENERGY, fatG: null })).toBe('–');
    expect(statValue('calories', ride, null, null, { ...ENERGY, kcal: null })).toBe('–');
    expect(formatKcal(611.6)).toBe('612 kcal');
    expect(formatKcal(undefined)).toBe('–');
    expect(formatGrams(30.4)).toBe('30 g');
  });
});

describe('ride view (SSR)', () => {
  it('shows kcal and fat so far under the power', () => {
    const html = render(baseState({ live: live({ energy: ENERGY }) }), 'ride');
    expect(html).toMatch(/data-testid="stat-calories".*?>612<.*?>kcal</);
    expect(html).toMatch(/data-testid="stat-fatGrams".*?>31<.*?>g</);
  });

  it('shows a dash when there is nothing to estimate from', () => {
    const html = render(baseState({ live: live({ energy: null }) }), 'ride');
    expect(html).toMatch(/data-testid="stat-calories".*?>–</);
  });
});

describe('overlay tiles (SSR)', () => {
  const settings = {
    ...DEFAULT_SETTINGS.overlay,
    tiles: [
      { stat: 'calories', size: 'm' },
      { stat: 'fatGrams', size: 's' },
    ] as Settings['overlay']['tiles'],
  };
  it('renders calories and fat tiles from the live energy', () => {
    const html = renderToString(
      createElement(OverlayView, { live: live({ energy: ENERGY }), settings, editMode: false }),
    );
    expect(html).toMatch(/data-testid="overlay-tile-calories".*?>612<.*?>kcal</);
    expect(html).toMatch(/data-testid="overlay-tile-fatGrams".*?>31<.*?>g</);
  });

  it('shows sample values in edit mode', () => {
    expect(PLACEHOLDER_LIVE.energy?.kcal).toBeGreaterThan(0);
    const html = renderToString(
      createElement(OverlayView, { live: null, settings, editMode: true }),
    );
    expect(html).toMatch(/data-testid="overlay-tile-calories".*?>612</);
  });
});

describe('post-ride summary (SSR)', () => {
  it('kcal from power, heart-rate cross-check, fat and carbohydrate with a rough-estimate note', () => {
    const html = render(baseState({ lastRide: SUMMARY }), 'summary');
    expect(html).toMatch(/data-testid="summary-energy" data-source="power"/);
    expect(html).toMatch(/data-testid="summary-kcal".*?>612<.*?>kcal</);
    expect(html).toMatch(/data-testid="summary-kcal-hr".*?>655<.*?>kcal</);
    expect(html).toMatch(/data-testid="summary-fat".*?>31<.*?>g</);
    expect(html).toMatch(/data-testid="summary-carb".*?>79<.*?>g</);
    expect(html).toContain('data-testid="summary-energy-rough"');
    expect(html).toContain('rough estimate');
    expect(html).toContain('data-testid="energy-info"');
    expect(html).toContain('Keytel');
  });

  it('asks for age and sex when the cross-check is missing for want of them', () => {
    const html = render(
      baseState({ lastRide: { ...SUMMARY, energy: { ...ENERGY, kcalHr: null } } }),
      'summary',
    );
    expect(html).toMatch(/data-testid="summary-kcal-hr".*?Add age and sex in Settings/);
  });

  it('labels a heart-rate-only total and omits the split', () => {
    const html = render(
      baseState({
        lastRide: {
          ...SUMMARY,
          energy: {
            kcal: 480,
            source: 'heartRate',
            kcalPower: null,
            kcalHr: 480,
            fatG: null,
            carbG: null,
          },
        },
      }),
      'summary',
    );
    expect(html).toMatch(/data-testid="summary-kcal".*?Calories \(from heart rate\).*?>480</);
    expect(html).not.toContain('summary-kcal-hr');
    expect(html).not.toContain('summary-fat');
    expect(html).not.toContain('summary-energy-rough');
  });

  it('shows nothing without power or heart rate', () => {
    const html = render(baseState({ lastRide: { ...SUMMARY, energy: null } }), 'summary');
    expect(html).not.toContain('summary-energy');
  });
});

describe('settings and history (SSR)', () => {
  it('offers optional age and sex with one line on what they are for', () => {
    const html = render(
      baseState({ live: live({ ride: { ...live().ride, state: 'idle' } }) }),
      'settings',
    );
    expect(html).toContain('data-testid="settings-age"');
    expect(html).toContain('data-testid="settings-sex"');
    expect(html).toContain('Only used for the heart-rate calorie estimate');
    expect(html).toContain('Prefer not to say');
  });

  it('lists kcal per ride', () => {
    const html = render(
      baseState({
        live: live({ ride: { ...live().ride, state: 'idle' } }),
        rides: [
          {
            id: 'r1',
            name: 'Ride',
            startedAt: Date.UTC(2026, 10, 20),
            durationS: 3600,
            distanceM: 30_000,
            avgPowerW: 170,
            kcal: 610,
            finished: true,
          },
        ],
      }),
      'history',
    );
    expect(html).toMatch(/data-testid="history-kcal">610 kcal</);
  });

  it('shows the week energy in kcal next to kJ', () => {
    const state = baseState({ live: live({ ride: { ...live().ride, state: 'idle' } }) });
    const week = state.community.week;
    state.community = {
      ...state.community,
      week: { ...week, totals: { ...week.totals, rides: 2, energyKj: 1000 } },
    };
    const html = render(state, 'community');
    // 1000 kJ / (4.184 × 0.24) = 995.9 kcal
    expect(html).toMatch(/data-testid="community-week-kcal">≈ 996 kcal</);
  });
});
