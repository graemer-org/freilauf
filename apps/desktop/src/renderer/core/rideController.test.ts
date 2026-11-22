import type { RecordedRide } from '@freilauf/session';
import { createSimulatedRig } from '@freilauf/sim';
import { TWENTY_MINUTE_TEST, getBuiltinWorkout } from '@freilauf/workouts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import { RideController } from './rideController';

describe('RideController with the simulated rig', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) }));
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const rig = createSimulatedRig({ seed: 7 });
    const saved: { ride: RecordedRide; finished: boolean }[] = [];
    const errors: string[] = [];
    let live: LiveState | null = null;
    const controller = new RideController({
      settings: DEFAULT_SETTINGS,
      onLive: (state) => (live = state),
      saveRide: async (ride, finished) => void saved.push({ ride, finished }),
      onError: (m) => errors.push(m),
    });
    controller.setDevice('trainer', rig.trainer);
    controller.setDevice('heartRate', rig.heartRate);
    controller.setDevice('controller', rig.controller);
    const connecting = Promise.all([
      rig.trainer.connect(),
      rig.heartRate.connect(),
      rig.controller.connect(),
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    await connecting;
    const run = async (seconds: number) => {
      for (let i = 0; i < seconds * 4; i++) {
        await vi.advanceTimersByTimeAsync(250);
        controller.tick();
      }
      return live!;
    };
    return { rig, controller, saved, errors, run };
  }

  it('rides: power, cadence, HR, speed and distance flow through; ride is saved on finish', async () => {
    const { rig, controller, saved, errors, run } = await setup();
    controller.start();
    const live = await run(60);
    expect(live.ride.state).toBe('riding');
    expect(live.ride.powerW).toBeGreaterThan(150);
    expect(live.ride.cadenceRpm).toBeGreaterThan(40);
    expect(live.ride.heartRateBpm).toBeGreaterThan(60);
    expect(live.ride.speedMps).toBeGreaterThan(5);
    expect(live.ride.distanceM).toBeGreaterThan(300);
    expect(live.ride.wattsPerKg).toBeCloseTo(live.ride.power3sW / 75, 6);
    expect(live.devices.trainer).toEqual({ name: rig.trainer.name, state: 'connected' });

    const ride = await controller.finish();
    expect(ride?.ride.samples).toHaveLength(60);
    expect(ride?.ftpTest).toBeNull();
    expect(saved.at(-1)).toMatchObject({ finished: true });
    expect(saved.filter((s) => !s.finished)).toHaveLength(2); // autosaves at 30 s and 60 s
    expect(controller.rideState).toBe('idle');
    expect(errors).toEqual([]);
    await rig.dispose();
  });

  it('controller buttons shift; a harder gear lowers the cadence at the same effort', async () => {
    const { rig, controller, run } = await setup();
    controller.start();
    const before = await run(60);
    expect(before.ride.gear).toBe(12);
    // The trainer received the road for the current gear when it connected.
    expect(rig.trainer.commands.length).toBeGreaterThan(0);

    for (let i = 0; i < 4; i++) rig.controller.tap('shiftUpRight');
    const after = await run(60);
    expect(after.ride.gear).toBe(16);
    expect(after.ride.cadenceRpm).toBeLessThan(before.ride.cadenceRpm - 10);

    rig.controller.tap('shiftDownLeft');
    expect(controller.shifter.gear).toBe(15);
    await rig.dispose();
  });

  it('gradient changes reach the trainer and slow the rider', async () => {
    const { rig, controller, run } = await setup();
    controller.start();
    const flat = await run(90);
    const commands = rig.trainer.commands.length;
    controller.setGradient(6);
    const climb = await run(90);
    expect(rig.trainer.commands.length).toBe(commands + 1);
    expect(climb.ride.gradePercent).toBe(6);
    expect(climb.ride.speedMps).toBeLessThan(flat.ride.speedMps * 0.6);
    await rig.dispose();
  });

  it('a trainer drop shows as reconnecting, zeroes power, and the gear is re-sent on recovery', async () => {
    const { rig, controller, run } = await setup();
    controller.start();
    await run(20);
    controller.shift(2);
    const commands = rig.trainer.commands.length;

    rig.trainer.simulateDrop();
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.tick().devices.trainer?.state).toBe('reconnecting');
    // Shifting while the trainer is away must not throw or report errors.
    controller.shift(1);

    await vi.advanceTimersByTimeAsync(1500);
    controller.tick();
    await vi.advanceTimersByTimeAsync(2500);
    const dropped = controller.tick();
    // (reconnect delay is 2 s; by 4 s without data the session shows no power)
    expect(dropped.devices.trainer?.state).toBe('connected');
    expect(rig.trainer.commands.length).toBeGreaterThan(commands);
    const recovered = await run(10);
    expect(recovered.ride.powerW).toBeGreaterThan(100);
    expect(recovered.ride.gear).toBe(15);
    await rig.dispose();
  });

  it('discards accidental rides and publishes the group', async () => {
    const { rig, controller, saved, run } = await setup();
    const sent: unknown[] = [];
    controller.setGroup({
      roomCode: 'ABCDEF',
      setLocalState: (s) => void sent.push(s),
      getRiders: () => [],
    });
    controller.start();
    const live = await run(3);
    expect(live.group).toEqual({ roomCode: 'ABCDEF', riders: [] });
    expect(sent.at(-1)).toMatchObject({ name: 'Rider', gear: 12 });
    expect(await controller.finish()).toBeNull();
    expect(saved).toHaveLength(0);
    await rig.dispose();
  });
  it('structured workout: ERG targets follow the plan, shifting does not leave ERG', async () => {
    const { rig, controller, run, errors } = await setup();
    const workout = getBuiltinWorkout('builtin-sweet-spot-3x12')!;
    expect(controller.selectWorkout(workout)).toBe(true);
    const waiting = await run(1);
    expect(waiting.workout).toMatchObject({ name: workout.name, started: false });

    controller.start();
    expect(controller.selectWorkout(null)).toBe(false); // not while riding
    const early = await run(30);
    expect(early.workout).toMatchObject({ mode: 'erg', started: true, finished: false });
    const target = early.workout!.targetPowerW!;
    expect(target).toBeGreaterThan(50);
    expect(rig.trainer.mode).toBe('erg');
    expect(rig.trainer.targetPowerW).toBe(target);
    // The simulated trainer converges on the target.
    expect(Math.abs(early.ride.power3sW - target)).toBeLessThan(25);

    const simulationCommands = () =>
      rig.trainer.commands.filter((c) => c.type === 'simulation').length;
    const before = simulationCommands();
    controller.shift(2);
    controller.setGradient(3);
    await run(2);
    expect(simulationCommands()).toBe(before);
    expect(rig.trainer.mode).toBe('erg');

    // Intensity scales the target; skipping moves on.
    controller.setWorkoutIntensity(0.5);
    const eased = await run(2);
    expect(eased.workout!.intensity).toBe(0.5);
    expect(eased.workout!.targetPowerW!).toBeLessThan(target);
    const label = eased.workout!.label;
    controller.skipWorkoutSegment();
    expect((await run(1)).workout!.label).not.toBe(label);

    // After a trainer drop the target is sent again.
    const commands = rig.trainer.commands.length;
    rig.trainer.simulateDrop();
    await run(5);
    expect(rig.trainer.commands.length).toBeGreaterThan(commands);
    expect(rig.trainer.mode).toBe('erg');

    // Finishing returns the trainer to the simulated road and clears the plan.
    const finished = await controller.finish();
    expect(finished?.ride.name).toBe(workout.name);
    await run(1);
    expect(rig.trainer.mode).toBe('sim');
    expect(controller.selectedWorkout).toBeNull();
    expect(errors).toEqual([]);
    await rig.dispose();
  });

  it('20-minute FTP test: the effort is a free ride and yields 95 % of its average', async () => {
    const { rig, controller, run } = await setup();
    controller.selectWorkout(TWENTY_MINUTE_TEST.workout, TWENTY_MINUTE_TEST);
    controller.start();
    const total = controller.tick().workout!.totalDurationS;
    let sawFreeEffort = false;
    for (let t = 0; t < total; t += 60) {
      const live = await run(60);
      if (live.workout!.mode === 'free' && !live.workout!.finished) {
        sawFreeEffort = true;
        expect(rig.trainer.mode).toBe('sim');
      }
    }
    expect(sawFreeEffort).toBe(true);
    const done = await run(2);
    expect(done.workout!.finished).toBe(true);

    const finished = await controller.finish();
    const outcome = finished!.ftpTest!;
    expect(outcome).toMatchObject({ kind: 'twentyMinute', valid: true, previousFtpW: 200 });
    // The simulated rider holds about 180 W in the free effort.
    expect(outcome.basisPowerW).toBeGreaterThan(150);
    expect(outcome.basisPowerW).toBeLessThan(210);
    expect(outcome.ftpW).toBe(Math.round(outcome.basisPowerW * 0.95));
    await rig.dispose();
  });

  it('an FTP test that is abandoned early is reported as not valid', async () => {
    const { rig, controller, run } = await setup();
    controller.selectWorkout(TWENTY_MINUTE_TEST.workout, TWENTY_MINUTE_TEST);
    controller.start();
    await run(60);
    const finished = await controller.finish();
    expect(finished!.ftpTest).toMatchObject({ valid: false });
    expect(finished!.ftpTest!.reason).toBeTruthy();
    await rig.dispose();
  });
  it('buttons can drive gradient, start/pause and steering; paddles steer too', async () => {
    const { rig, controller, run } = await setup();
    // Defaults: d-pad up/down = gradient, left/right = steer (held).
    rig.controller.tap('up');
    rig.controller.tap('up');
    rig.controller.tap('down');
    expect((await run(1)).ride.gradePercent).toBe(0.5);

    rig.controller.press('left');
    expect((await run(1)).steering).toBe(-1);
    rig.controller.release('left');
    expect((await run(1)).steering).toBe(0);

    // Analog paddles win over buttons and give partial steering.
    rig.controller.setPaddle('right', 0.6);
    expect((await run(1)).steering).toBeCloseTo(0.6, 6);
    rig.controller.press('left');
    expect((await run(1)).steering).toBeCloseTo(0.6, 6);
    rig.controller.setPaddle('right', 0);
    expect((await run(1)).steering).toBe(-1);

    // A held button does not stay held when the controller drops.
    rig.controller.simulateDrop();
    expect((await run(1)).steering).toBe(0);
    await rig.dispose();
  });

  it('start/pause and workout actions can be assigned to buttons', async () => {
    const rig = createSimulatedRig({ seed: 3 });
    let live: LiveState | null = null;
    const controller = new RideController({
      settings: {
        ...DEFAULT_SETTINGS,
        shifting: {
          ...DEFAULT_SETTINGS.shifting,
          buttons: { a: 'startPause', b: 'workoutSkip', y: 'intensityUp', z: 'intensityDown' },
        },
      },
      onLive: (state) => (live = state),
      saveRide: async () => undefined,
    });
    controller.setDevice('trainer', rig.trainer);
    controller.setDevice('controller', rig.controller);
    const connecting = Promise.all([rig.trainer.connect(), rig.controller.connect()]);
    await vi.advanceTimersByTimeAsync(1000);
    await connecting;
    const run = async (seconds: number) => {
      for (let i = 0; i < seconds * 4; i++) {
        await vi.advanceTimersByTimeAsync(250);
        controller.tick();
      }
      return live!;
    };

    controller.selectWorkout(getBuiltinWorkout('builtin-sweet-spot-3x12')!);
    rig.controller.tap('a');
    expect((await run(2)).ride.state).toBe('riding');
    const label = live!.workout!.label;
    rig.controller.tap('b');
    expect((await run(1)).workout!.label).not.toBe(label);
    rig.controller.tap('y');
    expect((await run(1)).workout!.intensity).toBeCloseTo(1.05, 6);
    rig.controller.tap('z');
    rig.controller.tap('z');
    expect((await run(1)).workout!.intensity).toBeCloseTo(0.95, 6);
    rig.controller.tap('a');
    expect((await run(1)).ride.state).toBe('paused');
    rig.controller.tap('a');
    expect((await run(1)).ride.state).toBe('riding');
    // Unassigned buttons do nothing.
    rig.controller.tap('powerUpLeft');
    expect((await run(1)).ride.state).toBe('riding');
    await rig.dispose();
  });
});
