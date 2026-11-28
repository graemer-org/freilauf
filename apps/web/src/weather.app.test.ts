/**
 * The weather of a day along routes through the whole App on the web build's api (docs/routes.md,
 * "The weather of that day"): off unless asked for on import, fetched once from a fake archive
 * (the documented JSON format), stored next to the route, ridden with (slower into the wind),
 * flagged in the ride and its summary, switchable per route, removable.
 */
import { unproject } from '@freilauf/routes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../desktop/src/renderer/main/appStore';
import { WEATHER_KEY_PREFIX } from '../../desktop/src/renderer/core/weatherService';
import { ROUTE_TIMES_KEY_PREFIX } from '../../desktop/src/renderer/core/routeLibrary';
import { createBrowserApi } from './browserApi';
import { MemoryRideRecordStore, RideRepository } from './rideRepository';
import { BrowserSettingsStore, webDefaultSettings } from './settingsStore';

const ORIGIN = { lat0: 47.5, lon0: 11.4 };
const T0 = Date.UTC(2025, 5, 14, 7, 12);

/** 3 km straight north, recorded at 5 m/s from 14 June 2025, 09:12 local (07:12 UTC). */
function gpx(times = true): string {
  const pts = Array.from({ length: 301 }, (_, i) => unproject(ORIGIN, 0, i * 10));
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${times ? 'Recorded' : 'Planned'} road</name><trkseg>${pts
    .map(
      (p, i) =>
        `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>500</ele>${
          times ? `<time>${new Date(T0 + i * 2000).toISOString()}</time>` : ''
        }</trkpt>`,
    )
    .join('')}</trkseg></trk></gpx>`;
}

/** The archive's answer for the places asked: a steady 6 m/s north wind, 17 °C, light rain. */
function answer(url: string): string {
  const q = new URL(url).searchParams;
  const n = q.get('latitude')!.split(',').length;
  const from = Date.parse(`${q.get('start_date')}T00:00Z`) / 1000;
  const to = Date.parse(`${q.get('end_date')}T23:00Z`) / 1000;
  const time: number[] = [];
  for (let t = from; t <= to; t += 3600) time.push(t);
  const col = (v: number | null) => time.map(() => v);
  const one = {
    latitude: 47.5,
    longitude: 11.4,
    utc_offset_seconds: 7200,
    timezone: 'Europe/Berlin',
    hourly: {
      time,
      wind_speed_10m: col(6),
      wind_direction_10m: col(0),
      wind_gusts_10m: col(11),
      temperature_2m: col(17),
      precipitation: col(0.4),
      weather_code: col(61),
    },
  };
  return JSON.stringify(n === 1 ? one : Array.from({ length: n }, () => one));
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

async function setup(storage = memoryStorage()) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const rides = new RideRepository(new MemoryRideRecordStore(), () => {});
  const api = createBrowserApi({
    settings: new BrowserSettingsStore({
      storage: null,
      defaults: webDefaultSettings({ protocol: 'http:', host: 'localhost:8080' }),
      log: () => {},
    }),
    rides,
    simMode: true,
    bleLogEnabled: false,
    overlayWindow: null,
    diagnosticsLimit: 50,
    sessionHeader: false,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers });
      return { status: 200, headers: { get: () => null }, text: async () => answer(url) };
    },
  });
  const app = new App(api, null, {
    storage,
    weatherFetch: { pauseMs: 0, backoffMs: 1 },
  });
  await app.init();
  await vi.advanceTimersByTimeAsync(2000);
  await app.updateSettings({ ride: { countdownS: 0 } });
  const state = () => app.store.getState();
  return { app, rides, calls, state, storage };
}

async function rideFor(app: App, rides: RideRepository, seconds: number) {
  app.setSimEffort(250);
  app.startRide();
  await vi.advanceTimersByTimeAsync(seconds * 1000);
  const done = app.finishRide();
  await vi.advanceTimersByTimeAsync(0);
  await done;
  await vi.advanceTimersByTimeAsync(0);
  const list = await rides.list();
  return (await rides.load(list[0]!.id))!;
}

describe('App: the weather of a day along routes', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 26, 17) }));
  afterEach(() => vi.useRealTimers());

  it('does not touch the network unless asked: the import option is off by default', async () => {
    const { app, calls, state } = await setup();
    const r = app.importRoute(gpx(), 'road.gpx');
    if (!r.ok) throw new Error(r.errors.join(' '));
    expect(r.weather).toBeUndefined();
    app.selectRoute(r.entry.id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);
    expect(state().weather?.[r.entry.id]).toBeUndefined();
    expect(state().routeWind).toBeNull();
    // The recorded times are kept for later, in route storage.
    expect(app.recordedRideTime(r.entry.id)?.startMs).toBe(T0);
    // Built-in routes never load any.
    expect(app.loadWeather(state().routes.find((e) => e.source === 'builtin')!.id)).toBe(false);
    app.dispose();
  });

  it('loads the recorded day on import, rides slower into its wind, flags the ride', async () => {
    const { app, calls, state, rides, storage } = await setup();
    const r = app.importRoute(gpx(), 'road.gpx', { weather: true });
    if (!r.ok) throw new Error(r.errors.join(' '));
    expect(r.weather).toMatch(/^Weather of the recorded ride: 14 June 2025, \d\d:12–\d\d:22\.$/);
    const id = r.entry.id;
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://archive-api.open-meteo.com/v1/archive');
    expect(url.searchParams.get('start_date')).toBe('2025-06-13');
    expect(url.searchParams.get('end_date')).toBe('2025-06-15');
    expect(url.searchParams.get('latitude')).toBe('47.5');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers).toEqual({});
    const st = state().weather?.[id];
    expect(st?.state).toBe('ready');
    if (st?.state !== 'ready') return;
    expect(st.label).toBe('14 June 2025');
    expect(storage.map.get(WEATHER_KEY_PREFIX + id)).toContain('"freilauf-weather"');
    expect(state().notices.some((n) => /Weather of 14 June 2025 loaded/.test(n.message))).toBe(
      true,
    );

    app.selectRoute(id);
    expect(state().routeWind?.routeId).toBe(id);
    const fetched = calls.length;
    const windy = await rideFor(app, rides, 60);
    expect(calls.length).toBe(fetched); // nothing fetched at ride time
    expect(windy.route?.weather).toEqual({ key: '2025-06-14T09:12', label: '14 June 2025' });
    expect(state().lastRide?.windLabel).toBe('14 June 2025');

    // Switched off for this route (remembered): ridden without wind, not flagged.
    await app.setRideWithWind(id, false);
    expect(state().settings?.weather.rideWithWind[id]).toBe(false);
    const calm = await rideFor(app, rides, 60);
    expect(calm.route?.weather).toBeUndefined();
    expect(state().lastRide?.windLabel).toBeUndefined();
    // Into a 6 m/s north wind on a road north: clearly less distance at the same effort.
    expect(windy.samples.at(-1)!.distanceM).toBeLessThan(calm.samples.at(-1)!.distanceM * 0.95);
    app.dispose();
  });

  it('shows the wind while riding and the light rain of that hour', async () => {
    const { app, state } = await setup();
    const r = app.importRoute(gpx(), 'road.gpx', { weather: true });
    if (!r.ok) throw new Error('no');
    await vi.advanceTimersByTimeAsync(100);
    app.selectRoute(r.entry.id);
    app.startRide();
    await vi.advanceTimersByTimeAsync(20_000);
    const w = state().live?.wind;
    expect(w?.headMps).toBeGreaterThan(3.5); // 6 m/s × 0.65 = 3.9 at rider height
    expect(w).toMatchObject({ tempC: 17, code: 61, active: true });
    expect(w!.precipMm).toBeCloseTo(0.4, 6);
    app.pauseRide();
    app.dispose();
  });

  it('without times: asks for a day; loads the chosen day; replaces and removes it', async () => {
    const { app, calls, state, storage } = await setup();
    const r = app.importRoute(gpx(false), 'plan.gpx', { weather: true });
    if (!r.ok) throw new Error('no');
    expect(r.weather).toMatch(/choose a day/);
    expect(app.recordedRideTime(r.entry.id)).toBeNull();
    expect(app.loadWeather(r.entry.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(0);
    // Or on import with a day picked next to the option.
    const r2 = app.importRoute(gpx(false), 'plan.gpx', {
      weather: true,
      weatherDay: { date: '2024-03-02', time: '' },
    });
    if (!r2.ok) throw new Error('no');
    expect(r2.weather).toBe('No times in this file: weather of 2024-03-02, from 10:00.');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get('start_date')).toBe('2024-03-01');
    const st = state().weather?.[r.entry.id];
    expect(st?.state === 'ready' && st.key).toBe('2024-03-02T10:00');
    // Load again with another day: replaces it.
    expect(app.loadWeather(r.entry.id, { date: '2023-08-10', time: '07:30' })).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const again = state().weather?.[r.entry.id];
    expect(again?.state === 'ready' && again.key).toBe('2023-08-10T07:30');
    app.removeWeather(r.entry.id);
    expect(state().weather?.[r.entry.id]).toBeUndefined();
    expect(storage.map.has(WEATHER_KEY_PREFIX + r.entry.id)).toBe(false);
    app.dispose();
  });

  it('keeps the weather across restarts and removes it with the route', async () => {
    const storage = memoryStorage();
    const first = await setup(storage);
    const r = first.app.importRoute(gpx(), 'road.gpx', { weather: true });
    if (!r.ok) throw new Error('no');
    await vi.advanceTimersByTimeAsync(100);
    first.app.dispose();
    const second = await setup(storage);
    expect(second.state().weather?.[r.entry.id]?.state).toBe('ready');
    second.app.selectRoute(r.entry.id);
    expect(second.state().routeWind?.routeId).toBe(r.entry.id);
    expect(second.calls).toHaveLength(0);
    second.app.deleteRoute(r.entry.id);
    expect(storage.map.has(WEATHER_KEY_PREFIX + r.entry.id)).toBe(false);
    expect(storage.map.has(ROUTE_TIMES_KEY_PREFIX + r.entry.id)).toBe(false);
    second.app.dispose();
  });

  it('cancels a fetch on request and keeps nothing', async () => {
    const { app, state } = await setup();
    const r = app.importRoute(gpx(), 'road.gpx');
    if (!r.ok) throw new Error('no');
    app.loadWeather(r.entry.id);
    app.cancelWeather(r.entry.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(state().weather?.[r.entry.id]).toBeUndefined();
    app.dispose();
  });
});
