import { getBuiltinRoute } from '@freilauf/routes';
import { createSimulatedRig } from '@freilauf/sim';
import type { Workout } from '@freilauf/workouts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CountdownSeconds, LiveState } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import { RideController } from './rideController';

const T0 = Date.UTC(2026, 0, 1);

const ERG_FIRST: Workout = {
  id: 'erg-first',
  name: 'ERG first',
  steps: [
    { kind: 'steady', durationS: 60, power: 0.8 },
    { kind: 'freeRide', durationS: 60 },
  ],
};

describe('RideController: the countdown before a ride starts or resumes', () => {
  beforeEach(() => vi.useFakeTimers({ now: T0 }));
  afterEach(() => vi.useRealTimers());

  async function setup(countdownS: CountdownSeconds = 3) {
    const rig = createSimulatedRig({ seed: 5, trainer: { riderEffortW: 220 } });
    const published: LiveState[] = [];
    let rideStarts = 0;
    const controller = new RideController({
      settings: {
        ...DEFAULT_SETTINGS,
        shifting: {
          ...DEFAULT_SETTINGS.shifting,
          buttons: { ...DEFAULT_SETTINGS.shifting.buttons, a: 'startPause' },
        },
        ride: { countdownS },
      },
      onLive: (s) => void published.push(s),
      saveRide: async () => undefined,
      onRideStart: () => void rideStarts++,
    });
    controller.setDevice('trainer', rig.trainer);
    controller.setDevice('controller', rig.controller);
    const connecting = Promise.all([rig.trainer.connect(), rig.controller.connect()]);
    await vi.advanceTimersByTimeAsync(1000);
    await connecting;
    controller.tick(); // a live state to show the countdown on
    /** Advances the clock in 250 ms ticks; returns the live state of each tick. */
    const run = async (seconds: number): Promise<LiveState[]> => {
      const seen: LiveState[] = [];
      for (let i = 0; i < Math.round(seconds * 4); i++) {
        await vi.advanceTimersByTimeAsync(250);
        seen.push(controller.tick());
      }
      return seen;
    };
    const last = () => published.at(-1)!;
    const targetCommands = () => rig.trainer.commands.filter((c) => c.type === 'targetPower');
    return { rig, controller, run, last, published, targetCommands, starts: () => rideStarts };
  }

  it('Start counts down (3, 2, 1); the ride starts exactly at zero with the time at 0', async () => {
    const { controller, run, last, starts } = await setup();
    const pressedAt = Date.now();
    expect(controller.requestStart()).toBe('counting');
    // Shown at once, not only on the next tick.
    expect(last().countdown).toEqual({ kind: 'start', remainingS: 3, totalS: 3 });
    expect(controller.rideState).toBe('idle');

    const during = await run(2.75);
    expect(during.every((l) => l.ride.state === 'idle' && l.ride.elapsedS === 0)).toBe(true);
    expect(during.every((l) => l.ride.distanceM === 0)).toBe(true);
    const digits = [...new Set(during.map((l) => Math.ceil(l.countdown!.remainingS)))];
    expect(digits).toEqual([3, 2, 1]);
    expect(starts()).toBe(0);

    const [atZero] = await run(0.25);
    expect(Date.now() - pressedAt).toBe(3000);
    expect(atZero!.ride.state).toBe('riding');
    expect(atZero!.ride.elapsedS).toBe(0);
    expect(atZero!.countdown).toBeUndefined();
    expect(starts()).toBe(1);
    const after = await run(1);
    expect(after.at(-1)!.ride.elapsedS).toBeCloseTo(1, 6);
  });

  it('Resume counts down again; pausing is immediate', async () => {
    const { controller, run, last } = await setup();
    controller.start();
    await run(5);
    controller.pause();
    expect(controller.rideState).toBe('paused'); // at once, no countdown
    expect(last().countdown ?? null).toBeNull();
    const elapsed = controller.tick().ride.elapsedS;

    expect(controller.requestStart()).toBe('counting');
    expect(last().countdown).toMatchObject({ kind: 'resume', totalS: 3 });
    const during = await run(2.75);
    expect(during.every((l) => l.ride.state === 'paused' && l.ride.elapsedS === elapsed)).toBe(
      true,
    );
    const [atZero] = await run(0.25);
    expect(atZero!.ride.state).toBe('riding');
    expect(atZero!.ride.elapsedS).toBe(elapsed);
  });

  it('is cancelled by Start again, Escape, pause and the controller button; nothing starts', async () => {
    const { rig, controller, run, last } = await setup();
    const cancels: (() => unknown)[] = [
      () => expect(controller.requestStart()).toBe('cancelled'), // Start / Resume, Space
      () => expect(controller.cancelCountdown()).toBe(true), // Escape
      () => controller.pause(),
      () => rig.controller.tap('a'), // the controller's start/pause action
      () => expect(controller.toggleStartPause()).toBe('cancelled'),
    ];
    for (const cancel of cancels) {
      expect(controller.requestStart()).toBe('counting');
      await run(1);
      cancel();
      expect(controller.countdown).toBeNull();
      expect(last().countdown).toBeUndefined(); // shown at once
      const after = await run(4);
      expect(after.every((l) => l.ride.state === 'idle' && !l.countdown)).toBe(true);
    }
    expect(controller.cancelCountdown()).toBe(false);
  });

  it('the controller button and toggleStartPause start through the same countdown', async () => {
    const { rig, controller, run } = await setup(5);
    rig.controller.tap('a');
    expect(controller.countdown).toMatchObject({ kind: 'start', totalS: 5 });
    await run(4.75);
    expect(controller.rideState).toBe('idle');
    await run(0.25);
    expect(controller.rideState).toBe('riding');
    expect(controller.toggleStartPause()).toBe('paused');
    expect(controller.rideState).toBe('paused');
    expect(controller.toggleStartPause()).toBe('counting');
    expect(controller.countdown?.kind).toBe('resume');
  });

  it('0 = off: Start and Resume act at once', async () => {
    const { controller, run, last } = await setup(0);
    expect(controller.requestStart()).toBe('started');
    expect(controller.rideState).toBe('riding');
    await run(2);
    controller.pause();
    expect(controller.requestStart()).toBe('started');
    expect(controller.rideState).toBe('riding');
    expect(last().countdown).toBeUndefined();
    expect(controller.requestStart()).toBe('ignored'); // already riding
  });

  it('a changed setting applies to the next countdown', async () => {
    const { controller } = await setup(3);
    controller.updateSettings({ ...DEFAULT_SETTINGS, ride: { countdownS: 10 } });
    controller.requestStart();
    expect(controller.countdown).toMatchObject({ totalS: 10, remainingS: 10 });
  });

  it('a group countdown replaces a local one, starts at zero without a second countdown', async () => {
    const { controller, run, last, starts } = await setup(3);
    expect(controller.requestStart()).toBe('counting');
    await run(1);
    expect(controller.startGroupCountdown(5000)).toBe(true);
    expect(last().countdown).toEqual({ kind: 'group', remainingS: 5, totalS: 5 });
    await run(4.75);
    expect(controller.rideState).toBe('idle');
    const [atZero] = await run(0.25);
    expect(atZero!.ride.state).toBe('riding'); // at once: the group countdown gave the time
    expect(atZero!.countdown).toBeUndefined();
    expect(starts()).toBe(1);
    // Not while riding (or paused): a group start only makes sense before the ride.
    expect(controller.startGroupCountdown(5000)).toBe(false);
  });

  it('no local countdown is offered while a group countdown runs: Start cancels it', async () => {
    const { controller, run } = await setup(3);
    controller.startGroupCountdown(10_000);
    expect(controller.requestStart()).toBe('cancelled');
    expect(controller.countdown).toBeNull();
    await run(11);
    expect(controller.rideState).toBe('idle');
    // A group start that is already due starts at once.
    expect(controller.startGroupCountdown(0)).toBe(true);
    expect(controller.rideState).toBe('riding');
  });

  it('ERG: the trainer gets no target before zero; the workout does not advance meanwhile', async () => {
    const { controller, run, targetCommands } = await setup(3);
    controller.selectWorkout(ERG_FIRST);
    controller.requestStart();
    const during = await run(2.75);
    expect(targetCommands()).toEqual([]);
    for (const l of during) {
      expect(l.workout).toMatchObject({ started: false, elapsedS: 0, mode: 'free' });
    }
    const [atZero] = await run(0.25);
    expect(atZero!.workout).toMatchObject({ started: true, mode: 'erg' });
    expect(targetCommands()).toHaveLength(1);
    expect(targetCommands()[0]!.at).toBeGreaterThanOrEqual(T0 + 1000 + 3000);
  });

  it('a route does not advance during the countdown; it starts at its start point', async () => {
    const { controller, run } = await setup(3);
    const climb = getBuiltinRoute('builtin-steady-climb')!;
    expect(controller.selectRoute(climb, 500)).toBe(true);
    controller.requestStart();
    const during = await run(2.75);
    for (const l of during) {
      expect(l.ride.distanceM).toBe(0);
      expect(l.route?.distanceM).toBeCloseTo(500, 6);
    }
    await run(0.25);
    const later = await run(5);
    expect(later.at(-1)!.route!.distanceM).toBeGreaterThan(500);
  });

  it('finishing during a resume countdown ends it', async () => {
    const { controller, run, last } = await setup(3);
    controller.start();
    await run(12);
    controller.pause();
    controller.requestStart();
    const finishing = controller.finish();
    // Shown at once, before the save resolves and without waiting for the next tick.
    expect(last().ride.state).toBe('idle');
    expect(last().countdown).toBeUndefined();
    expect(await finishing).not.toBeNull();
    expect(controller.countdown).toBeNull();
    controller.tick();
    expect(last().countdown).toBeUndefined();
    expect(last().ride.state).toBe('idle');
  });

  it('finishing after a counted-down start publishes the idle state at once', async () => {
    const { controller, run, last } = await setup(3);
    controller.requestStart();
    await run(3);
    expect(controller.rideState).toBe('riding');
    await run(12);
    const finishing = controller.finish();
    expect(last().ride.state).toBe('idle');
    expect(last().ride.elapsedS).toBe(0);
    expect(last().countdown).toBeUndefined();
    await finishing;
    // A new start counts down again from the idle state.
    expect(controller.requestStart()).toBe('counting');
    expect(last().countdown?.kind).toBe('start');
  });
});
