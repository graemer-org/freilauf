/**
 * Power smoothing (Settings.ride.powerSmoothingS) is display only: the recorded ride, the FIT
 * file, NP and bests, energy, trainer commands (ERG and simulation), the workout, power-ups and
 * the group broadcast are the same whatever it is set to, also when it changes mid-ride.
 */
import { encodeFit, rideSummary } from '@freilauf/session';
import { createSimulatedRig } from '@freilauf/sim';
import { getBuiltinWorkout } from '@freilauf/workouts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, PowerSmoothingSeconds, Settings } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import type { GroupLink } from './rideController';
import { RideController } from './rideController';

const withSmoothing = (powerSmoothingS: PowerSmoothingSeconds): Settings => ({
  ...DEFAULT_SETTINGS,
  ride: { countdownS: 0, powerSmoothingS },
});

async function ride(
  smoothing: PowerSmoothingSeconds,
  options: { workout?: boolean; changeTo?: PowerSmoothingSeconds } = {},
) {
  vi.useRealTimers();
  vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) });
  const rig = createSimulatedRig({ seed: 11 });
  const lives: LiveState[] = [];
  const saved: unknown[] = [];
  const broadcast: Parameters<GroupLink['setLocalState']>[0][] = [];
  const controller = new RideController({
    settings: withSmoothing(smoothing),
    onLive: (s) => void lives.push(s),
    saveRide: async (r, finished) => void saved.push({ r, finished }),
  });
  controller.setDevice('trainer', rig.trainer);
  controller.setDevice('heartRate', rig.heartRate);
  controller.setDevice('controller', rig.controller);
  controller.setGroup({
    roomCode: 'ABCDEF',
    setLocalState: (s) => void broadcast.push(structuredClone(s)),
    getRiders: () => [],
  });
  const connecting = Promise.all([rig.trainer.connect(), rig.heartRate.connect()]);
  await vi.advanceTimersByTimeAsync(1000);
  await connecting;
  const run = async (seconds: number) => {
    for (let i = 0; i < seconds * 4; i++) {
      await vi.advanceTimersByTimeAsync(250);
      controller.tick();
    }
  };
  if (options.workout) controller.selectWorkout(getBuiltinWorkout('builtin-sweet-spot-3x12')!);
  controller.start();
  await run(40);
  rig.trainer.setRiderEffort(320);
  controller.shift(3);
  controller.setGradient(4);
  await run(20);
  if (options.changeTo !== undefined) {
    controller.updateSettings(withSmoothing(options.changeTo));
  }
  controller.pause();
  await run(5);
  controller.start();
  await run(30);
  const finished = await controller.finish();
  await rig.dispose();
  return {
    finished,
    lives,
    saved,
    broadcast,
    commands: rig.trainer.commands.map((c) => ({ ...c })),
  };
}

/** What may differ between smoothing settings: only the shown power and W/kg. */
const withoutDisplay = (lives: LiveState[]) =>
  lives.map((l) => {
    const { displayPowerW: _d, wattsPerKg: _w, ...ride } = l.ride;
    return { ...l, ride };
  });

describe('power smoothing is display only', () => {
  afterEach(() => vi.useRealTimers());

  for (const workout of [false, true]) {
    it(`${workout ? 'ERG workout' : 'free ride'}: recording, FIT, trainer and group are identical`, async () => {
      const off = await ride(0, { workout });
      expect(off.finished?.ride.samples.length).toBeGreaterThan(80);
      const offFit = encodeFit(off.finished!.ride);
      const offSummary = rideSummary(off.finished!.ride);
      expect(off.commands.length).toBeGreaterThan(0);
      if (workout) expect(off.commands.some((c) => c.type === 'targetPower')).toBe(true);

      for (const variant of [
        await ride(1, { workout }),
        await ride(3, { workout }),
        await ride(5, { workout }),
        await ride(0, { workout, changeTo: 5 }),
        await ride(5, { workout, changeTo: 0 }),
      ]) {
        expect(variant.finished).toEqual(off.finished);
        expect(encodeFit(variant.finished!.ride)).toEqual(offFit);
        expect(rideSummary(variant.finished!.ride)).toEqual(offSummary);
        expect(variant.commands).toEqual(off.commands);
        expect(variant.broadcast).toEqual(off.broadcast);
        expect(variant.saved).toEqual(off.saved);
        // Workout, power-ups, energy and raw power / 3 s power: unchanged in every tick.
        expect(withoutDisplay(variant.lives)).toEqual(withoutDisplay(off.lives));
      }
    });
  }

  it('the shown power is smoothed (off = raw) and W/kg follows it; a change applies at once', async () => {
    const off = await ride(0);
    for (const l of off.lives) {
      expect(l.ride.displayPowerW).toBe(l.ride.powerW);
      expect(l.ride.wattsPerKg).toBeCloseTo(l.ride.powerW / DEFAULT_SETTINGS.rider.massKg, 9);
    }
    const smooth = await ride(5);
    const jumps = (lives: LiveState[], pick: (l: LiveState) => number) =>
      lives.slice(1).reduce((a, l, i) => a + Math.abs(pick(l) - pick(lives[i]!)), 0);
    expect(jumps(smooth.lives, (l) => l.ride.displayPowerW)).toBeLessThan(
      jumps(smooth.lives, (l) => l.ride.powerW),
    );
    for (const l of smooth.lives) {
      expect(l.ride.wattsPerKg).toBeCloseTo(
        l.ride.displayPowerW / DEFAULT_SETTINGS.rider.massKg,
        9,
      );
    }
    // Switched off mid-ride: raw from the next tick on.
    const switched = await ride(5, { changeTo: 0 });
    const last = switched.lives.at(-2)!; // before finish
    expect(last.ride.displayPowerW).toBe(last.ride.powerW);
  });
});
