/**
 * The Card Race end to end (docs/card-race.md, ADR 0007): three riders, each with a real
 * RideController on the real GroupRide (through the app's adaptGroupRide), on both transports —
 * the self-hosted mesh with loss, duplicates and reordering, and the relays.
 */
import type { SimulationParams, Trainer, TrainerData } from '@freilauf/devices';
import type { GroupRide } from '@freilauf/p2p';
import { createTestNetwork, FakeClock, TEST_TRANSPORTS } from '@freilauf/p2p/testing';
import type { TestGroupNetwork } from '@freilauf/p2p/testing';
import type { RecordedRide } from '@freilauf/session';
import { encodeFit } from '@freilauf/session';
import { rideFacts } from '@freilauf/community';
import { describe, expect, it } from 'vitest';
import type { LiveState } from '../../shared/contract';
import { DEFAULT_SETTINGS } from '../../shared/contract';
import type { PowerUpKind } from '../../shared/powerUps';
import { gapsHidden } from '../../shared/powerUps';
import { adaptGroupRide } from '../main/groupConnector';
import { groupRows } from '../overlay/ui/logic';
import { attackPosition, incompatibleNote, incompatibleRiders } from './cardRace';
import { RideController } from './rideController';

/** Reports the power it is told; records every resistance command it receives. */
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

interface Rider {
  name: string;
  ride: GroupRide;
  c: RideController;
  trainer: FakeTrainer;
  live: () => LiveState;
  saved: RecordedRide[];
}

const T0 = Date.UTC(2026, 10, 1, 17);
/** Cards every 40 m; each rider draws only the kinds a test needs. */
const tuning = (cardPool: PowerUpKind[]) => ({ spacingM: [40, 40], cardPool });

async function world(kind: (typeof TEST_TRANSPORTS)[number], pools: Record<string, PowerUpKind[]>) {
  const clock = new FakeClock(T0);
  const net: TestGroupNetwork = createTestNetwork(kind, { clock, seed: 7 });
  const riders: Rider[] = [];
  const add = async (name: string, peerId: string, host: GroupRide | null) => {
    const ride = host ? await net.join(host, name, peerId) : await net.create(name, peerId);
    let live: LiveState | null = null;
    const saved: RecordedRide[] = [];
    const c = new RideController({
      settings: { ...DEFAULT_SETTINGS, rider: { ...DEFAULT_SETTINGS.rider, name } },
      now: clock.now,
      onLive: (l) => (live = l),
      saveRide: async (r, finished) => void (finished && saved.push(r)),
    });
    const trainer = new FakeTrainer();
    c.setDevice('trainer', trainer);
    c.setGroup(adaptGroupRide(ride));
    c.setPowerUpTuning(tuning(pools[name] ?? ['tailwind']));
    const r: Rider = { name, ride, c, trainer, live: () => live!, saved };
    riders.push(r);
    return r;
  };
  const anna = await add('Anna', 'peer-a', null);
  const ben = await add('Ben', 'peer-b', anna.ride);
  const cleo = await add('Cleo', 'peer-c', anna.ride);
  // Anna created the ride: she is the host and chooses the Card Race.
  anna.c.setGroupRules({ powerUps: true, mode: 'cardRace' });
  const step = async (seconds: number) => {
    for (let i = 0; i < seconds * 4; i++) {
      for (const r of riders) r.trainer.push(200);
      await clock.advanceAsync(250, 50);
      for (const r of riders) r.c.tick();
    }
  };
  await step(2);
  if (kind === 'self-hosted')
    net.setConditions({ lossRate: 0.2, duplicateRate: 0.2, maxDelayMs: 200 });
  // Ben starts first (he is ahead), then Anna, then Cleo: Ben is directly ahead of Anna.
  ben.c.start();
  await step(12);
  anna.c.start();
  await step(6);
  cleo.c.start();
  await step(12);
  const seen = (by: Rider, who: Rider) => by.live().group!.riders.find((r) => r.name === who.name);
  return { clock, net, anna, ben, cleo, step, seen, riders };
}

const cardsOf = (r: Rider) => r.live().powerUps!.cards!;

