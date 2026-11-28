/**
 * Scenery along routes through the whole App on the web build's api (docs/routes.md,
 * "Surroundings from OpenStreetMap"): off unless asked for on import, fetched once through a
 * fake Overpass server, stored, handed to the scenes for the selected route, removable — and
 * the ride itself (recording, trainer gradient) is the same with or without it.
 */
import { unproject } from '@freilauf/routes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../desktop/src/renderer/main/appStore';
import { sceneScenery } from '../../desktop/src/renderer/main/ui/routesApi';
import { createBrowserApi } from './browserApi';
import { MemoryRideRecordStore, RideRepository } from './rideRepository';
import { MemorySceneryStore } from './sceneryStore';
import { BrowserSettingsStore, webDefaultSettings } from './settingsStore';

const ORIGIN = { lat0: 47.2, lon0: 9.1 };

/** A 2 km straight road north. */
function gpx(): string {
  const pts = Array.from({ length: 201 }, (_, i) => unproject(ORIGIN, 0, i * 10));
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Village road</name><trkseg>${pts
    .map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>500</ele></trkpt>`)
    .join('')}</trkseg></trk></gpx>`;
}

/** Overpass JSON: houses on both sides from 300 to 700 m, a wood on the left. */
function overpassAnswer(): string {
  const ll = (x: number, y: number) => unproject(ORIGIN, x, y);
  const box = (x0: number, y0: number, x1: number, y1: number) => [
    ll(x0, y0),
    ll(x1, y0),
    ll(x1, y1),
    ll(x0, y1),
    ll(x0, y0),
  ];
  const elements: unknown[] = [];
  let id = 1;
  for (let y = 300; y <= 700; y += 25) {
    elements.push({
      type: 'way',
      id: id++,
      tags: { building: 'house' },
      geometry: box(12, y, 22, y + 9),
    });
    elements.push({
      type: 'way',
      id: id++,
      tags: { building: 'yes' },
      geometry: box(-24, y, -14, y + 10),
    });
  }
  elements.push({
    type: 'way',
    id: id++,
    tags: { landuse: 'forest' },
    geometry: box(-200, 900, -8, 1500),
  });
  elements.push({
    type: 'node',
    id: id++,
    ...ll(40, 500),
    tags: { place: 'village', name: 'Testdorf' },
  });
  return JSON.stringify({ version: 0.6, elements });
}

async function setup() {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const scenery = new MemorySceneryStore();
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
    scenery,
    fetch: async (url, init) => {
      calls.push({ url, body: init.body ?? '', headers: init.headers });
      return { status: 200, headers: { get: () => null }, text: async () => overpassAnswer() };
    },
  });
  const app = new App(api, null, {
    storage: null,
    sceneryFetch: { pauseMs: 0, backoffMs: 1 },
  });
  await app.init();
  await vi.advanceTimersByTimeAsync(2000);
  await app.updateSettings({ ride: { countdownS: 0 } });
  const state = () => app.store.getState();
  return { app, api, rides, scenery, calls, state };
}

describe('App: scenery along routes', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 26, 17) }));
  afterEach(() => vi.useRealTimers());

  it('does not touch the network unless asked: the import option is off by default', async () => {
    const { app, calls, state } = await setup();
    const r = app.importRoute(gpx(), 'road.gpx');
    if (!r.ok) throw new Error(r.errors.join(' '));
    app.selectRoute(r.entry.id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);
    expect(state().scenery?.[r.entry.id]).toBeUndefined();
    expect(state().routeScenery).toBeNull();
    // Built-in routes never get any.
    expect(app.loadScenery(state().routes.find((e) => e.source === 'builtin')!.id)).toBe(false);
    app.dispose();
  });

  it('loads, stores and shows the surroundings when ticked on import; removes them again', async () => {
    const { app, calls, scenery, state } = await setup();
    const r = app.importRoute(gpx(), 'road.gpx', { scenery: true });
    if (!r.ok) throw new Error(r.errors.join(' '));
    const id = r.entry.id;
    expect(state().scenery?.[id]?.state).toMatch(/queued|loading/);
    app.selectRoute(id);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.url).toBe('https://overpass-api.de/api/interpreter');
    expect(calls[0]!.body.startsWith('data=')).toBe(true);
    expect(calls[0]!.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const st = state().scenery?.[id];
    expect(st?.state).toBe('ready');
    if (st?.state !== 'ready') return;
    expect(st.summary?.buildings).toBe(34);
    expect(st.summary?.places).toEqual(['Testdorf']);
    expect((await scenery.list()).map((f) => f.routeId)).toEqual([id]);
    expect(
      state().notices.some((n) => /Surroundings of “Village road” loaded/.test(n.message)),
    ).toBe(true);

    // The scenes get the selected route's model; the setting hides it.
    expect(state().routeScenery?.buildings).toHaveLength(34);
    expect(sceneScenery(state())).toBe(state().routeScenery);
    await app.updateSettings({ scenery: { enabled: false } });
    expect(sceneScenery(state())).toBeNull();
    await app.updateSettings({ scenery: { enabled: true } });

    // Nothing is fetched again at ride time.
    const before = calls.length;
    app.startRide();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(before);
    app.pauseRide();

    await app.removeScenery(id);
    expect(state().scenery?.[id]).toBeUndefined();
    expect(state().routeScenery).toBeNull();
    expect(await scenery.list()).toEqual([]);
    app.dispose();
  });

  it('cancels a fetch on request and keeps nothing', async () => {
    const { app, scenery, state } = await setup();
    const r = app.importRoute(gpx(), 'road.gpx');
    if (!r.ok) throw new Error(r.errors.join(' '));
    app.loadScenery(r.entry.id);
    app.cancelScenery(r.entry.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(state().scenery?.[r.entry.id]).toBeUndefined();
    expect(await scenery.list()).toEqual([]);
    app.dispose();
  });

  it('records the same ride and drives the trainer the same with or without scenery', async () => {
    const ride = async (withScenery: boolean) => {
      vi.setSystemTime(Date.UTC(2026, 10, 26, 17));
      const { app, rides, state } = await setup();
      const r = app.importRoute(gpx(), 'road.gpx', { scenery: withScenery });
      if (!r.ok) throw new Error(r.errors.join(' '));
      app.selectRoute(r.entry.id);
      await vi.advanceTimersByTimeAsync(100);
      expect(state().routeScenery !== null).toBe(withScenery);
      app.setSimEffort(300);
      app.startRide();
      const grades: (number | null)[] = [];
      for (let i = 0; i < 60; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        grades.push(state().live?.routeControl?.trainerGradePercent ?? null);
      }
      const done = app.finishRide();
      await vi.advanceTimersByTimeAsync(0);
      await done;
      await vi.advanceTimersByTimeAsync(0);
      const list = await rides.list();
      const recorded = await rides.load(list[0]!.id);
      app.dispose();
      return { samples: recorded!.samples, route: recorded!.route ?? null, grades };
    };
    const plain = await ride(false);
    const scenic = await ride(true);
    expect(plain.samples.length).toBeGreaterThan(50);
    expect(scenic.samples).toEqual(plain.samples);
    expect(scenic.route).toEqual(plain.route);
    expect(scenic.grades).toEqual(plain.grades);
  });
});
