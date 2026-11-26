/**
 * Freilauf Rumble over the real GroupRide on both transports (docs/adr/0008-rumble-items.md):
 * attacks and puddle claims exactly once across loss, duplicates and reordering; every check of
 * an incoming event; a puddle hits exactly one rider.
 */
import { describe, expect, it } from 'vitest';
import type {
  AttackOutcomeEvent,
  ClaimOutcomeEvent,
  ClaimVerdict,
  IncomingAttack,
  IncomingClaim,
} from './rumble';
import { PuddleLedger, encodeAttack, encodeClaim } from './rumble';
import type { GroupRide, LocalRiderState } from './group';
import { createTestNetwork, FakeClock, TEST_TRANSPORTS } from './testing';

function local(distanceM: number): LocalRiderState {
  return {
    distanceM,
    speedMps: 9,
    powerW: 200,
    cadenceRpm: 90,
    heartRateBpm: null,
    gear: 11,
    items: { v: 2, offsetM: 0 },
  };
}

const payload =
  (kind = 'bottle') =>
  () => ({ kind, gapM: 40, raceM: 1000 });

describe.each(TEST_TRANSPORTS)('Rumble attacks over GroupRide (%s)', (kind) => {
  async function world(riders = 3) {
    const clock = new FakeClock();
    const net = createTestNetwork(kind, { clock, seed: 11 });
    const anna = await net.create('Anna', 'peer-a');
    const ben = await net.join(anna, 'Ben', 'peer-b');
    const cleo = riders > 2 ? await net.join(anna, 'Cleo', 'peer-c') : null;
    await clock.advanceAsync(500);
    const all = [anna, ben, ...(cleo ? [cleo] : [])];
    all.forEach((r, i) => r.setLocalState(local(1000 + i * 50)));
    await clock.advanceAsync(1000);
    const calls = new Map<GroupRide, IncomingAttack[]>();
    const results = new Map<GroupRide, AttackOutcomeEvent[]>();
    for (const r of all) {
      calls.set(r, []);
      results.set(r, []);
      r.setAttackHandler((a) => {
        calls.get(r)!.push(a);
        return 'hit';
      });
      r.onAttackResult((o) => results.get(r)!.push(o));
    }
    return { clock, net, anna, ben, cleo: cleo!, calls, results };
  }

  it('applies each attack exactly once despite loss, duplicates and reordering', async () => {
    const { clock, net, anna, ben, cleo, calls, results } = await world();
    // The mesh drops a third, doubles a third and reorders; the relay channel only delays.
    net.setConditions({ lossRate: 0.3, duplicateRate: 0.3, maxDelayMs: 300 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(anna.sendAttack('peer-b', payload(i === 1 ? 'hornets' : 'bottle'))!);
      await clock.advanceAsync(2_000);
    }
    await clock.advanceAsync(8_000);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    const got = calls.get(ben)!;
    expect(got.map((a) => a.id).sort()).toEqual([...ids].sort());
    expect(got.map((a) => a.kind).sort()).toEqual(['bottle', 'bottle', 'hornets']);
    expect(got.every((a) => a.from === 'peer-a' && a.fromName === 'Anna')).toBe(true);
    // Exactly one outcome per attack, the target's verdict.
    expect(
      results
        .get(anna)!
        .map((r) => r.id)
        .sort(),
    ).toEqual([...ids].sort());
    expect(results.get(anna)!.every((r) => r.result === 'hit' && r.to === 'peer-b')).toBe(true);
    // Nobody else was asked.
    expect(calls.get(anna)).toEqual([]);
    expect(calls.get(cleo)).toEqual([]);
    const attacksSent = net.sentMessages().filter((m) => m.includes('"rumble-attack"')).length;
    if (kind === 'self-hosted') {
      expect(net.dropped).toBeGreaterThan(0);
      expect(attacksSent).toBeGreaterThanOrEqual(3); // retries where copies were lost
    } else expect(attacksSent).toBe(3); // reliable: one send each
    for (const r of [anna, ben, cleo]) r.leave();
  });

  it('refuses attacks not meant for the receiver, replays, floods and non-members', async () => {
    const { clock, net, anna, ben, calls, results } = await world(2);
    const outcome: string[] = [];
    // Watch the acks Ben sends back by listening on Anna's side for injected ids too.
    const acks = () =>
      net
        .sentMessages()
        .filter((m) => m.includes('"rumble-ack"'))
        .map((m) => JSON.parse(m) as { id: string; result: string });
    // 1. Meant for someone else.
    net.inject(
      anna,
      ben,
      encodeAttack({ id: 'evil0001.1', to: 'peer-c', kind: 'bottle', gapM: 5, raceM: 1 }),
    );
    // 2. Not a Rumble message at all / malformed / the superseded format: dropped silently.
    net.inject(anna, ben, '{"v":2,"type":"rumble-attack","id":"x"}');
    net.inject(anna, ben, '{"v":2,"type":"rumble-attack",');
    net.inject(
      anna,
      ben,
      '{"v":1,"type":"card-attack","id":"evil0001.50","to":"peer-b","kind":"headwind","gapM":5,"raceM":1}',
    );
    await clock.advanceAsync(500);
    expect(calls.get(ben)).toEqual([]);
    expect(acks().find((a) => a.id === 'evil0001.1')?.result).toBe('refused');
    // 3. A genuine one, then the very same message replayed later: applied once.
    const raw = encodeAttack({
      id: 'evil0001.2',
      to: 'peer-b',
      kind: 'bottle',
      gapM: 5,
      raceM: 1,
    });
    net.inject(anna, ben, raw);
    await clock.advanceAsync(500);
    net.inject(anna, ben, raw);
    await clock.advanceAsync(60_000);
    net.inject(anna, ben, raw);
    await clock.advanceAsync(500);
    expect(calls.get(ben)!.map((a) => a.id)).toEqual(['evil0001.2']);
    expect(
      acks()
        .filter((a) => a.id === 'evil0001.2')
        .every((a) => a.result === 'hit'),
    ).toBe(true);
    // 4. A flood: at most 3 in 30 s and 1 s apart are even considered.
    for (let i = 3; i < 13; i++) {
      net.inject(
        anna,
        ben,
        encodeAttack({ id: `evil0001.${i}`, to: 'peer-b', kind: 'hornets', gapM: 5, raceM: 1 }),
      );
      await clock.advanceAsync(300);
    }
    expect(calls.get(ben)!.length).toBeLessThanOrEqual(1 + 3);
    expect(acks().filter((a) => a.result === 'refused').length).toBeGreaterThanOrEqual(7);
    outcome.push(...results.get(anna)!.map((r) => r.result));
    expect(outcome).toEqual([]); // injected ids were never Anna's own: no outcome on her side
    anna.leave();
    ben.leave();
  });

  it('refuses a rider who has not sent its state yet; no handler: unavailable; a throwing one: refused', async () => {
    const clock = new FakeClock();
    const net = createTestNetwork(kind, { clock, seed: 3 });
    const anna = await net.create('Anna', 'peer-a');
    const ben = await net.join(anna, 'Ben', 'peer-b');
    await clock.advanceAsync(500);
    ben.setLocalState(local(900));
    const results: AttackOutcomeEvent[] = [];
    anna.onAttackResult((o) => results.push(o));
    // Anna never sent a state: not (yet) a rider of the race.
    anna.sendAttack('peer-b', payload());
    await clock.advanceAsync(6_000);
    anna.setLocalState(local(1000));
    await clock.advanceAsync(1_000);
    anna.sendAttack('peer-b', payload()); // Ben has no handler
    await clock.advanceAsync(2_000);
    ben.setAttackHandler(() => {
      throw new Error('boom');
    });
    anna.sendAttack('peer-b', payload());
    await clock.advanceAsync(2_000);
    expect(results.map((r) => r.result)).toEqual(['refused', 'unavailable', 'refused']);
    // Sending to someone who is not connected does nothing.
    expect(anna.sendAttack('peer-zz', payload())).toBeNull();
    anna.leave();
    ben.leave();
  });

  it('an attack whose target leaves before answering times out, once', async () => {
    const { clock, anna, ben, cleo, results } = await world();
    ben.setAttackHandler(null);
    // Ben leaves before the attack reaches him: no answer comes.
    expect(anna.sendAttack('peer-b', payload())).not.toBeNull();
    ben.leave();
    await clock.advanceAsync(8_000);
    expect(results.get(anna)!.map((r) => r.result)).toEqual(['timeout']);
    expect(anna.sendAttack('peer-b', payload())).toBeNull();
    anna.leave();
    cleo.leave();
  });
});

describe.each(TEST_TRANSPORTS)('Puddle claims over GroupRide (%s)', (kind) => {
  /** Anna drops a puddle at 1000 m; Ben and Cleo ride through it. */
  async function world(seed = 5) {
    const clock = new FakeClock();
    const net = createTestNetwork(kind, { clock, seed });
    const anna = await net.create('Anna', 'peer-a');
    const ben = await net.join(anna, 'Ben', 'peer-b');
    const cleo = await net.join(anna, 'Cleo', 'peer-c');
    await clock.advanceAsync(500);
    for (const [r, m] of [
      [anna, 1010],
      [ben, 990],
      [cleo, 995],
    ] as const)
      r.setLocalState(local(m));
    await clock.advanceAsync(1000);
    const book = new PuddleLedger('drop0001');
    const puddle = book.drop({ m: 1000 }, clock.now())!;
    const decided: IncomingClaim[] = [];
    let firsts = 0;
    anna.setPuddleClaimHandler((c): ClaimVerdict => {
      decided.push(c);
      const d = book.decide(c, clock.now());
      if (d.first) firsts += 1;
      return d.result;
    });
    const results = new Map<string, ClaimOutcomeEvent[]>();
    for (const r of [ben, cleo]) {
      results.set(r.name, []);
      r.onClaimResult((o) => results.get(r.name)!.push(o));
    }
    return {
      clock,
      net,
      anna,
      ben,
      cleo,
      puddle,
      decided,
      results,
      firsts: () => firsts,
      all: [anna, ben, cleo],
    };
  }

  it('two riders claim at the same moment: exactly one is hit, the other is told taken', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const w = await world(seed);
      w.net.setConditions({ lossRate: 0.3, duplicateRate: 0.3, maxDelayMs: 300 });
      const claim = () => ({ puddle: w.puddle, raceM: 1001 });
      expect(w.ben.claimPuddle('peer-a', claim)).not.toBeNull();
      expect(w.cleo.claimPuddle('peer-a', claim)).not.toBeNull();
      await w.clock.advanceAsync(8_000);
      const outcome = [...w.results.get('Ben')!, ...w.results.get('Cleo')!].map((o) => o.result);
      // Each claimer hears exactly once; exactly one of them is granted.
      expect(outcome).toHaveLength(2);
      expect(outcome.filter((r) => r === 'granted')).toHaveLength(1);
      expect(outcome.filter((r) => r === 'taken')).toHaveLength(1);
      expect(w.firsts()).toBe(1);
      // Duplicates and re-sends never reached the handler twice per claim id.
      expect(new Set(w.decided.map((c) => c.id)).size).toBe(w.decided.length);
      for (const r of w.all) r.leave();
    }
  });

  it('lost acks: the claimer re-sends and still hears granted once', async () => {
    const w = await world();
    if (kind === 'self-hosted')
      w.net.setConditions({ lossRate: 0.5, duplicateRate: 0.2, maxDelayMs: 200 });
    w.ben.claimPuddle('peer-a', () => ({ puddle: w.puddle, raceM: 1002 }));
    await w.clock.advanceAsync(8_000);
    expect(w.results.get('Ben')!.map((o) => o.result)).toEqual(['granted']);
    expect(w.firsts()).toBe(1);
    expect(w.decided.every((c) => c.from === 'peer-b' && c.fromName === 'Ben')).toBe(true);
    for (const r of w.all) r.leave();
  });

  it('unknown, used and implausible claims; a forged duplicate is answered again, never decided twice', async () => {
    const w = await world();
    const acks = () =>
      w.net
        .sentMessages()
        .filter((m) => m.includes('"puddle-ack"'))
        .map((m) => JSON.parse(m) as { id: string; result: string });
    w.ben.claimPuddle('peer-a', () => ({ puddle: 'drop0001.77', raceM: 1001 }));
    w.ben.claimPuddle('peer-a', () => ({ puddle: w.puddle, raceM: 700 }));
    await w.clock.advanceAsync(2_000);
    expect(w.results.get('Ben')!.map((o) => o.result)).toEqual(['gone', 'refused']);
    // Forged messages travel on the first link (Anna → Ben): Ben drops a puddle of his own.
    const bens = new PuddleLedger('drop0002');
    const benPuddle = bens.drop({ m: 985 }, w.clock.now())!;
    const benDecided: IncomingClaim[] = [];
    w.ben.setPuddleClaimHandler((c) => (benDecided.push(c), bens.decide(c, w.clock.now()).result));
    const raw = encodeClaim({ id: 'evil0002.1', to: 'peer-b', puddle: benPuddle, raceM: 986 });
    w.net.inject(w.anna, w.ben, raw);
    await w.clock.advanceAsync(500);
    w.net.inject(w.anna, w.ben, raw);
    await w.clock.advanceAsync(500);
    expect(
      acks()
        .filter((a) => a.id === 'evil0002.1')
        .map((a) => a.result),
    ).toEqual(['granted', 'granted']);
    expect(benDecided.filter((c) => c.id === 'evil0002.1')).toHaveLength(1);
    // Now it is used: Cleo's later claim is taken.
    w.cleo.claimPuddle('peer-b', () => ({ puddle: benPuddle, raceM: 987 }));
    await w.clock.advanceAsync(2_000);
    expect(w.results.get('Cleo')!.at(-1)!.result).toBe('taken');
    // Meant for someone else: refused, without asking the handler.
    w.net.inject(
      w.anna,
      w.ben,
      encodeClaim({ id: 'evil0002.2', to: 'peer-c', puddle: benPuddle, raceM: 1 }),
    );
    await w.clock.advanceAsync(500);
    expect(acks().find((a) => a.id === 'evil0002.2')?.result).toBe('refused');
    expect(benDecided.some((c) => c.id === 'evil0002.2')).toBe(false);
    w.results.get('Cleo')!.length = 0;
    // No handler: gone. A throwing handler: refused.
    w.anna.setPuddleClaimHandler(null);
    w.cleo.claimPuddle('peer-a', () => ({ puddle: w.puddle, raceM: 1001 }));
    await w.clock.advanceAsync(1_500);
    w.anna.setPuddleClaimHandler(() => {
      throw new Error('boom');
    });
    w.cleo.claimPuddle('peer-a', () => ({ puddle: w.puddle, raceM: 1001 }));
    await w.clock.advanceAsync(1_500);
    expect(w.results.get('Cleo')!.map((o) => o.result)).toEqual(['gone', 'refused']);
    // A dropper who left: no answer, one timeout (or nothing sent once the link is gone).
    w.anna.leave();
    const before = w.results.get('Ben')!.length;
    const sentLate = w.ben.claimPuddle('peer-a', () => ({ puddle: w.puddle, raceM: 1 }));
    await w.clock.advanceAsync(8_000);
    expect(
      w.results
        .get('Ben')!
        .slice(before)
        .map((o) => o.result),
    ).toEqual(sentLate === null ? [] : ['timeout']);
    w.ben.leave();
    w.cleo.leave();
  });
});

