import { createSimulatedRig } from '@freilauf/sim';
import { generateEpisodeWorkout, getBuiltinWorkout, totalDurationS } from '@freilauf/workouts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, Settings } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import { HARD_NOW_NOTICE_MS, RideController } from './rideController';

describe('RideController: workout fitted to an episode', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) }));
  afterEach(() => vi.useRealTimers());

  async function setup(settings: Settings = DEFAULT_SETTINGS) {
    const rig = createSimulatedRig({ seed: 11 });
    let live: LiveState | null = null;
    const controller = new RideController({
      settings: { ...settings, ride: { ...settings.ride, countdownS: 0 } },
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
    return { rig, controller, run, latest: () => live! };
  }

  it('runs through the ERG engine, hard now re-fits the plan and keeps the length', async () => {
    const { rig, controller, run, latest } = await setup();
    const plan = generateEpisodeWorkout({ lengthMin: 22, effort: 'medium', pattern: 'spread' });
    expect(controller.selectWorkout(plan.workout, null, plan)).toBe(true);
    const waiting = await run(1);
    expect(waiting.workout?.episode).toMatchObject({
      lengthS: 1320,
      revision: 0,
      hardNow: { available: false },
    });
    // Before the ride it is refused with a note.
    expect(controller.hardNow()).toEqual({ ok: false, message: 'Start the ride first.' });

    controller.start();
    const riding = await run(20);
    expect(riding.workout).toMatchObject({ label: 'Warm-up', mode: 'erg', totalDurationS: 1320 });
    expect(riding.workout?.episode?.hardNow).toEqual({ available: true });
    // 110 % of 200 W.
    expect(riding.workout?.episode?.hardNowTargetW).toBe(220);

    const outcome = controller.hardNow();
    expect(outcome).toEqual({ ok: true, targetPowerW: 220 });
    // The note is published at once, between ticks.
    expect(latest().workout?.episode?.notice).toEqual({
      text: 'Hard now: 2 min · 220 W',
      tone: 'info',
    });
    const hard = await run(2);
    expect(hard.workout).toMatchObject({ label: 'Hard now', targetPowerW: 220, mode: 'erg' });
    expect(hard.workout?.episode).toMatchObject({ revision: 1, hardNow: { available: false } });
    expect(hard.workout?.totalDurationS).toBe(1320);
    // Workout time carried over: ~22 s in, 1298 s left.
    expect(hard.workout!.elapsedS).toBeGreaterThan(20);
    expect(hard.workout!.elapsedS).toBeLessThan(24);
    expect(hard.workout!.elapsedS + hard.workout!.totalRemainingS).toBeCloseTo(1320, 6);
    expect(rig.trainer.targetPowerW).toBe(220);
    expect(controller.episodePlan?.hardNowCount).toBe(1);
    expect(totalDurationS(controller.selectedWorkout!)).toBe(1320);

    // Again inside the block: refused, with a note; the plan stays.
    expect(controller.hardNow()).toEqual({ ok: false, message: 'Already in a hard block.' });
    expect(latest().workout?.episode?.notice).toEqual({
      text: 'Already in a hard block.',
      tone: 'warn',
    });
    expect(controller.episodePlan?.hardNowCount).toBe(1);
    // The note goes after a few seconds.
    const later = await run(HARD_NOW_NOTICE_MS / 1000 + 1);
    expect(later.workout?.episode?.notice).toBeNull();

    // Intensity is kept across the re-fit.
    controller.setWorkoutIntensity(1.1);
    await run(200 - 2 - 5);
    const recovery = await run(2);
    expect(recovery.workout?.label).toBe('Recovery');
    expect(controller.hardNow().ok).toBe(true);
    const second = await run(1);
    expect(second.workout).toMatchObject({ label: 'Hard now', targetPowerW: 242 });
    expect(second.workout?.episode?.revision).toBe(2);
    expect(second.workout?.intensity).toBeCloseTo(1.1, 6);
    expect(totalDurationS(controller.selectedWorkout!)).toBe(1320);

    // Pausing pauses the workout clock.
    controller.pause();
    const paused = await run(1);
    const t = paused.workout!.elapsedS;
    const stillPaused = await run(10);
    expect(stillPaused.workout!.elapsedS).toBe(t);
    controller.start();
    expect((await run(3)).workout!.elapsedS).toBeGreaterThan(t);
    await rig.dispose();
  });

  it('hard now can be assigned to a controller button and only acts on episode workouts', async () => {
    const { rig, controller, run } = await setup({
      ...DEFAULT_SETTINGS,
      shifting: { ...DEFAULT_SETTINGS.shifting, buttons: { a: 'startPause', y: 'hardNow' } },
    });
    // A library workout: no hard now.
    controller.selectWorkout(getBuiltinWorkout('builtin-sweet-spot-3x12')!);
    rig.controller.tap('a');
    const library = await run(5);
    expect(library.workout?.episode).toBeUndefined();
    rig.controller.tap('y');
    expect((await run(1)).workout?.label).toBe('Warm-up');
    expect(controller.hardNow()).toEqual({ ok: false, message: 'Only in an episode workout.' });
    await controller.finish();

    const plan = generateEpisodeWorkout({ lengthMin: 10, effort: 'hard', pattern: 'steady' });
    controller.selectWorkout(plan.workout, null, plan);
    rig.controller.tap('a');
    await run(5);
    rig.controller.tap('y');
    const hard = await run(1);
    expect(hard.workout).toMatchObject({ label: 'Hard now', targetPowerW: 240 });
    expect(hard.workout?.episode?.revision).toBe(1);
    await rig.dispose();
  });

  it('an episode plan for another workout is ignored', () => {
    const controller = new RideController({
      settings: DEFAULT_SETTINGS,
      onLive: () => undefined,
      saveRide: async () => undefined,
    });
    const plan = generateEpisodeWorkout({ lengthMin: 10, effort: 'easy', pattern: 'early' });
    controller.selectWorkout(getBuiltinWorkout('builtin-sweet-spot-3x12')!, null, plan);
    expect(controller.episodePlan).toBeNull();
    controller.selectWorkout(plan.workout, null, plan);
    expect(controller.episodePlan).toBe(plan);
  });
});
