import { rideFacts } from '@freilauf/community';
import type { GroupRider } from '@freilauf/p2p';
import { getBuiltinRoute } from '@freilauf/routes';
import type { RecordedRide } from '@freilauf/session';
import { encodeFit } from '@freilauf/session';
import { createSimulatedRig } from '@freilauf/sim';
import type { Workout } from '@freilauf/workouts';
import { TWENTY_MINUTE_TEST } from '@freilauf/workouts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, Settings } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import type { GroupLink } from './rideController';
import { RideController } from './rideController';

const loop = getBuiltinRoute('builtin-rolling-loop')!;
const START = Date.UTC(2026, 0, 1);
/** Pick-ups every 60–80 m, so a test reaches several in a minute or two. */
const TUNING = { spacingM: [60, 80] };

function withPowerUps(over: Partial<Settings['powerUps']>): Settings {
  return { ...DEFAULT_SETTINGS, powerUps: { ...DEFAULT_SETTINGS.powerUps, ...over } };
}

async function setup(settings: Settings = DEFAULT_SETTINGS, effortW = 240) {
  const rig = createSimulatedRig({ seed: 3, trainer: { riderEffortW: effortW } });
  const saved: RecordedRide[] = [];
  let live: LiveState | null = null;
  const controller = new RideController({
    settings,
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
  const runUntil = async (pred: (l: LiveState) => boolean, maxS = 300) => {
    for (let i = 0; i < maxS * 4; i++) {
      await vi.advanceTimersByTimeAsync(250);
      controller.tick();
      if (pred(live!)) return live!;
    }
    throw new Error('condition not reached');
  };
  return { rig, controller, run, runUntil, saved };
}

describe('RideController power-ups', () => {
  beforeEach(() => vi.useFakeTimers({ now: START }));
  afterEach(() => vi.useRealTimers());

  it('picks one up on a built-in route and uses it with the simulated side button', async () => {
    const { rig, controller, run, runUntil } = await setup();
    controller.selectRoute(loop);
    controller.setPowerUpTuning(TUNING);
    expect((await run(1)).powerUps).toBeUndefined(); // nothing before the ride
    controller.start();
    const first = await run(1);
    expect(first.powerUps).toMatchObject({ blocked: null, held: null, raceOffsetM: 0 });
    expect(first.powerUps!.upcoming.length).toBeGreaterThan(0);
    const picked = await runUntil((l) => l.powerUps!.held !== null);
    expect(picked.powerUps!.event?.type).toBe('picked');
    const kind = picked.powerUps!.held!;
    // The default mapping: the side button uses it.
    rig.controller.tap('powerUpLeft');
    const used = await run(1);
    expect(used.powerUps!.held).toBeNull();
    expect(used.powerUps!.used).toBe(1);
    expect(used.powerUps!.effect?.kind).toBe(kind);
    await rig.dispose();
  });

  it('the race offset grows while the recording follows physics only (FIT, points, bests unchanged)', async () => {
    // Ride 1: power-ups off. Ride 2: the same simulated rider and clock, power-ups used.
    const rideWith = async (settings: Settings, use: boolean) => {
      vi.setSystemTime(START);
      const { rig, controller, run, saved } = await setup(settings);
      controller.selectRoute(loop);
      controller.setPowerUpTuning(TUNING);
      controller.start();
      let offset = 0;
      for (let s = 0; s < 240; s++) {
        const l = await run(1);
        if (use && l.powerUps?.held && l.powerUps.canActivate) controller.usePowerUp('keyboard');
        offset = l.powerUps?.raceOffsetM ?? 0;
      }
      const finished = await controller.finish();
      await rig.dispose();
      return { ride: saved[0]!, offset, finished: finished! };
    };
    const plain = await rideWith(withPowerUps({ enabled: false }), false);
    const boosted = await rideWith(DEFAULT_SETTINGS, true);

    expect(plain.offset).toBe(0);
    expect(boosted.offset).toBeGreaterThan(5);
    expect(boosted.finished.powerUps!.used).toBeGreaterThan(0);
    expect(boosted.finished.powerUps!.raceOffsetM).toBeCloseTo(boosted.offset, 0);
    // The recording is the same to the last sample: distance, speed, everything.
    expect(boosted.ride.samples).toEqual(plain.ride.samples);
    expect(boosted.ride).toEqual(plain.ride);
    expect(JSON.stringify(boosted.ride)).not.toMatch(/power-?up|race/i);
    // So are the FIT file, the points and the best efforts.
    expect(encodeFit(boosted.ride)).toEqual(encodeFit(plain.ride));
    const facts = (r: RecordedRide) =>
      rideFacts({
        rideId: r.id,
        startedAt: r.startedAt,
        samples: r.samples,
        ftpW: 200,
        utcOffsetMin: 0,
      });
    expect(facts(boosted.ride)).toEqual(facts(plain.ride));
  });

  it('uses it with the keyboard path and logs a refused use', async () => {
    const { rig, controller, run, runUntil } = await setup();
    controller.setPowerUpTuning(TUNING);
    controller.start();
    expect(controller.usePowerUp('keyboard')).toBe(false); // nothing held
    await runUntil((l) => l.powerUps!.held !== null, 120);
    expect(controller.usePowerUp('keyboard')).toBe(true);
    expect((await run(1)).powerUps!.effect).not.toBeNull();
    await rig.dispose();
  });

  it('no pick-ups in ERG steps and FTP tests; a held power-up stays held', async () => {
    const erg: Workout = {
      id: 'w-erg',
      name: 'Free then ERG',
      steps: [
        { kind: 'freeRide', durationS: 90 },
        { kind: 'steady', durationS: 120, power: 1 },
      ],
    };
    const { rig, controller, run, runUntil } = await setup();
    controller.selectWorkout(erg);
    controller.setPowerUpTuning(TUNING);
    controller.start();
    await runUntil((l) => l.powerUps!.held !== null, 85);
    const held = controller.tick().powerUps!.held;
    // Into the ERG step.
    const inErg = await runUntil((l) => l.workout?.mode === 'erg', 120);
    await run(1);
    expect(controller.tick().powerUps).toMatchObject({ blocked: 'erg', upcoming: [], held });
    let pickedInErg = false;
    await run(60, (l) => {
      if (l.powerUps!.picked > 1) pickedInErg = true;
    });
    expect(inErg.workout?.mode).toBe('erg');
    expect(pickedInErg).toBe(false);
    expect(controller.usePowerUp('keyboard')).toBe(false);
    expect(controller.tick().powerUps!.held).toBe(held);
    await rig.dispose();

    // FTP test: none at all.
    vi.setSystemTime(START);
    const t = await setup();
    t.controller.selectWorkout(TWENTY_MINUTE_TEST.workout, TWENTY_MINUTE_TEST);
    t.controller.setPowerUpTuning(TUNING);
    t.controller.start();
    const ftp = await t.run(120);
    expect(ftp.powerUps).toMatchObject({ blocked: 'ftpTest', held: null, picked: 0, upcoming: [] });
    await t.rig.dispose();
  });

  it('switched off in settings: nothing is shown or picked up', async () => {
    const { rig, controller, run } = await setup(withPowerUps({ enabled: false }));
    controller.setPowerUpTuning(TUNING);
    controller.start();
    const l = await run(90);
    expect(l.powerUps).toMatchObject({ blocked: 'off', picked: 0, upcoming: [] });
    await rig.dispose();
  });

  it('offers an effort challenge when the simulated rider eases off, and grants one when met', async () => {
    const { rig, controller, run, runUntil } = await setup(DEFAULT_SETTINGS, 240);
    controller.setPowerUpTuning({
      spacingM: [90_000, 100_000],
      challenge: { notBeforeS: 20, recentS: 10, baselineS: 15, holdS: 8, offerS: 15 },
    });
    controller.start();
    await run(30);
    rig.trainer.setRiderEffort(150);
    const offered = await runUntil((l) => l.powerUps!.challenge !== null, 60);
    const ch = offered.powerUps!.challenge!;
    expect(ch.phase).toBe('offered');
    expect(ch.targetW).toBeGreaterThan(150);
    rig.trainer.setRiderEffort(ch.targetW + 15);
    const won = await runUntil((l) => l.powerUps!.held !== null, 40);
    expect(won.powerUps!.event?.type).toBe('challenge-won');
    expect(won.powerUps!.challenge).toBeNull();
    await rig.dispose();
  });

  it('challenges can be switched off and dismissed', async () => {
    const tuning = {
      spacingM: [90_000, 100_000],
      challenge: { notBeforeS: 20, recentS: 10, baselineS: 15 },
    };
    {
      const { rig, controller, run } = await setup(withPowerUps({ challenges: false }));
      controller.setPowerUpTuning(tuning);
      controller.start();
      await run(30);
      rig.trainer.setRiderEffort(120);
      let offered = false;
      await run(60, (l) => (offered ||= l.powerUps!.challenge !== null));
      expect(offered).toBe(false);
      await rig.dispose();
    }
    {
      const { rig, controller, run, runUntil } = await setup();
      controller.setPowerUpTuning(tuning);
      controller.start();
      await run(30);
      rig.trainer.setRiderEffort(120);
      await runUntil((l) => l.powerUps!.challenge !== null, 60);
      controller.dismissPowerUpChallenge();
      expect((await run(1)).powerUps!.challenge).toBeNull();
      await rig.dispose();
    }
  });

  it('broadcasts the race offset and follows the host switch of a group', async () => {
    const sent: Parameters<GroupLink['setLocalState']>[0][] = [];
    let rules: { powerUps: boolean } | null = null;
    const group: GroupLink = {
      roomCode: 'ABCDEF',
      setLocalState: (s) => void sent.push(s),
      getRiders: (): GroupRider[] => [],
      getRules: () => rules,
    };
    const { rig, controller, run, runUntil } = await setup();
    controller.setGroup(group);
    controller.setPowerUpTuning(TUNING);
    controller.start();
    await runUntil((l) => l.powerUps!.held !== null, 120);
    controller.usePowerUp('keyboard');
    await run(20);
    const last = sent.at(-1)!;
    expect(last.raceOffsetM).toBeGreaterThan(0);
    expect(last.distanceM).toBe(controller.tick().ride.distanceM);
    // The host switches power-ups off for the group.
    rules = { powerUps: false };
    expect((await run(1)).powerUps!.blocked).toBe('group');
    // As the host, the rider's own rule is sent along.
    controller.setGroupRules({ powerUps: false });
    await run(1);
    expect(sent.at(-1)!.rules).toEqual({ powerUps: false });
    await rig.dispose();
  });
});
