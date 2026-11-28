/**
 * Riding a route with the wind of a day (docs/adr/0012-historical-wind.md): the head/tail wind
 * at the rider's place changes speed and distance through the air resistance, eases in, is
 * sent (scaled like the gradient) to the trainer, is flagged in the recorded ride, and is not
 * used in a group ride. Without wind everything is as before.
 */
import type { RouteTrack, WindProfile } from '@freilauf/routes';
import { WEATHER_ATTRIBUTION, buildRoute, parseGpx, unproject } from '@freilauf/routes';
import type { RecordedRide } from '@freilauf/session';
import { createSimulatedRig } from '@freilauf/sim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, Settings } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import { NULL_LOG } from './logger';
import { type GroupLink, RideController, type WindSpec } from './rideController';

/** 10 km straight north, flat. */
function road(): RouteTrack {
  const pts = Array.from({ length: 101 }, (_, i) =>
    unproject({ lat0: 47.5, lon0: 11.4 }, 0, i * 100),
  );
  const parsed = parseGpx(
    `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>North road</name><trkseg>${pts
      .map(
        (p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>500</ele></trkpt>`,
      )
      .join('')}</trkseg></trk></gpx>`,
  );
  if (!parsed.ok) throw new Error('bad gpx');
  return buildRoute(parsed.track);
}

function wind(track: RouteTrack, speedMps: number, fromDeg: number): WindSpec {
  const profile: WindProfile = {
    routeId: track.id,
    totalDistanceM: track.totalDistanceM,
    loop: false,
    fetchedAt: 0,
    attribution: WEATHER_ATTRIBUTION,
    when: 'chosen',
    startMs: Date.UTC(2025, 5, 14, 8),
    endMs: Date.UTC(2025, 5, 14, 9),
    utcOffsetS: 7200,
    points: [
      { alongM: 0, speedMps, fromDeg, gustMps: speedMps * 2, tempC: 18, precipMm: 0, code: 1 },
    ],
  };
  return { profile, key: '2025-06-14T10:00', label: '14 June 2025' };
}

describe('RideController with the wind of a day', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) }));
  afterEach(() => vi.useRealTimers());

  async function ride(
    spec: ((t: RouteTrack) => WindSpec) | null,
    seconds = 120,
    settings: Settings = DEFAULT_SETTINGS,
    group = false,
  ) {
    const track = road();
    const rig = createSimulatedRig({ seed: 5, trainer: { riderEffortW: 220 } });
    const saved: RecordedRide[] = [];
    let live: LiveState | null = null;
    const controller = new RideController({
      settings,
      log: NULL_LOG,
      onLive: (s) => (live = s),
      saveRide: async (r, finished) => void (finished && saved.push(r)),
    });
    controller.setDevice('trainer', rig.trainer);
    const connecting = rig.trainer.connect();
    await vi.advanceTimersByTimeAsync(1000);
    await connecting;
    expect(controller.selectRoute(track)).toBe(true);
    if (spec) expect(controller.setWind(spec(track))).toBe(true);
    if (group) {
      const link = {
        roomCode: 'ABC',
        setLocalState: () => undefined,
        getRiders: () => [],
      } as unknown as GroupLink;
      controller.setGroup(link);
    }
    controller.start();
    const heads: number[] = [];
    for (let i = 0; i < seconds * 4; i++) {
      await vi.advanceTimersByTimeAsync(250);
      controller.tick();
      heads.push(live!.wind?.headMps ?? 0);
    }
    const last = live!;
    await controller.finish();
    const winds = rig.trainer.commands.flatMap((c) =>
      c.type === 'simulation' ? [c.params.windSpeedMps] : [],
    );
    await rig.dispose();
    return { last, ride: saved[0]!, heads, winds, controller };
  }

  it('a headwind slows the ride, a tailwind speeds it; power is recorded as measured', async () => {
    const calm = await ride(null);
    const head = await ride((t) => wind(t, 6, 0));
    const tail = await ride((t) => wind(t, 6, 180));
    const d = (r: Awaited<ReturnType<typeof ride>>) => r.ride.samples.at(-1)!.distanceM;
    expect(d(head)).toBeLessThan(d(calm) * 0.93);
    expect(d(tail)).toBeGreaterThan(d(calm) * 1.05);
    // The wind at rider height: 6 m/s at 10 m × 0.65 in the open.
    expect(head.last.wind!.headMps).toBeCloseTo(3.9, 1);
    expect(tail.last.wind!.headMps).toBeCloseTo(-3.9, 1);
    expect(head.last.wind).toMatchObject({ active: true, label: '14 June 2025', tempC: 18 });
    // Without wind no wind field at all, and the trainer never gets any.
    expect(calm.last.wind).toBeUndefined();
    expect(calm.winds.every((w) => w === 0)).toBe(true);
    // Power is what the rider produced: similar in all three (the trainer holds the effort).
    const avg = (r: Awaited<ReturnType<typeof ride>>) =>
      r.ride.samples.reduce((a, s) => a + s.powerW, 0) / r.ride.samples.length;
    expect(Math.abs(avg(head) - avg(calm))).toBeLessThan(avg(calm) * 0.2);
  });

  it('eases the wind in instead of stepping', async () => {
    const head = await ride((t) => wind(t, 6, 0), 30);
    // From calm at the start to the full wind over a few seconds (time constant 4 s).
    expect(head.heads[0]).toBeLessThan(1);
    for (let i = 1; i < head.heads.length; i++) {
      expect(head.heads[i]!).toBeGreaterThanOrEqual(head.heads[i - 1]! - 1e-9);
      expect(head.heads[i]! - head.heads[i - 1]!).toBeLessThan(0.3);
    }
    expect(head.heads[4 * 20]!).toBeCloseTo(3.9, 1);
  });

  it('tells the trainer, scaled by the difficulty like the gradient, rate-limited', async () => {
    const full = await ride((t) => wind(t, 6, 0), 30);
    const half = await ride((t) => wind(t, 6, 0), 30, {
      ...DEFAULT_SETTINGS,
      route: { difficulty: 50 },
    });
    const sentFull = full.winds.filter((w) => w !== 0);
    const sentHalf = half.winds.filter((w) => w !== 0);
    expect(sentFull.length).toBeGreaterThan(0);
    expect(sentFull.length).toBeLessThan(10);
    // In the physical gear (12 = 2.4) the trainer gets the felt wind unscaled.
    expect(sentFull.at(-1)!).toBeCloseTo(3.9, 0);
    expect(sentHalf.at(-1)!).toBeCloseTo(sentFull.at(-1)! / 2, 0);
  });

  it('flags the ride as ridden with wind; a ride without wind carries no flag', async () => {
    const head = await ride((t) => wind(t, 6, 0), 20);
    expect(head.ride.route?.weather).toEqual({ key: '2025-06-14T10:00', label: '14 June 2025' });
    const calm = await ride(null, 20);
    expect(calm.ride.route).toBeDefined();
    expect(calm.ride.route!.weather).toBeUndefined();
  });

  it('is not used in a group ride (everyone rides the same air), and not flagged', async () => {
    const calm = await ride(null, 60, DEFAULT_SETTINGS, true);
    const grouped = await ride((t) => wind(t, 6, 0), 60, DEFAULT_SETTINGS, true);
    expect(grouped.last.wind).toMatchObject({ active: false, headMps: 0 });
    expect(grouped.ride.samples.at(-1)!.distanceM).toBeCloseTo(
      calm.ride.samples.at(-1)!.distanceM,
      0,
    );
    expect(grouped.ride.route?.weather).toBeUndefined();
  });

  it('only takes a profile of the selected route, and only before the ride', async () => {
    const track = road();
    const c = new RideController({
      settings: DEFAULT_SETTINGS,
      log: NULL_LOG,
      onLive: () => undefined,
      saveRide: async () => undefined,
    });
    const spec = wind(track, 5, 0);
    expect(c.setWind(spec)).toBe(false); // no route
    c.selectRoute(track);
    expect(c.setWind({ ...spec, profile: { ...spec.profile, routeId: 'route-other' } })).toBe(
      false,
    );
    expect(c.setWind(spec)).toBe(true);
    c.start();
    expect(c.setWind(null)).toBe(false);
    await c.finish();
    // Another route drops it.
    c.selectRoute(null);
    expect(c.wind).toBeNull();
  });
});
