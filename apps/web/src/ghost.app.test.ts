/**
 * The ghost rider through the whole App on the web build's api in simulation mode
 * (docs/ghost.md): a route ridden once becomes the default ghost ("best time"), the choice is
 * remembered per route, a ride file is imported and matched to the route (or refused), and the
 * summary says how the race went.
 */
import { project, unproject } from '@freilauf/routes';
import type { RecordedRide } from '@freilauf/session';
import { encodeFit } from '@freilauf/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../desktop/src/renderer/main/appStore';
import { createBrowserApi } from './browserApi';
import { MemoryRideRecordStore, RideRepository } from './rideRepository';
import { BrowserSettingsStore, webDefaultSettings } from './settingsStore';

/** A 400 m straight, flat GPX road. */
function gpx(): string {
  const pts = Array.from({ length: 41 }, (_, i) => unproject({ lat0: 47.2, lon0: 9.1 }, 0, i * 10));
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Ghost lane</name><trkseg>${pts
    .map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>400</ele></trkpt>`)
    .join('')}</trkseg></trk></gpx>`;
}

async function setup() {
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
  });
  const app = new App(api, null, { storage: null });
  await app.init();
  await vi.advanceTimersByTimeAsync(2000);
  await app.updateSettings({ ride: { countdownS: 0 } });
  const imported = app.importRoute(gpx(), 'lane.gpx');
  if (!imported.ok) throw new Error(imported.errors.join(' '));
  app.selectRoute(imported.entry.id);
  await vi.advanceTimersByTimeAsync(0);
  const state = () => app.store.getState();
  /** Rides `seconds` at `effortW` and finishes. */
  const rideOnce = async (effortW: number, seconds: number) => {
    app.setSimEffort(effortW);
    app.startRide();
    await vi.advanceTimersByTimeAsync(seconds * 1000);
    const done = app.finishRide();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    await vi.advanceTimersByTimeAsync(0);
  };
  return { app, api, rides, state, rideOnce, routeId: imported.entry.id };
}

describe('App: ghost rider', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 1, 17) }));
  afterEach(() => vi.useRealTimers());

  it('no ghost before the route was ridden; afterwards the best time is the default', async () => {
    const { app, state, rideOnce } = await setup();
    expect(state().ghost).toMatchObject({ active: null, candidates: [] });
    await rideOnce(260, 120);
    expect(state().lastRide?.routeTime).toMatchObject({ previousS: null });
    const g = state().ghost!;
    expect(g.candidates).toHaveLength(1);
    expect(g.active).toMatchObject({ kind: 'best' });
    expect(g.active!.label).toMatch(/^Best time · \d+:\d\d$/);
    await vi.advanceTimersByTimeAsync(250); // the next tick shows it
    expect(state().live?.ghost).toMatchObject({ status: 'ready' });

    // Second ride, harder: ahead of the ghost; the summary says by how much.
    app.setSimEffort(400);
    app.startRide();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state().live?.ghost?.status).toBe('racing');
    expect(state().live?.ghost?.gapS).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(70_000);
    const done = app.finishRide();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(state().lastRide?.ghost?.complete).toBe(true);
    expect(state().lastRide?.ghost?.gapS).toBeGreaterThan(1);
    expect(state().lastRide?.routeTime?.previousS).not.toBeNull();
    expect(state().lastRide!.routeTime!.timeS).toBeLessThan(
      state().lastRide!.routeTime!.previousS!,
    );
    app.dispose();
  });

  it('remembers the chosen source per route; "none" switches it off', async () => {
    const { app, state, rideOnce, routeId } = await setup();
    await rideOnce(300, 100);
    await vi.advanceTimersByTimeAsync(60_000);
    await rideOnce(250, 100);
    expect(state().ghost!.candidates).toHaveLength(2);
    await app.chooseGhost('last');
    expect(state().settings?.ghost.sources[routeId]).toBe('last');
    expect(state().ghost!.active).toMatchObject({
      kind: 'last',
      rideId: state().ghost!.candidates[0]!.rideId,
    });
    const older = state().ghost!.candidates[1]!.rideId;
    await app.chooseGhost(`ride:${older}`);
    expect(state().ghost!.active).toMatchObject({ kind: 'ride', rideId: older });
    await app.chooseGhost('none');
    await vi.advanceTimersByTimeAsync(250);
    expect(state().ghost!.active).toBeNull();
    expect(state().live?.ghost ?? null).toBeNull();
    await app.setGhostEnabled(false);
    await app.chooseGhost('best');
    expect(state().ghost!.active).toBeNull();
    await app.setGhostEnabled(true);
    expect(state().ghost!.active).toMatchObject({ kind: 'best' });
    app.dispose();
  });

  it('imports a ride file matched to the route by its GPS track, or says why not', async () => {
    const { app, state, rides, rideOnce } = await setup();
    await rideOnce(280, 100);
    const id = state().rides[0]!.id;
    const ride = (await rides.load(id))!;
    // Our own export of that ride: placed on the route, used as the ghost.
    expect(await app.importGhost(encodeFit(ride), 'Anna morning.fit')).toBeNull();
    expect(state().ghost!.active).toMatchObject({ kind: 'import' });
    expect(state().ghost!.imported!.label).toMatch(/^Anna morning · \d+:\d\d$/);
    expect(state().ghost!.choice).toBe('import');

    // The same ride moved 30 km east: nowhere near.
    const origin = { lat0: 47.2, lon0: 9.1 };
    const moved: RecordedRide = {
      ...ride,
      samples: ride.samples.map((s) => {
        const p = project(origin, s.lat!, s.lon!);
        const q = unproject(origin, p.x + 30_000, p.y);
        return { ...s, lat: q.lat, lon: q.lon };
      }),
    };
    const reason = await app.importGhost(encodeFit(moved), 'elsewhere.fit');
    expect(reason).toMatch(/nowhere near this route/);
    expect(state().ghost!.error).toBe(reason);
    // The earlier import stays in use.
    expect(state().ghost!.active).toMatchObject({ kind: 'import' });
    // A free ride (no positions): cannot be placed.
    const free = {
      ...ride,
      route: undefined,
      samples: ride.samples.map(({ lat: _a, lon: _b, altitudeM: _c, ...s }) => s),
    };
    expect(await app.importGhost(encodeFit(free), 'indoor.fit')).toMatch(/no GPS positions/);
    expect(await app.importGhost(new TextEncoder().encode('hello'), 'x.fit')).toBe(
      'This is not a FIT file.',
    );
    app.dispose();
  });
});
