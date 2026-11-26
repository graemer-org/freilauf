/**
 * The ghost rider in the ride controller (docs/ghost.md): a ride's own recording becomes the
 * ghost of the next ride on the same route, the race follows the countdown, pauses and jumps,
 * and — like the Rumble integration tests — the ghost changes nothing that is recorded or sent
 * to the trainer: the RecordedRide, the .fit bytes, the community facts and every trainer
 * command are identical with and without it.
 */
import type { SimulationParams, Trainer, TrainerData } from '@freilauf/devices';
import { rideFacts } from '@freilauf/community';
import type { RawPoint, RouteTrack } from '@freilauf/routes';
import { buildRoute, routeBaseId, unproject } from '@freilauf/routes';
import type { RecordedRide } from '@freilauf/session';
import { encodeFit, rideGhost, rideRouteInfo } from '@freilauf/session';
import { describe, expect, it } from 'vitest';
import type { LiveState, Settings } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import type { GhostSpec } from './rideController';
import { RideController } from './rideController';

class FakeTrainer implements Trainer {
  readonly id = 'fake-trainer';
  readonly name = 'Fake trainer';
  readonly kind = 'trainer' as const;
  readonly state = 'connected' as const;
  readonly commands: SimulationParams[] = [];
  readonly #listeners = new Set<(d: TrainerData) => void>();
  onData(l: (d: TrainerData) => void) {
    this.#listeners.add(l);
    return () => void this.#listeners.delete(l);
  }
  onState() {
    return () => {};
  }
  async connect() {}
  async disconnect() {}
  setSimulation(p: SimulationParams) {
    this.commands.push({ ...p });
    return Promise.resolve();
  }
  setTargetPower() {
    return Promise.resolve();
  }
  push(powerW: number) {
    for (const l of this.#listeners) l({ powerW, cadenceRpm: 90 });
  }
}

/** 1.5 km north with a gentle rise in the middle. */
function road(): RouteTrack {
  const points: RawPoint[] = [];
  for (let i = 0; i <= 150; i++) {
    const e = 400 + (i > 50 && i < 100 ? (i - 50) * 0.3 : i >= 100 ? 15 : 0);
    points.push({ ...unproject({ lat0: 46.9, lon0: 7.4 }, 0, i * 10), ele: e });
  }
  return buildRoute({ name: 'Ghost test road', hasElevation: true, points });
}

const T0 = Date.UTC(2026, 10, 3, 18);

function rider(settings: Settings = DEFAULT_SETTINGS, t0 = T0) {
  let now = t0;
  const saved: RecordedRide[] = [];
  let live: LiveState | null = null;
  const c = new RideController({
    settings,
    now: () => now,
    onLive: (l) => (live = l),
    saveRide: async (r, finished) => void (finished && saved.push(r)),
  });
  const trainer = new FakeTrainer();
  c.setDevice('trainer', trainer);
  const run = (
    seconds: number,
    powerW: number | ((s: number) => number),
    each?: (l: LiveState) => void,
  ) => {
    for (let i = 0; i < seconds * 4; i++) {
      now += 250;
      trainer.push(typeof powerW === 'number' ? powerW : powerW(i / 4));
      c.tick();
      each?.(live!);
    }
    return live!;
  };
  return { c, trainer, saved, run, live: () => live!, advance: (ms: number) => (now += ms) };
}

const ghostOf = (ride: RecordedRide, label = 'Last ride'): GhostSpec => {
  const g = rideGhost(ride)!;
  return { routeId: g.routeId, trace: g.trace, label };
};

describe('RideController: ghost rider', () => {
  it('a route ride records its route; it becomes the ghost of the next ride', async () => {
    const track = road();
    const a = rider();
    a.c.selectRoute(track);
    a.c.start();
    a.run(400, 220);
    await a.c.finish();
    const first = a.saved[0]!;
    expect(first.route).toEqual({
      id: routeBaseId(track.id),
      lengthM: track.totalDistanceM,
      loop: false,
      offsetsM: [0],
    });
    const info = rideRouteInfo(first)!;
    expect(info.fullTimeS).toBeGreaterThan(100);
    expect(info.toM).toBeCloseTo(track.totalDistanceM, 6);

    // Second ride, harder: ahead of the ghost, more and more.
    expect(a.c.setGhost(ghostOf(first))).toBe(true);
    const ready = a.run(1, 0);
    expect(ready.ghost).toMatchObject({ status: 'ready', aheadM: 0, label: 'Last ride' });
    a.c.start();
    const early = a.run(30, 300);
    const later = a.run(30, 300);
    expect(early.ghost!.status).toBe('racing');
    expect(early.ghost!.gapS!).toBeGreaterThan(0);
    expect(later.ghost!.gapM!).toBeGreaterThan(early.ghost!.gapM!);
    expect(later.ghost!.aheadM!).toBeCloseTo(-later.ghost!.gapM!, 6);
    a.run(300, 300);
    const finished = await a.c.finish();
    expect(finished!.ghost!.complete).toBe(true);
    expect(finished!.ghost!.gapS!).toBeGreaterThan(5);
    // Splits at the route's quarters, all ahead.
    expect(finished!.ghost!.splits.map((s) => s.label)).toEqual([
      'km 0.4',
      'km 0.8',
      'km 1.1',
      'Finish',
    ]);
    // Beat by as much as the full times differ.
    const second = rideRouteInfo(a.saved[1]!)!;
    expect(finished!.ghost!.gapS!).toBeCloseTo(info.fullTimeS! - second.fullTimeS!, 0);
  });

  it('the ghost starts when the countdown reaches zero and pauses with the ride', async () => {
    const track = road();
    const a = rider();
    a.c.selectRoute(track);
    a.c.start();
    a.run(200, 250);
    await a.c.finish();
    const b = rider({ ...DEFAULT_SETTINGS, ride: { countdownS: 3 } });
    b.c.selectRoute(track);
    b.c.setGhost(ghostOf(a.saved[0]!));
    expect(b.c.requestStart()).toBe('counting');
    const counting = b.run(2, 250);
    expect(counting.ghost).toMatchObject({ status: 'ready', aheadM: 0 });
    const going = b.run(10, 250);
    expect(going.ghost!.status).toBe('racing');
    // Same power: level with the ghost (the countdown did not give it a head start).
    expect(Math.abs(going.ghost!.gapS!)).toBeLessThan(0.6);
    b.c.pause();
    const paused = b.run(30, 0);
    const pausedLater = b.run(30, 0);
    expect(pausedLater.ghost!.aheadM).toBeCloseTo(paused.ghost!.aheadM!, 6);
    expect(pausedLater.ghost!.speedMps).toBe(0);
    b.c.start();
    const resumed = b.run(10, 250);
    expect(Math.abs(resumed.ghost!.gapS!)).toBeLessThan(1);
  });

  it('a ride with a jump: its ghost is the longest continuous part; jumping mid-race keeps the gap', async () => {
    const track = road();
    const a = rider();
    a.c.selectRoute(track);
    a.c.start();
    a.run(40, 220);
    a.c.jumpTo(500);
    a.run(300, 220);
    await a.c.finish();
    const jumped = a.saved[0]!;
    expect(jumped.route!.offsetsM).toHaveLength(2);
    const g = rideGhost(jumped)!;
    expect(g.parts).toBe(2);
    expect(g.fromM).toBeGreaterThan(500);
    expect(g.fullTimeS).toBeNull();
    expect(rideRouteInfo(jumped)).toMatchObject({ continuous: false, fullTimeS: null });

    // Racing it from the start: the ghost joins at its part.
    const b = rider();
    b.c.selectRoute(track);
    b.c.setGhost(ghostOf(jumped));
    b.c.start();
    const waiting = b.run(5, 220);
    expect(waiting.ghost).toMatchObject({ status: 'waiting', aheadM: null });
    // Jump into the ghost's part: it races from there.
    b.c.jumpTo(800);
    const racing = b.run(10, 220);
    expect(racing.ghost!.status).toBe('racing');
  });

  it('setGhost only before the ride and only for the selected route', async () => {
    const track = road();
    const a = rider();
    a.c.selectRoute(track);
    a.c.start();
    a.run(100, 220);
    await a.c.finish();
    const spec = ghostOf(a.saved[0]!);
    expect(a.c.setGhost({ ...spec, routeId: 'another' })).toBe(false);
    a.c.start();
    expect(a.c.setGhost(spec)).toBe(false);
    await a.c.finish();
    expect(a.c.setGhost(spec)).toBe(true);
    a.c.selectRoute(null);
    expect(a.c.ghost).toBeNull();
    expect(a.run(1, 0).ghost).toBeUndefined();
  });

  it('recording, FIT, points and trainer commands are identical with and without a ghost', async () => {
    const track = road();
    const first = rider();
    first.c.selectRoute(track);
    first.c.start();
    first.run(300, 230);
    await first.c.finish();
    const spec = ghostOf(first.saved[0]!);

    const ride = async (withGhost: boolean) => {
      const r = rider(DEFAULT_SETTINGS, T0 + 86_400_000);
      r.c.selectRoute(track);
      if (withGhost) expect(r.c.setGhost(spec)).toBe(true);
      r.c.start();
      const power = (s: number) => 180 + 60 * Math.sin(s / 7);
      r.run(60, power);
      r.c.pause();
      r.run(20, 0);
      r.c.start();
      r.run(30, power);
      r.c.jumpTo(900);
      r.run(120, power);
      const finished = await r.c.finish();
      const recorded = r.saved[0]!;
      return {
        recorded,
        fit: encodeFit(recorded, { utcOffsetMinutes: 60 }),
        facts: rideFacts({
          rideId: recorded.id,
          startedAt: recorded.startedAt,
          samples: recorded.samples,
          ftpW: 200,
          utcOffsetMin: 0,
        }),
        commands: r.trainer.commands,
        ghost: finished!.ghost,
      };
    };
    const without = await ride(false);
    const withGhost = await ride(true);
    expect(withGhost.ghost).not.toBeNull();
    expect(without.ghost).toBeNull();
    expect(withGhost.recorded).toEqual(without.recorded);
    expect(withGhost.fit).toEqual(without.fit);
    expect(withGhost.facts).not.toBeNull();
    expect(withGhost.facts).toEqual(without.facts);
    expect(withGhost.commands).toEqual(without.commands);
    expect(withGhost.commands.length).toBeGreaterThan(3);
  });
});
