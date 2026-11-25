/**
 * Freilauf Rumble end to end (docs/rumble.md, ADR 0008): three riders, each with a real
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
import { attackPosition, incompatibleNote, incompatibleRiders } from './rumble';
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
/** A feed bag every 40 m; each rider draws only the items a test needs. */
const tuning = (itemPool: PowerUpKind[]) => ({ spacingM: [40, 40], itemPool });

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
  // Anna created the ride: she is the host and chooses Freilauf Rumble.
  anna.c.setGroupRules({ powerUps: true, mode: 'rumble' });
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
  // Ben starts first (he leads), then Anna, then Cleo: Ben is directly ahead of Anna, Cleo
  // rides behind Anna.
  ben.c.start();
  await step(12);
  anna.c.start();
  await step(6);
  cleo.c.start();
  await step(12);
  const seen = (by: Rider, who: Rider) => by.live().group!.riders.find((r) => r.name === who.name);
  return { clock, net, anna, ben, cleo, step, seen, riders };
}

const rumbleOf = (r: Rider) => r.live().powerUps!.rumble!;

/** The recorded ride, its FIT bytes, its community facts and every trainer command. */
function recording(r: Rider, saved: RecordedRide) {
  return {
    saved,
    fit: encodeFit(saved),
    facts: rideFacts({
      rideId: saved.id,
      startedAt: saved.startedAt,
      samples: saved.samples,
      ftpW: 200,
      utcOffsetMin: 0,
    }),
    commands: r.trainer.commands,
  };
}

