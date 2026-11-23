import { getBuiltinRoute, gradeAt } from '@freilauf/routes';
import type { RecordedRide } from '@freilauf/session';
import { createSimulatedRig } from '@freilauf/sim';
import type { Workout } from '@freilauf/workouts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, Settings } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import type { ScopedLog } from './logger';
import { ROUTE_GRADE_MIN_INTERVAL_MS, RideController } from './rideController';

const climb = getBuiltinRoute('builtin-steady-climb')!;
const loop = getBuiltinRoute('builtin-punchy-circuit')!;

describe('RideController riding a route', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) }));
  afterEach(() => vi.useRealTimers());

  async function setup(settings: Settings = DEFAULT_SETTINGS, effortW = 250) {
    const rig = createSimulatedRig({ seed: 3, trainer: { riderEffortW: effortW } });
    const saved: RecordedRide[] = [];
    const logs: { level: string; message: string; context?: Record<string, unknown> }[] = [];
    const log: ScopedLog = {
      debug: (message, context) => void logs.push({ level: 'debug', message, context }),
      info: (message, context) => void logs.push({ level: 'info', message, context }),
      warn: (message, context) => void logs.push({ level: 'warn', message, context }),
      error: (message, context) => void logs.push({ level: 'error', message, context }),
    };
    let live: LiveState | null = null;
    const controller = new RideController({
      settings,
      log,
      onLive: (s) => (live = s),
      saveRide: async (ride, finished) => void (finished && saved.push(ride)),
    });
    controller.setDevice('trainer', rig.trainer);
    controller.setDevice('controller', rig.controller);
    const connecting = Promise.all([rig.trainer.connect(), rig.controller.connect()]);
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
    return { rig, controller, run, saved, logs, gradeCommands };
  }

  it('the route gradient drives the trainer, rate-limited, and the rider slows on the climb', async () => {
    const { rig, controller, run, gradeCommands, logs } = await setup();
    // A flat warm-up without route to compare the cadence and speed.
    controller.start();
    const flat = await run(60);
    await controller.finish();

    expect(controller.selectRoute(climb)).toBe(true);
    const idle = await run(1);
    expect(idle.route).toMatchObject({ routeId: climb.id, distanceM: 0, lap: 1, finished: false });
    expect(idle.routeControl).toMatchObject({ gradientLocked: true, difficulty: 100 });

    const before = gradeCommands().length;
    controller.start();
    expect(controller.selectRoute(null)).toBe(false); // not while riding
    const onClimb = await run(240);
    const cmds = gradeCommands().slice(before);
    // Follows the road at the rider's position (gear 12 = the physical gear: sent unscaled).
    const d = onClimb.route!.distanceM;
    expect(onClimb.ride.gradePercent).toBeCloseTo(gradeAt(climb, d), 6);
    expect(cmds.at(-1)!.grade).toBeCloseTo(onClimb.routeControl!.trainerGradePercent!, 6);
    expect(Math.abs(cmds.at(-1)!.grade - onClimb.ride.gradePercent)).toBeLessThan(0.3);
    expect(cmds.length).toBeGreaterThan(2);
    // Never more than one write per second; never flooding.
    for (let i = 1; i < cmds.length; i++) {
      expect(cmds[i]!.at - cmds[i - 1]!.at).toBeGreaterThanOrEqual(ROUTE_GRADE_MIN_INTERVAL_MS);
    }
    expect(cmds.length).toBeLessThan(240 / 1 / 2);
    // A real 6 % climb: slower and lower cadence than on the flat at the same effort.
    expect(onClimb.ride.speedMps).toBeLessThan(flat.ride.speedMps * 0.7);
    expect(onClimb.ride.cadenceRpm).toBeLessThan(flat.ride.cadenceRpm - 10);
    expect(onClimb.route!.ascentRemainingM).toBeLessThan(climb.ascentM);
    expect(logs.some((l) => l.message.startsWith('route selected'))).toBe(true);
    expect(logs.some((l) => l.level === 'debug' && l.message.startsWith('route gradient'))).toBe(
      true,
    );
    await rig.dispose();
  });

  it('manual gradient changes are ignored while a route is loaded', async () => {
    const { rig, controller, run, gradeCommands } = await setup();
    controller.selectRoute(climb);
    controller.start();
    await run(10);
    const n = gradeCommands().length;
    expect(controller.setGradient(-5)).toBe(false);
    rig.controller.tap('up'); // assigned to gradientUp by default
    const live = await run(1);
    expect(live.ride.gradePercent).toBeGreaterThan(4);
    expect(
      gradeCommands()
        .slice(n)
        .every((c) => c.grade > 4),
    ).toBe(true);
    await rig.dispose();
  });

  it('difficulty scales what the trainer feels, not the speed physics', async () => {
    const half: Settings = { ...DEFAULT_SETTINGS, route: { difficulty: 50 } };
    const a = await setup(half);
    a.controller.selectRoute(climb);
    a.controller.start();
    const eased = await a.run(120);
    expect(eased.routeControl!.difficulty).toBe(50);
    expect(eased.routeControl!.trainerGradePercent!).toBeCloseTo(eased.ride.gradePercent / 2, 0);
    expect(a.gradeCommands().at(-1)!.grade).toBeLessThan(4);
    expect(eased.ride.gradePercent).toBeGreaterThan(4.5); // the road is still 6 %
    // Changing it while riding takes effect within a second or two.
    a.controller.updateSettings({ ...half, route: { difficulty: 100 } });
    const full = await a.run(3);
    expect(full.routeControl!.trainerGradePercent!).toBeGreaterThan(4.5);
    await a.rig.dispose();
  });

  it('laps on a loop route and records positions for the FIT file', async () => {
    const { rig, controller, run, saved, logs } = await setup(DEFAULT_SETTINGS, 320);
    controller.selectRoute(loop);
    controller.start();
    let maxLap = 1;
    await run(600, (l) => (maxLap = Math.max(maxLap, l.route!.lap)));
    expect(maxLap).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.message === 'route lap 2')).toBe(true);
    await controller.finish();
    const ride = saved.at(-1)!;
    expect(ride.name).toBe(loop.name);
    expect(ride.samples.every((s) => typeof s.lat === 'number' && typeof s.lon === 'number')).toBe(
      true,
    );
    expect(ride.samples[0]!.altitudeM).toBeCloseTo(loop.elevationM[0]!, 0);
    expect(controller.selectedRoute).toBe(loop); // stays selected for the next ride
    await rig.dispose();
  });

  it('a point-to-point route finishes and the ride continues on the flat', async () => {
    const short = getBuiltinRoute('builtin-steady-climb')!;
    const { rig, controller, run, logs, gradeCommands } = await setup(DEFAULT_SETTINGS, 400);
    controller.selectRoute(short);
    controller.start();
    let live = await run(60);
    // Jump ahead: ride long enough to pass the 8 km finish.
    for (let i = 0; i < 40 && !live.route!.finished; i++) live = await run(60);
    expect(live.route).toMatchObject({ finished: true, remainingM: 0, gradePercent: 0 });
    const after = await run(5);
    expect(after.ride.gradePercent).toBe(0);
    expect(after.ride.distanceM).toBeGreaterThan(short.totalDistanceM);
    expect(gradeCommands().at(-1)!.grade).toBeCloseTo(0, 1);
    expect(logs.filter((l) => l.message.startsWith('route finished'))).toHaveLength(1);
    await rig.dispose();
  }, 30_000);

  it('combines with an ERG workout: ERG holds power, free segments take the route gradient', async () => {
    const workout: Workout = {
      id: 'erg-then-free',
      name: 'ERG then free',
      steps: [
        { kind: 'steady', durationS: 60, power: 0.8 },
        { kind: 'freeRide', durationS: 120, gradePercent: -3 },
      ],
    };
    const { rig, controller, run, gradeCommands } = await setup();
    controller.selectRoute(climb);
    controller.selectWorkout(workout);
    controller.start();
    const erg = await run(30);
    expect(erg.workout?.mode).toBe('erg');
    expect(rig.trainer.mode).toBe('erg');
    expect(erg.routeControl!.trainerGradePercent).toBeNull();
    expect(erg.route!.distanceM).toBeGreaterThan(50); // the route still advances
    const n = gradeCommands().length;
    await run(20);
    expect(gradeCommands().length).toBe(n); // nothing that would leave ERG
    const free = await run(30);
    expect(free.workout?.mode).toBe('free');
    expect(rig.trainer.mode).toBe('sim');
    // The route's gradient, not the workout's −3 %.
    expect(gradeCommands().at(-1)!.grade).toBeGreaterThan(4);
    expect(free.routeControl!.trainerGradePercent!).toBeGreaterThan(4);
    await rig.dispose();
  });

  it('re-sends the route gradient when the trainer reconnects', async () => {
    const { rig, controller, run, gradeCommands } = await setup();
    controller.selectRoute(climb);
    controller.start();
    await run(30);
    const n = gradeCommands().length;
    rig.trainer.simulateDrop();
    await run(6);
    const resent = gradeCommands().slice(n);
    expect(resent.length).toBeGreaterThan(0);
    expect(resent.at(-1)!.grade).toBeGreaterThan(4);
    await rig.dispose();
  });

  it('clearing the route returns to a flat, manually controlled road', async () => {
    const { rig, controller, run } = await setup();
    controller.selectRoute(climb);
    await run(2);
    expect(controller.selectRoute(null)).toBe(true);
    const live = await run(1);
    expect(live.route).toBeUndefined();
    expect(live.routeControl).toBeUndefined();
    expect(live.ride.gradePercent).toBe(0);
    expect(controller.setGradient(2)).toBe(true);
    await rig.dispose();
  });
});
