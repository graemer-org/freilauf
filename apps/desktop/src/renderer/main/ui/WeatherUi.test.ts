// Server-side render tests of the weather controls (docs/routes.md, "The weather of that day")
// and the wind indicator's words.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { App, AppState, WeatherStatus } from '../appStore';
import type { LiveWind } from '../../../shared/contract';
import { DEFAULT_SETTINGS } from '../../../shared/contract';
import { CommunityService } from '../../core/communityService';
import { AppContext } from './hooks';
import type { RouteEntry } from './routesApi';
import { RouteDetails, RoutesTab } from './RoutesTab';
import { RideWithWindToggle } from './WeatherUi';
import { weatherProgressText, weatherSummaryText, windIndicator } from './weatherView';

const entry = (over: Partial<RouteEntry> = {}): RouteEntry => ({
  id: 'route-mine',
  name: 'Isar valley',
  source: 'imported',
  totalDistanceM: 30_000,
  ascentM: 80,
  descentM: 80,
  loop: false,
  profile: [100, 120, 110],
  outline: [
    [0, 0],
    [100, 100],
  ],
  ...over,
});

const SUMMARY = {
  span: '14 June 2025, 09:12–13:40',
  when: 'recorded' as const,
  meanMps: 3.9,
  maxMps: 6.1,
  mainFromDeg: 225,
  minTempC: 12.2,
  maxTempC: 17.4,
  wet: false,
  conditions: 'Partly cloudy',
  places: 4,
};

function state(
  weather: Record<string, WeatherStatus> = {},
  over: Partial<AppState> = {},
): AppState {
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
    scenery: {},
    routeScenery: null,
    weather,
    routeWind: null,
    ...over,
  } as unknown as AppState;
}

function stubApp(s: AppState, recorded = true): App {
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
    loadWeather: () => true,
    cancelWeather: noop,
    removeWeather: noop,
    setRideWithWind: async () => undefined,
    recordedRideTime: () =>
      recorded ? { startMs: 0, endMs: 1, label: '14 June 2025, 09:12–13:40' } : null,
  } as unknown as App;
}

const actions = {
  importRoute: () => ({ ok: false as const, errors: [] }),
  select: () => undefined,
  remove: () => undefined,
  exportRoute: () => null,
};

const details = (e: RouteEntry, s: AppState, recorded = true): string =>
  renderToString(
    createElement(
      AppContext.Provider,
      { value: stubApp(s, recorded) },
      createElement(RouteDetails, { entry: e, id: 'd', actions, sharing: null }),
    ),
  );