describe.each(TEST_TRANSPORTS)('Tacks claims over GroupRide (%s) (ADR 0009)', (kind) => {
  /**
   * Anna drops a puddle and tacks (two ledgers, as the app does); Ben and Cleo ride over the
   * tacks. The dropper's handler routes each claim to the ledger that knows the id.
   */
  async function world(seed = 5) {
    const clock = new FakeClock();
    const net = createTestNetwork(kind, { clock, seed });
    const anna = await net.create('Anna', 'peer-a');
    const ben = await net.join(anna, 'Ben', 'peer-b');
    const cleo = await net.join(anna, 'Cleo', 'peer-c');
    await clock.advanceAsync(500);
    for (const [r, m] of [
      [anna, 1010],
      [ben, 990],
      [cleo, 995],
    ] as const)
      r.setLocalState({ ...local(m), items: { v: 3, offsetM: 0 } });
    await clock.advanceAsync(1000);
    const mud = new PuddleLedger('mudd0001');
    const tacks = new PuddleLedger('tack0001');
    mud.drop({ m: 1000 }, clock.now());
    const tack = tacks.drop({ m: 1000 }, clock.now())!;
    const firsts = { mud: 0, tacks: 0 };
    anna.setPuddleClaimHandler((c): ClaimVerdict => {
      const which = tacks.has(c.puddle) ? 'tacks' : 'mud';
      const d = (which === 'tacks' ? tacks : mud).decide(c, clock.now());
      if (d.first) firsts[which] += 1;
      return d.result;
    });
    const results = new Map<string, ClaimOutcomeEvent[]>();
    for (const r of [ben, cleo]) {
      results.set(r.name, []);
      r.onClaimResult((o) => results.get(r.name)!.push(o));
    }
    return {
      clock,
      net,
      anna,
      ben,
      cleo,
      tack,
      tacks,
      mud,
      firsts,
      results,
      all: [anna, ben, cleo],
    };
  }

  it('ties: two riders over the tacks at once, exactly one gets the flat; the puddle stays', async () => {
    for (const seed of [1, 2, 3, 4]) {
      const w = await world(seed);
      w.net.setConditions({ lossRate: 0.3, duplicateRate: 0.3, maxDelayMs: 300 });
      const claim = () => ({ puddle: w.tack, raceM: 1001 });
      w.ben.claimPuddle('peer-a', claim);
      w.cleo.claimPuddle('peer-a', claim);
      await w.clock.advanceAsync(8_000);
      const outcome = [...w.results.get('Ben')!, ...w.results.get('Cleo')!].map((o) => o.result);
      expect(outcome.sort()).toEqual(['granted', 'taken']);
      expect(w.firsts).toEqual({ mud: 0, tacks: 1 });
      expect(w.mud.live(w.clock.now())).toBe(1); // the puddle lies on the road still
      for (const r of w.all) r.leave();
    }
  });

  it('lost acks: the claimer hears granted once; the dropper is never a claimer of its own', async () => {
    const w = await world();
    if (kind === 'self-hosted')
      w.net.setConditions({ lossRate: 0.5, duplicateRate: 0.2, maxDelayMs: 200 });
    w.cleo.claimPuddle('peer-a', () => ({ puddle: w.tack, raceM: 1002 }));
    await w.clock.advanceAsync(8_000);
    expect(w.results.get('Cleo')!.map((o) => o.result)).toEqual(['granted']);
    // The same rider again (a re-send under a new id): granted again, still one hit decided.
    w.cleo.claimPuddle('peer-a', () => ({ puddle: w.tack, raceM: 1003 }));
    await w.clock.advanceAsync(3_000);
    expect(w.results.get('Cleo')!.map((o) => o.result)).toEqual(['granted', 'granted']);
    expect(w.firsts.tacks).toBe(1);
    // A claim the dropper sends to itself is not for anyone (no link to itself).
    expect(w.anna.claimPuddle('peer-a', () => ({ puddle: w.tack, raceM: 1001 }))).toBeNull();
    for (const r of w.all) r.leave();
  });

  it('the dropper leaves: open claims time out once and nobody is hit', async () => {
    const w = await world();
    w.anna.leave();
    await w.clock.advanceAsync(100);
    const sent = w.ben.claimPuddle('peer-a', () => ({ puddle: w.tack, raceM: 1001 }));
    await w.clock.advanceAsync(8_000);
    expect(w.results.get('Ben')!.map((o) => o.result)).toEqual(sent === null ? [] : ['timeout']);
    expect(w.firsts.tacks).toBe(0);
    w.ben.leave();
    w.cleo.leave();
  });
});
