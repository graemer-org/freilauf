import type { RawPoint, RouteTrack } from '@freilauf/routes';
import {
  FINISH_MARGIN_M,
  buildRoute,
  getBuiltinRoute,
  gradeAt,
  pointAt,
  unproject,
} from '@freilauf/routes';
import type { RecordedRide } from '@freilauf/session';
import { encodeFit, splitAtJumps } from '@freilauf/session';
import { createSimulatedRig } from '@freilauf/sim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import type { GroupLink } from './rideController';
import { JUMP_RAMP_STEP, ROUTE_GRADE_MIN_INTERVAL_MS, RideController } from './rideController';

const climb = getBuiltinRoute('builtin-steady-climb')!;
const loop = getBuiltinRoute('builtin-punchy-circuit')!;

/** 3 km straight north descending at 5 %, then 3 km climbing at 7 %. */
function downThenUp(): RouteTrack {
  const O = { lat0: 46.5, lon0: 8 };
  const points: RawPoint[] = [];
  let e = 800;
  for (let i = 0; i <= 600; i++) {
    points.push({ ...unproject(O, 0, i * 10), ele: e });
    e += i < 300 ? -0.5 : 0.7;
  }
  return buildRoute({ name: 'Down then up', hasElevation: true, points });
}

describe('RideController: start point and jumps along the route', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) }));
  afterEach(() => vi.useRealTimers());

  async function setup(effortW = 250) {
    const rig = createSimulatedRig({ seed: 3, trainer: { riderEffortW: effortW } });
    const saved: RecordedRide[] = [];
    let live: LiveState | null = null;
    const controller = new RideController({
      settings: DEFAULT_SETTINGS,
      onLive: (s) => (live = s),
      saveRide: async (ride, finished) => void (finished && saved.push(ride)),
    });
    controller.setDevice('trainer', rig.trainer);
    const connecting = rig.trainer.connect();
    await vi.advanceTimersByTimeAsync(1000);
    await connecting;
    const run = async (seconds: number, each?: (l: LiveState) => void) => {
      for (let i = 0; i < seconds * 4; i++) {
        await vi.advanceTimersByTimeAsync(250);
        controller.tick();
        each?.(live!);
      }
      return live!;
    };
    const gradeCommands = () =>
      rig.trainer.commands.flatMap((c) =>
        c.type === 'simulation' ? [{ at: c.at, grade: c.params.gradePercent }] : [],
      );
    return { rig, controller, run, saved, gradeCommands };
  }

  it('before the ride: the chosen start point is where the ride starts', async () => {
    const { rig, controller, run, saved } = await setup();
    controller.selectRoute(climb);
    expect(controller.setRouteStart(4000)).toBe(4000);
    const idle = await run(1);
    expect(idle.route!.distanceM).toBeCloseTo(4000, 6);
    expect(idle.route!.remainingM).toBeCloseTo(climb.totalDistanceM - 4000, 6);
    expect(idle.routeControl).toMatchObject({ startM: 4000, jumps: 0, lastJumpM: null });
    controller.start();
    expect(controller.setRouteStart(0)).toBeNull(); // not while riding (jumpTo is for that)
    const riding = await run(60);
    // Position = start point + ridden distance; the ride's own distance starts at 0.
    expect(riding.ride.distanceM).toBeGreaterThan(100);
    expect(riding.ride.distanceM).toBeLessThan(1000);
    expect(riding.route!.distanceM).toBeCloseTo(4000 + riding.ride.distanceM, -1);
    expect(riding.ride.gradePercent).toBeCloseTo(gradeAt(climb, riding.route!.distanceM), 0);
    await controller.finish();
    const ride = saved.at(-1)!;
    const first = ride.samples[0]!;
    const p = pointAt(climb, 4000 + first.distanceM);
    expect(first.lat).toBeCloseTo(p.lat, 6);
    expect(first.altitudeM).toBeCloseTo(p.elevationM, 1);
    expect(ride.samples.every((s) => s.segment === undefined)).toBe(true);
    // The next ride starts there again.
    expect((await run(1)).route!.distanceM).toBeCloseTo(4000, 6);
    await rig.dispose();
  });

  it('a start (or jump) at the very end of a point-to-point route lands a little before it', async () => {
    const { rig, controller, run } = await setup();
    controller.selectRoute(climb, climb.totalDistanceM);
    expect((await run(1)).route!.distanceM).toBeCloseTo(climb.totalDistanceM - FINISH_MARGIN_M, 6);
    controller.start();
    await run(2);
    expect(controller.jumpTo(climb.totalDistanceM + 5000)).toBeCloseTo(
      climb.totalDistanceM - FINISH_MARGIN_M,
      6,
    );
    const live = await run(1);
    expect(live.route!.finished).toBe(false);
    expect(live.route!.remainingM).toBeGreaterThan(50);
    await rig.dispose();
  });

  it('on a loop the start wraps and laps count from the start/finish line', async () => {
    const { rig, controller, run } = await setup(320);
    const T = loop.totalDistanceM;
    controller.selectRoute(loop);
    expect(controller.setRouteStart(T + 300)).toBeCloseTo(300, 6);
    expect(controller.setRouteStart(T - 150)).toBeCloseTo(T - 150, 6);
    controller.start();
    let lap = 1;
    let crossedAt = Number.NaN;
    await run(60, (l) => {
      if (l.route!.lap > lap && Number.isNaN(crossedAt)) crossedAt = l.ride.distanceM;
      lap = Math.max(lap, l.route!.lap);
    });
    expect(lap).toBe(2);
    // Lap 2 began after ~150 m of riding, not after a whole lap.
    expect(crossedAt).toBeGreaterThan(140);
    expect(crossedAt).toBeLessThan(200);
    // A jump during the ride keeps the lap and wraps.
    expect(controller.jumpTo(-500)).toBeCloseTo(T - 500, 6);
    const after = await run(1);
    expect(after.route!.lap).toBe(2);
    expect(after.route!.distanceM).toBeGreaterThan(T - 500);
    await rig.dispose();
  });

  it('during the ride: only the place on the route changes; the gradient is eased in', async () => {
    const route = downThenUp();
    const { rig, controller, run, gradeCommands, saved } = await setup();
    controller.selectRoute(route);
    controller.start();
    const before = await run(30);
    expect(before.ride.gradePercent).toBeLessThan(-4);
    const sentBefore = before.routeControl!.trainerGradePercent!;
    expect(sentBefore).toBeLessThan(-4);
    const ridden = before.ride.distanceM;
    const speed = before.ride.speedMps;
    const elapsed = before.ride.elapsedS;
    const nCmds = gradeCommands().length;
    const jumpAt = Date.now();

    expect(controller.jumpTo(4500)).toBe(4500);
    const right = await run(0.25);
    // The place changed; the ride did not.
    // (The live route position is the one the tick's physics used: one tick behind the ride.)
    expect(right.route!.distanceM).toBeGreaterThanOrEqual(4500);
    expect(right.route!.distanceM).toBeLessThanOrEqual(4500 + right.ride.distanceM - ridden + 1e-6);
    expect(right.ride.distanceM - ridden).toBeLessThan(10);
    expect(right.ride.elapsedS).toBeGreaterThanOrEqual(elapsed);
    expect(right.ride.speedMps).toBeCloseTo(speed, 0); // the speed is kept
    expect(right.ride.gradePercent).toBeGreaterThan(6); // the road is +7 % right away
    expect(right.routeControl).toMatchObject({ jumps: 1, lastJumpM: 4500, startM: 0 });
    expect(right.route!.remainingM).toBeCloseTo(route.totalDistanceM - right.route!.distanceM, 6);
    expect(right.route!.ascentRemainingM).toBeLessThan(route.ascentM / 2 + 5);
    expect(right.route!.ascentRemainingM).toBeGreaterThan(80);

    // The first new gradient goes out on the next tick (no 1 s wait), but only one step.
    const first = gradeCommands().slice(nCmds);
    expect(first).toHaveLength(1);
    expect(first[0]!.at - jumpAt).toBeLessThanOrEqual(250);
    expect(first[0]!.grade).toBeCloseTo(sentBefore + JUMP_RAMP_STEP, 1);

    // Then one step per second until the trainer is on the road: about 3 s for 12 points.
    const settled = await run(6);
    const ramp = gradeCommands().slice(nCmds);
    expect(ramp.length).toBeGreaterThanOrEqual(4);
    let prev = sentBefore;
    for (let i = 0; i < ramp.length; i++) {
      expect(ramp[i]!.grade - prev).toBeLessThanOrEqual(JUMP_RAMP_STEP + 1e-6);
      if (i > 0)
        expect(ramp[i]!.at - ramp[i - 1]!.at).toBeGreaterThanOrEqual(ROUTE_GRADE_MIN_INTERVAL_MS);
      prev = ramp[i]!.grade;
    }
    const reachedAt = ramp.findIndex((c) => c.grade > 6.5);
    expect(reachedAt).toBeGreaterThanOrEqual(3);
    expect(ramp[reachedAt]!.at - jumpAt).toBeLessThanOrEqual(3_500);
    expect(settled.routeControl!.trainerGradePercent!).toBeCloseTo(settled.ride.gradePercent, 0);
    // The physics follow the new road: slower on the climb than on the descent.
    expect(settled.ride.speedMps).toBeLessThan(speed);

    // A second jump; then the recording: positions jump, the ridden distance does not.
    controller.jumpTo(1000);
    await run(20);
    await controller.finish();
    const ride = saved.at(-1)!;
    const segs = ride.samples.map((s) => s.segment ?? 0);
    expect(new Set(segs)).toEqual(new Set([0, 1, 2]));
    for (let i = 1; i < ride.samples.length; i++) {
      const a = ride.samples[i - 1]!;
      const b = ride.samples[i]!;
      expect(b.distanceM - a.distanceM).toBeGreaterThanOrEqual(0);
      expect(b.distanceM - a.distanceM).toBeLessThan(25);
    }
    const firstOf1 = ride.samples.find((s) => s.segment === 1)!;
    const at1 = pointAt(route, 4500 + (firstOf1.distanceM - ridden));
    expect(firstOf1.lat).toBeCloseTo(at1.lat, 5);
    expect(splitAtJumps(ride.samples)).toHaveLength(3);
    expect(encodeFit(ride).length).toBeGreaterThan(1000);
    await rig.dispose();
  }, 20_000);

  it('a small gradient change after a jump goes out at once, without a ramp', async () => {
    const { rig, controller, run, gradeCommands } = await setup();
    controller.selectRoute(climb);
    controller.start();
    await run(20);
    const n = gradeCommands().length;
    const t = Date.now();
    controller.jumpTo(5000); // still on the ~6 % climb
    await run(0.25);
    const cmds = gradeCommands().slice(n);
    // Either nothing to send (same gradient) or one immediate write straight to the road.
    for (const c of cmds) expect(c.at - t).toBeLessThanOrEqual(250);
    await rig.dispose();
  });

  it('tells the group where on the route the rider is (base id, offset included)', async () => {
    const { rig, controller, run } = await setup();
    const states: Parameters<GroupLink['setLocalState']>[0][] = [];
    controller.setGroup({
      roomCode: 'ABC-DEF',
      setLocalState: (s) => void states.push(s),
      getRiders: () => [],
    });
    controller.selectRoute(climb, 3000);
    controller.start();
    await run(10);
    const last = states.at(-1)!;
    expect(last.route).toEqual({ id: climb.id, m: expect.closeTo(3000 + last.distanceM, 3) });
    expect(last.routeShape).toEqual({ lengthM: climb.totalDistanceM, loop: false });
    controller.jumpTo(6000);
    await run(1);
    expect(states.at(-1)!.route!.m).toBeGreaterThan(6000);
    expect(states.at(-1)!.route!.m).toBeLessThan(6100);
    controller.selectRoute(null);
    await controller.finish();
    controller.selectRoute(null);
    await run(1);
    expect(states.at(-1)!.route).toBeUndefined();
    await rig.dispose();
  });

  it('without a route, jumps are refused', async () => {
    const { rig, controller } = await setup();
    expect(controller.jumpTo(100)).toBeNull();
    expect(controller.setRouteStart(100)).toBeNull();
    await rig.dispose();
  });
});