describe('weather controls (SSR)', () => {
  it('offers "Load the weather of that day" on import, unticked, with the privacy note', () => {
    const html = renderToString(
      createElement(
        AppContext.Provider,
        { value: stubApp(state()) },
        createElement(RoutesTab, { onGoToRide: () => undefined }),
      ),
    );
    const box = /<input[^>]*data-testid="route-import-weather"[^>]*>/.exec(html)![0];
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain('checked');
    expect(html).toContain('Load the weather of that day');
    expect(html).toContain(
      'The weather server learns roughly where (to about 10 km) and which day',
    );
    // The day fields only appear once ticked.
    expect(html).not.toContain('route-import-weather-date');
  });

  it('offers the recorded ride’s day, or a day to choose, in an imported route’s details', () => {
    const withTimes = details(entry(), state());
    expect(withTimes).toContain(
      'Load the weather of the recorded ride (14 June 2025, 09:12–13:40)',
    );
    expect(withTimes).toContain('data-testid="route-weather-date"');
    const without = details(entry(), state(), false);
    expect(without).not.toContain('recorded ride (');
    expect(without).toContain('data-testid="route-weather-load-day"');
    expect(details(entry({ id: 'builtin-a', source: 'builtin' }), state())).not.toContain(
      'route-weather',
    );
  });

  it('shows the stored weather with the attribution, remove and load again', () => {
    const html = details(
      entry(),
      state({
        'route-mine': { state: 'ready', summary: SUMMARY, label: '14 June 2025', key: 'k' },
      }),
    );
    expect(html).toContain(
      '14 June 2025, 09:12–13:40 · wind 14 km/h from the south-west, up to 22 km/h · 12–17 °C · Partly cloudy',
    );
    expect(html).toContain('Weather data by Open-Meteo.com (CC BY 4.0)');
    expect(html).toContain('Remove weather');
    expect(html).toContain('Load again with another date');
  });

  it('words progress and errors', () => {
    expect(weatherProgressText({ state: 'loading', done: 0, total: 1, waitS: 5 })).toBe(
      'The weather server is busy; trying again in 5 s…',
    );
    expect(weatherProgressText({ state: 'queued' })).toBe('Waiting to load the weather…');
    const err = details(entry(), state({ 'route-mine': { state: 'error', message: 'No data.' } }));
    expect(err).toContain('No data.');
    expect(weatherSummaryText({ ...SUMMARY, wet: true, conditions: 'Overcast' })).toContain(
      'some rain',
    );
  });

  it('shows "Ride with that day’s wind" on the start screen only for a route with weather', () => {
    const track = { id: 'route-mine', count: 3, elevationM: [0, 0, 0] };
    const profile = { routeId: 'route-mine' };
    const ready = { state: 'ready', summary: SUMMARY, label: '14 June 2025', key: 'k' } as const;
    const render = (s: AppState) =>
      renderToString(
        createElement(
          AppContext.Provider,
          { value: stubApp(s) },
          createElement(RideWithWindToggle),
        ),
      );
    const on = render(
      state({ 'route-mine': ready }, {
        selectedRouteId: 'route-mine',
        routeTrack: track,
        routeWind: profile,
      } as unknown as Partial<AppState>),
    );
    expect(on).toContain('Ride with that day’s wind (14 June 2025)');
    expect(/<input[^>]*data-testid="start-wind-toggle"[^>]*>/.exec(on)![0]).toContain('checked');
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.weather.rideWithWind['route-mine'] = false;
    const off = render(
      state({ 'route-mine': ready }, {
        selectedRouteId: 'route-mine',
        routeTrack: track,
        routeWind: profile,
        settings,
      } as unknown as Partial<AppState>),
    );
    expect(/<input[^>]*data-testid="start-wind-toggle"[^>]*>/.exec(off)![0]).not.toContain(
      'checked',
    );
    expect(render(state())).toBe('');
  });
});

describe('the wind indicator', () => {
  const w = (over: Partial<LiveWind>): LiveWind => ({
    headMps: 0,
    crossMps: 0,
    relativeDeg: 0,
    speed10Mps: 6,
    fromDeg: 200,
    gustMps: 10,
    tempC: 16.6,
    precipMm: 0,
    code: 61,
    label: '14 June 2025',
    active: true,
    ...over,
  });

  it('says head, tail or cross wind at rider height, with the weather', () => {
    expect(windIndicator(w({ headMps: 3.9 }))).toMatchObject({
      text: 'Headwind 14 km/h',
      kind: 'head',
      weather: '17 °C · Rain',
      arrowDeg: 180,
    });
    expect(windIndicator(w({ headMps: -2.5, relativeDeg: 180 }))).toMatchObject({
      text: 'Tailwind 9 km/h',
      kind: 'tail',
      arrowDeg: 360,
    });
    expect(windIndicator(w({ headMps: 0.5, crossMps: -3.4, relativeDeg: -80 }))!.text).toBe(
      'Crosswind 12 km/h',
    );
    expect(windIndicator(w({ headMps: 0.2 }))!.text).toBe('Calm');
    expect(windIndicator(w({ active: false }))!.text).toBe('Wind off in group rides');
    expect(windIndicator(w({ precipMm: 1.2 }))!.rain).toBe(1.2);
    expect(windIndicator(null)).toBeNull();
    expect(windIndicator(w({}))!.title).toBe(
      'Wind of 14 June 2025: 22 km/h from the south at 10 m',
    );
  });
});
