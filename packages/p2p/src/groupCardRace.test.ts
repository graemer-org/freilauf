/**
 * Card Race attacks over the real GroupRide on both transports (docs/adr/0007-card-race.md):
 * exactly once across loss, duplicates and reordering; every check of an incoming attack.
 */
import { describe, expect, it } from 'vitest';
import type { AttackOutcomeEvent, IncomingAttack } from './cardRace';
import { encodeAttack } from './cardRace';
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
    cards: { v: 1, offsetM: 0 },
  };
}

const payload =
  (kind = 'headwind') =>
  () => ({ kind, gapM: 40, raceM: 1000 });

describe.each(TEST_TRANSPORTS)('Card Race attacks over GroupRide (%s)', (kind) => {
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
      ids.push(anna.sendAttack('peer-b', payload(i === 1 ? 'fog' : 'headwind'))!);
      await clock.advanceAsync(2_000);
    }
    await clock.advanceAsync(8_000);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    const got = calls.get(ben)!;
    expect(got.map((a) => a.id).sort()).toEqual([...ids].sort());
    expect(got.map((a) => a.kind).sort()).toEqual(['fog', 'headwind', 'headwind']);
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
    const attacksSent = net.sentMessages().filter((m) => m.includes('"card-attack"')).length;
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
        .filter((m) => m.includes('"card-ack"'))
        .map((m) => JSON.parse(m) as { id: string; result: string });
    // 1. Meant for someone else.
    net.inject(
      anna,
      ben,
      encodeAttack({ id: 'evil0001.1', to: 'peer-c', kind: 'headwind', gapM: 5, raceM: 1 }),
    );
    // 2. Not a card message at all / malformed: dropped silently.
    net.inject(anna, ben, '{"v":1,"type":"card-attack","id":"x"}');
    net.inject(anna, ben, '{"v":1,"type":"card-attack",');
    await clock.advanceAsync(500);
    expect(calls.get(ben)).toEqual([]);
    expect(acks().find((a) => a.id === 'evil0001.1')?.result).toBe('refused');
    // 3. A genuine one, then the very same message replayed later: applied once.
    const raw = encodeAttack({
      id: 'evil0001.2',
      to: 'peer-b',
      kind: 'headwind',
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
        encodeAttack({ id: `evil0001.${i}`, to: 'peer-b', kind: 'fog', gapM: 5, raceM: 1 }),
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