describe.each(TEST_TRANSPORTS)('Freilauf Rumble over GroupRide (%s)', (kind) => {
  it('a water bottle from Anna hits Ben, directly ahead: he loses race position, not recorded distance', async () => {
    const play = async (attack: boolean) => {
      const w = await world(kind, { Anna: ['bottle'], Ben: ['tailwind'], Cleo: ['tailwind'] });
      const { anna, ben, cleo, step, seen } = w;
      expect(anna.live().group?.mode).toBe('rumble');
      expect(ben.live().group?.mode).toBe('rumble'); // from the host's rules
      expect(rumbleOf(anna).slots).toEqual(['bottle', 'bottle']);
      expect(seen(anna, ben)!.gapM).toBeGreaterThan(20);
      expect(rumbleOf(anna).slotTargets).toEqual(['Ben', 'Ben']);
      if (attack) expect(anna.c.useItem(0, 'keyboard')).toBe(true);
      await step(2);
      if (attack) {
        expect(rumbleOf(ben).hit).toMatchObject({ kind: 'bottle', by: 'Anna' });
        expect(rumbleOf(ben).incoming).toMatchObject({ kind: 'bottle', by: 'Anna', result: 'hit' });
        expect(rumbleOf(anna).outgoing).toMatchObject({
          kind: 'bottle',
          target: 'Ben',
          targetId: 'peer-b',
          result: 'hit',
        });
        // Cleo sees the effect on Ben, from Ben's own state.
        expect(seen(cleo, ben)!.items?.hit?.kind).toBe('bottle');
        expect(seen(cleo, anna)!.items?.hit).toBeUndefined();
        // Ben is protected now: Anna's second bottle waits instead of being wasted.
        expect(rumbleOf(anna).slotNotes[1]).toMatch(/^Ben is protected/);
        expect(anna.c.useItem(1)).toBe(false);
      }
      await step(30);
      const benLive = ben.live();
      const gapSeen = seen(anna, ben)!.gapM;
      const finished = await ben.c.finish();
      return { w, benLive, gapSeen, finished: finished!, rec: recording(ben, ben.saved[0]!) };
    };
    const hit = await play(true);
    const calm = await play(false);

    expect(hit.benLive.powerUps!.raceOffsetM).toBeLessThan(-10);
    expect(hit.benLive.powerUps!.rumble!.lossM).toBeLessThan(-10);
    expect(calm.benLive.powerUps!.raceOffsetM).toBe(0);
    expect(hit.finished.powerUps).toMatchObject({ mode: 'rumble' });
    expect(hit.finished.powerUps!.lossM).toBeLessThan(-10);
    // Others place Ben by his race position: the gap Anna sees shrank by his loss.
    expect(Math.abs(hit.gapSeen - calm.gapSeen - hit.benLive.powerUps!.raceOffsetM)).toBeLessThan(
      4,
    );
    // The recorded ride is byte-identical: samples, FIT file, points and bests; and the
    // trainer's resistance was never touched by the hit.
    expect(hit.rec).toEqual(calm.rec);
    for (const w of [hit.w, calm.w]) for (const r of w.riders) r.ride.leave();
  });

  it('Anna’s mud puddle hits Cleo behind her exactly once; Anna and Ben never; Cleo’s recording is unchanged', async () => {
    const play = async (drop: boolean) => {
      const w = await world(kind, { Anna: ['puddle'], Ben: ['tailwind'], Cleo: ['tailwind'] });
      const { anna, ben, cleo, step, seen } = w;
      expect(seen(anna, cleo)!.gapM).toBeLessThan(-20);
      expect(rumbleOf(anna).slots).toEqual(['puddle', 'puddle']);
      expect(rumbleOf(anna).slotTargets).toEqual([null, null]);
      const hits = { anna: 0, ben: 0, cleo: 0 };
      const count = () => {
        for (const [r, key] of [
          [anna, 'anna'],
          [ben, 'ben'],
          [cleo, 'cleo'],
        ] as const) {
          const e = r.live().powerUps!.event;
          if (e?.type === 'hit') hits[key] = Math.max(hits[key], e.seq);
        }
      };
      let seenAhead = false;
      if (drop) expect(anna.c.useItem(0, 'keyboard')).toBe(true);
      await step(1); // the same ride either way
      if (drop) {
        expect(rumbleOf(anna).outgoing).toMatchObject({ kind: 'puddle', result: 'sent' });
        // Everyone sees the same puddle at the same place: behind Anna (and Ben), ahead of Cleo.
        const own = rumbleOf(anna).puddles.find((p) => p.own)!;
        expect(own.aheadM).toBeLessThan(0);
        expect(own.aheadM).toBeGreaterThan(-15);
        const forCleo = rumbleOf(cleo).puddles.find((p) => !p.own)!;
        expect(forCleo).toMatchObject({ by: 'Anna', own: false });
        expect(forCleo.aheadM).toBeGreaterThan(5);
        expect(Math.abs(forCleo.aheadM - (seen(cleo, anna)!.gapM + own.aheadM))).toBeLessThan(6);
        expect(rumbleOf(ben).puddles.every((p) => p.aheadM < 0)).toBe(true);
        expect(seen(cleo, anna)!.items?.puddles).toHaveLength(1);
        seenAhead = true;
      }
      // Cleo rides on and through it.
      const incomingSeqs = new Set<number>();
      for (let i = 0; i < 40; i++) {
        await step(0.5);
        count();
        const inc = rumbleOf(cleo).incoming;
        if (inc) incomingSeqs.add(inc.seq);
      }
      if (drop) {
        expect(seenAhead).toBe(true);
        expect(rumbleOf(cleo).incoming).toMatchObject({
          kind: 'puddle',
          by: 'Anna',
          result: 'hit',
        });
        expect(incomingSeqs.size).toBe(1); // hit exactly once
        expect(rumbleOf(anna).outgoing).toMatchObject({
          kind: 'puddle',
          target: 'Cleo',
          result: 'hit',
        });
        // Used up: gone from the road for everyone.
        expect(rumbleOf(cleo).puddles).toEqual([]);
        expect(rumbleOf(anna).puddles).toEqual([]);
        expect(seen(cleo, anna)!.items?.puddles).toBeUndefined();
        // Nobody else, and never the dropper.
        expect(rumbleOf(anna).incoming).toBeNull();
        expect(rumbleOf(ben).incoming).toBeNull();
        expect(rumbleOf(cleo).lossM).toBeLessThan(-8);
      }
      await step(20);
      const cleoLive = cleo.live();
      await cleo.c.finish();
      return { w, cleoLive, rec: recording(cleo, cleo.saved[0]!) };
    };
    const hit = await play(true);
    const calm = await play(false);
    expect(hit.cleoLive.powerUps!.raceOffsetM).toBeLessThan(-8);
    expect(calm.cleoLive.powerUps!.raceOffsetM).toBe(0);
    // Riding through the puddle changed Cleo's race position only.
    expect(hit.rec).toEqual(calm.rec);
    for (const w of [hit.w, calm.w]) for (const r of w.riders) r.ride.leave();
  });

  it('hornets chase the leader, past the rider in between, and hide the gaps on the leader’s screen only', async () => {
    const { anna, ben, cleo, step, riders } = await world(kind, {
      Anna: ['tailwind'],
      Ben: ['tailwind'],
      Cleo: ['hornets'],
    });
    // Cleo is last; Ben leads: the hornets go to Ben, past Anna.
    expect(rumbleOf(cleo).slotTargets[0]).toBe('Ben');
    expect(cleo.c.useItem(0)).toBe(true);
    await step(2);
    expect(rumbleOf(ben).hit).toMatchObject({ kind: 'hornets', by: 'Cleo' });
    expect(gapsHidden(ben.live().powerUps)).toBe(true);
    expect(gapsHidden(anna.live().powerUps)).toBe(false);
    expect(gapsHidden(cleo.live().powerUps)).toBe(false);
    const rows = (r: Rider) => groupRows(r.live()).filter((x) => !x.local);
    expect(rows(ben).every((x) => x.gapText === '?')).toBe(true);
    expect(rows(anna).every((x) => x.gapText !== '?')).toBe(true);
    await step(8);
    expect(gapsHidden(ben.live().powerUps)).toBe(false);
    await step(30);
    expect(ben.live().powerUps!.raceOffsetM).toBeLessThan(-10); // slowed too
    for (const r of riders) r.ride.leave();
  });

  it('a rain cape keeps off a bottle; protection then stops a second hit, even from a buggy peer', async () => {
    const { anna, ben, cleo, step, seen, riders } = await world(kind, {
      Anna: ['bottle'],
      Ben: ['cape'],
      Cleo: ['tailwind'],
    });
    expect(ben.c.useItem(0)).toBe(true);
    await step(1);
    expect(rumbleOf(ben).cape?.remainingS).toBeGreaterThan(55);
    expect(seen(anna, ben)!.items?.capeS).toBeGreaterThan(50); // the cape others draw
    expect(anna.c.useItem(0)).toBe(true);
    await step(2);
    expect(rumbleOf(anna).outgoing).toMatchObject({ target: 'Ben', result: 'blocked' });
    expect(rumbleOf(ben).incoming).toMatchObject({ by: 'Anna', result: 'blocked' });
    expect(rumbleOf(ben).cape).toBeNull();
    expect(rumbleOf(ben).hit).toBeNull();
    expect(rumbleOf(ben).protection?.remainingS).toBeGreaterThan(10);
    expect(seen(cleo, ben)!.items?.protectedS).toBeGreaterThan(10);
    // Anna's view knows: the item waits.
    expect(anna.c.useItem(1)).toBe(false);
    // A peer that ignores that is refused by Ben himself.
    const results: string[] = [];
    anna.ride.onAttackResult((o) => results.push(o.result));
    const gapM = seen(anna, ben)!.gapM;
    const me = {
      distanceM: anna.live().ride.distanceM,
      offsetM: anna.live().powerUps!.raceOffsetM,
      route: null,
    };
    anna.ride.sendAttack('peer-b', () => ({ kind: 'bottle', gapM, ...attackPosition(me, false) }));
    await step(2);
    expect(results).toEqual(['protected']);
    expect(rumbleOf(ben).hit).toBeNull();
    expect(ben.live().powerUps!.raceOffsetM).toBe(0);
    // Protection over: the next bottle lands.
    await step(14);
    expect(rumbleOf(ben).protection).toBeNull();
    expect(anna.c.useItem(1)).toBe(true);
    await step(2);
    expect(rumbleOf(ben).hit?.kind).toBe('bottle');
    for (const r of riders) r.ride.leave();
  });

  it('a rain cape keeps off a puddle too: it is used up without slowing anyone', async () => {
    const { anna, cleo, step, riders } = await world(kind, {
      Anna: ['puddle'],
      Ben: ['tailwind'],
      Cleo: ['cape'],
    });
    expect(cleo.c.useItem(0)).toBe(true);
    expect(anna.c.useItem(0)).toBe(true);
    for (let i = 0; i < 40 && !rumbleOf(cleo).incoming; i++) await step(0.5);
    expect(rumbleOf(cleo).incoming).toMatchObject({ kind: 'puddle', result: 'blocked' });
    expect(rumbleOf(cleo).cape).toBeNull();
    expect(rumbleOf(cleo).hit).toBeNull();
    expect(cleo.live().powerUps!.raceOffsetM).toBe(0);
    await step(2);
    expect(rumbleOf(anna).puddles).toEqual([]);
    for (const r of riders) r.ride.leave();
  });

  it('the host switches the mode for everyone; an app without Rumble is marked, passed over, cannot claim a puddle and can still read us', async () => {
    const { anna, ben, cleo, step, net, riders } = await world(kind, {
      Anna: ['puddle'],
      Ben: ['tailwind'],
      Cleo: ['bottle'],
    });
    anna.c.setGroupRules({ powerUps: true, mode: 'normal' });
    await step(2);
    expect(ben.live().group?.mode).toBeUndefined();
    expect(ben.live().powerUps!.rumble).toBeUndefined();
    expect(ben.live().powerUps!.capacity).toBe(1);
    expect(cleo.live().powerUps!.hand.length).toBeLessThanOrEqual(1);
    anna.c.setGroupRules({ powerUps: true, mode: 'rumble' });
    await step(2);
    expect(ben.live().group?.mode).toBe('rumble');
    expect(ben.live().powerUps!.capacity).toBe(2);

    // Dora runs an app without Freilauf Rumble (an old one: no `items` in her state, its old
    // `cards` field is not read). She rides between Anna and Ben.
    const dora = await net.join(anna.ride, 'Dora', 'peer-d');
    const doraAt = () => (anna.live().ride.distanceM + ben.live().ride.distanceM) / 2;
    for (let i = 0; i < 12; i++) {
      dora.setLocalState({
        distanceM: doraAt(),
        speedMps: 8,
        powerW: 180,
        cadenceRpm: 85,
        heartRateBpm: null,
        gear: 9,
        ...({ cards: { v: 1, offsetM: -40 } } as object),
      });
      await step(0.5);
    }
    const riderList = anna.live().group!.riders;
    const doraSeen = riderList.find((r) => r.name === 'Dora')!;
    expect(doraSeen.gapM).toBeGreaterThan(0);
    expect(doraSeen.items).toBeUndefined();
    expect(incompatibleRiders(riderList).map((r) => r.name)).toEqual(['Dora']);
    expect(incompatibleNote(['Dora'])).toBe('Dora’s app does not support Freilauf Rumble');
    // Directly ahead of Anna in the race is Ben, not Dora.
    await step(4);
    expect(rumbleOf(cleo).slotTargets[0]).not.toBe('Dora');
    // Anna drops a puddle; a claim from Dora's app is refused (she is not in the race).
    expect(anna.c.useItem(0)).toBe(true);
    await step(1);
    const puddle = riders[0]!.ride.getRiders().length >= 0 ? rumbleOf(anna).puddles[0] : undefined;
    expect(puddle?.own).toBe(true);
    const id = cleo.ride.getRiders().find((r) => r.name === 'Anna')!.items!.puddles![0]!.id;
    const claims: string[] = [];
    dora.onClaimResult((o) => claims.push(o.result));
    dora.claimPuddle('peer-a', () => ({ puddle: id, raceM: anna.live().ride.distanceM - 2 }));
    await step(3);
    expect(claims).toEqual(['refused']);
    expect(rumbleOf(anna).puddles.some((p) => p.own)).toBe(true); // still on the road
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