describe.each(TEST_TRANSPORTS)('Card Race over GroupRide (%s)', (kind) => {
  it('Headwind from Anna hits Ben, directly ahead: he loses race position, not recorded distance', async () => {
    const play = async (attack: boolean) => {
      const w = await world(kind, { Anna: ['headwind'], Ben: ['tailwind'], Cleo: ['tailwind'] });
      const { anna, ben, cleo, step, seen } = w;
      expect(anna.live().group?.mode).toBe('cardRace');
      expect(ben.live().group?.mode).toBe('cardRace'); // from the host's rules
      expect(cardsOf(anna).slots).toEqual(['headwind', 'headwind']);
      expect(seen(anna, ben)!.gapM).toBeGreaterThan(20);
      expect(cardsOf(anna).slotTargets).toEqual(['Ben', 'Ben']);
      if (attack) expect(anna.c.playCard(0, 'keyboard')).toBe(true);
      await step(2);
      if (attack) {
        expect(cardsOf(ben).attack).toMatchObject({ kind: 'headwind', by: 'Anna' });
        expect(cardsOf(ben).incoming).toMatchObject({
          kind: 'headwind',
          by: 'Anna',
          result: 'hit',
        });
        expect(cardsOf(anna).outgoing).toMatchObject({
          kind: 'headwind',
          target: 'Ben',
          result: 'hit',
        });
        // Cleo sees the effect on Ben, from Ben's own state.
        expect(seen(cleo, ben)!.cards?.attack?.kind).toBe('headwind');
        expect(seen(cleo, anna)!.cards?.attack).toBeUndefined();
        // Ben is protected now: Anna's second card waits instead of being wasted.
        expect(cardsOf(anna).slotNotes[1]).toMatch(/^Ben is protected/);
        expect(anna.c.playCard(1)).toBe(false);
      }
      await step(30);
      const benLive = ben.live();
      const gapSeen = seen(anna, ben)!.gapM;
      const finished = await ben.c.finish();
      return {
        w,
        benLive,
        gapSeen,
        finished: finished!,
        saved: ben.saved[0]!,
        commands: ben.trainer.commands,
      };
    };
    const hit = await play(true);
    const calm = await play(false);

    expect(hit.benLive.powerUps!.raceOffsetM).toBeLessThan(-5);
    expect(hit.benLive.powerUps!.cards!.lossM).toBeLessThan(-5);
    expect(calm.benLive.powerUps!.raceOffsetM).toBe(0);
    expect(hit.finished.powerUps).toMatchObject({ mode: 'cardRace' });
    expect(hit.finished.powerUps!.lossM).toBeLessThan(-5);
    // Others place Ben by his race position: the gap Anna sees shrank by his loss.
    expect(Math.abs(hit.gapSeen - calm.gapSeen - hit.benLive.powerUps!.raceOffsetM)).toBeLessThan(
      4,
    );
    // The recorded ride is byte-identical: samples, FIT file, points and bests.
    expect(hit.saved).toEqual(calm.saved);
    expect(encodeFit(hit.saved)).toEqual(encodeFit(calm.saved));
    const facts = (r: RecordedRide) =>
      rideFacts({
        rideId: r.id,
        startedAt: r.startedAt,
        samples: r.samples,
        ftpW: 200,
        utcOffsetMin: 0,
      });
    expect(facts(hit.saved)).toEqual(facts(calm.saved));
    // And the trainer's resistance was never touched by the attack.
    expect(hit.commands).toEqual(calm.commands);
    for (const w of [hit.w, calm.w]) for (const r of w.riders) r.ride.leave();
  });

  it('a raised Shield blocks it; protection then stops a second hit, even from a buggy peer', async () => {
    const { anna, ben, cleo, step, seen, riders } = await world(kind, {
      Anna: ['headwind'],
      Ben: ['shield'],
      Cleo: ['tailwind'],
    });
    expect(ben.c.playCard(0)).toBe(true);
    await step(1);
    expect(cardsOf(ben).shield?.remainingS).toBeGreaterThan(55);
    expect(seen(anna, ben)!.cards?.shieldS).toBeGreaterThan(50); // the bubble others draw
    expect(anna.c.playCard(0)).toBe(true);
    await step(2);
    expect(cardsOf(anna).outgoing).toMatchObject({ target: 'Ben', result: 'blocked' });
    expect(cardsOf(ben).incoming).toMatchObject({ by: 'Anna', result: 'blocked' });
    expect(cardsOf(ben).shield).toBeNull();
    expect(cardsOf(ben).attack).toBeNull();
    expect(cardsOf(ben).protection?.remainingS).toBeGreaterThan(10);
    expect(seen(cleo, ben)!.cards?.protectedS).toBeGreaterThan(10);
    // Anna's view knows: the card waits.
    expect(anna.c.playCard(1)).toBe(false);
    // A peer that ignores that is refused by Ben himself.
    const results: string[] = [];
    anna.ride.onAttackResult((o) => results.push(o.result));
    const gapM = seen(anna, ben)!.gapM;
    const me = {
      distanceM: anna.live().ride.distanceM,
      offsetM: anna.live().powerUps!.raceOffsetM,
      route: null,
    };
    anna.ride.sendAttack('peer-b', () => ({
      kind: 'headwind',
      gapM,
      ...attackPosition(me, false),
    }));
    await step(2);
    expect(results).toEqual(['protected']);
    expect(cardsOf(ben).attack).toBeNull();
    expect(ben.live().powerUps!.raceOffsetM).toBe(0);
    // Protection over: the next card lands.
    await step(14);
    expect(cardsOf(ben).protection).toBeNull();
    expect(anna.c.playCard(1)).toBe(true);
    await step(2);
    expect(cardsOf(ben).attack?.kind).toBe('headwind');
    for (const r of riders) r.ride.leave();
  });

  it('Fog on the leader hides the gaps on the leader’s screen only', async () => {
    const { anna, ben, cleo, step, riders } = await world(kind, {
      Anna: ['tailwind'],
      Ben: ['tailwind'],
      Cleo: ['fog'],
    });
    // Cleo is last; Ben leads: Fog goes to Ben, past Anna.
    expect(cardsOf(cleo).slotTargets[0]).toBe('Ben');
    expect(cleo.c.playCard(0)).toBe(true);
    await step(2);
    expect(cardsOf(ben).attack).toMatchObject({ kind: 'fog', by: 'Cleo' });
    expect(gapsHidden(ben.live().powerUps)).toBe(true);
    expect(gapsHidden(anna.live().powerUps)).toBe(false);
    expect(gapsHidden(cleo.live().powerUps)).toBe(false);
    const rows = (r: Rider) => groupRows(r.live()).filter((x) => !x.local);
    expect(rows(ben).every((x) => x.gapText === '?')).toBe(true);
    expect(rows(anna).every((x) => x.gapText !== '?')).toBe(true);
    expect(ben.live().powerUps!.raceOffsetM).toBe(0); // no physics
    await step(12);
    expect(gapsHidden(ben.live().powerUps)).toBe(false);
    for (const r of riders) r.ride.leave();
  });

  it('the host switches the mode for everyone; an old app is marked, passed over and can still read us', async () => {
    const { anna, ben, cleo, step, net, riders } = await world(kind, {
      Anna: ['headwind'],
      Ben: ['tailwind'],
      Cleo: ['tailwind'],
    });
    anna.c.setGroupRules({ powerUps: true, mode: 'normal' });
    await step(2);
    expect(ben.live().group?.mode).toBeUndefined();
    expect(ben.live().powerUps!.cards).toBeUndefined();
    expect(ben.live().powerUps!.capacity).toBe(1);
    expect(cleo.live().powerUps!.hand.length).toBeLessThanOrEqual(1);
    anna.c.setGroupRules({ powerUps: true, mode: 'cardRace' });
    await step(2);
    expect(ben.live().group?.mode).toBe('cardRace');
    expect(ben.live().powerUps!.capacity).toBe(2);

    // Dora runs an app without the Card Race: no `cards` in her state. She rides between
    // Anna and Ben.
    const dora = await net.join(anna.ride, 'Dora', 'peer-d');
    const doraAt = () => {
      const a = anna.live().ride.distanceM;
      const b = ben.live().ride.distanceM;
      return (a + b) / 2;
    };
    for (let i = 0; i < 12; i++) {
      dora.setLocalState({
        distanceM: doraAt(),
        speedMps: 8,
        powerW: 180,
        cadenceRpm: 85,
        heartRateBpm: null,
        gear: 9,
      });
      await step(0.5);
    }
    const riderList = anna.live().group!.riders;
    const doraSeen = riderList.find((r) => r.name === 'Dora')!;
    expect(doraSeen.gapM).toBeGreaterThan(0);
    expect(incompatibleRiders(riderList).map((r) => r.name)).toEqual(['Dora']);
    expect(incompatibleNote(['Dora'])).toBe('Dora’s app does not support Card Race');
    // Directly ahead in the race is Ben, not Dora.
    await step(4);
    expect(cardsOf(anna).slotTargets[0]).toBe('Ben');
    // Dora reads everyone; no packet she gets carries a negative plain race offset.
    expect(
      dora
        .getRiders()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['Anna', 'Ben', 'Cleo']);
    const states = net
      .sentMessages()
      .filter((m) => m.includes('"type":"state"'))
      .map(
        (m) => JSON.parse(m) as { state: { raceOffsetM?: number; rules?: { powerUps: unknown } } },
      );
    expect(states.every((s) => s.state.raceOffsetM === undefined || s.state.raceOffsetM >= 0)).toBe(
      true,
    );
    expect(
      states
        .filter((s) => s.state.rules)
        .every((s) => typeof s.state.rules!.powerUps === 'boolean'),
    ).toBe(true);
    dora.leave();
    for (const r of riders) r.ride.leave();
  });
});
