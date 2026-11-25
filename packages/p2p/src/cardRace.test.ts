import { describe, expect, it } from 'vitest';
import {
  ATTACK_INBOX_LIMITS,
  ATTACK_OUTBOX_TIMING,
  AttackInbox,
  AttackOutbox,
  attackEpoch,
  decodeCardMessage,
  encodeAck,
  encodeAttack,
  type AttackMessage,
  type AttackOutcomeEvent,
} from './cardRace';
import {
  decodeStateMessage,
  encodeStateMessage,
  raceOffsetOf,
  sanitizeRiderState,
} from './riderState';

const attack = (over: Partial<AttackMessage> = {}): AttackMessage => ({
  v: 1,
  type: 'card-attack',
  id: 'abcd1234.1',
  to: 'peer-b',
  kind: 'headwind',
  gapM: 40,
  raceM: 1200,
  ...over,
});

describe('card messages', () => {
  it('round-trip; anything malformed is dropped without throwing', () => {
    const raw = encodeAttack({
      id: 'abcd1234.7',
      to: 'peer-b',
      kind: 'fog',
      gapM: 12.34,
      raceM: 99.99,
      routeId: 'isar',
    });
    expect(decodeCardMessage(raw)).toEqual({
      v: 1,
      type: 'card-attack',
      id: 'abcd1234.7',
      to: 'peer-b',
      kind: 'fog',
      gapM: 12.3,
      raceM: 100,
      routeId: 'isar',
    });
    expect(decodeCardMessage(encodeAck('abcd1234.7', 'blocked'))).toEqual({
      v: 1,
      type: 'card-ack',
      id: 'abcd1234.7',
      result: 'blocked',
    });
    const bad: unknown[] = [
      null,
      42,
      '{',
      'x'.repeat(600),
      JSON.stringify({ ...attack(), v: 2 }),
      JSON.stringify({ ...attack(), id: 'no-dot' }),
      JSON.stringify({ ...attack(), id: 'abcd1234.0' }),
      JSON.stringify({ ...attack(), kind: 'Head wind!' }),
      JSON.stringify({ ...attack(), kind: 7 }),
      JSON.stringify({ ...attack(), gapM: Number.NaN }),
      JSON.stringify({ ...attack(), gapM: '1' }),
      JSON.stringify({ ...attack(), raceM: 1e12 }),
      JSON.stringify({ ...attack(), to: '' }),
      JSON.stringify({ ...attack(), routeId: 'Not A Route' }),
      JSON.stringify({ v: 1, type: 'card-ack', id: 'abcd1234.1', result: 'crushed' }),
      JSON.stringify({ v: 1, type: 'card-steal', id: 'abcd1234.1' }),
      JSON.stringify([attack()]),
    ];
    for (const b of bad) expect(decodeCardMessage(b)).toBeNull();
    // A rider state is not a card message (and vice versa).
    const state = encodeStateMessage({
      name: 'A',
      sentAt: 1,
      distanceM: 1,
      speedMps: 1,
      powerW: 1,
      cadenceRpm: 1,
      heartRateBpm: null,
      gear: 1,
    });
    expect(decodeCardMessage(state)).toBeNull();
    expect(decodeStateMessage(encodeAttack({ ...attack() }))).toBeNull();
  });

  it('attack ids are an epoch and a counter', () => {
    expect(attackEpoch(() => 0.5)).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe('rider state: mode and cards', () => {
  const base = {
    name: 'Ben',
    sentAt: 5,
    distanceM: 100,
    speedMps: 9,
    powerW: 200,
    cadenceRpm: 90,
    heartRateBpm: null,
    gear: 11,
  };

  it('accepts the mode in the rules and drops one it does not know', () => {
    expect(
      sanitizeRiderState({ ...base, rules: { powerUps: true, mode: 'cardRace' } })?.rules,
    ).toEqual({
      powerUps: true,
      mode: 'cardRace',
    });
    expect(sanitizeRiderState({ ...base, rules: { powerUps: true, mode: 'tag' } })?.rules).toEqual({
      powerUps: true,
    });
  });

  it('validates cards; a negative race offset only travels there', () => {
    const s = sanitizeRiderState({
      ...base,
      cards: {
        v: 1,
        offsetM: -24.5,
        attack: { kind: 'headwind', s: 7 },
        protectedS: 0,
        held: 2,
        away: false,
        extra: 1,
      },
    });
    expect(s?.cards).toEqual({
      v: 1,
      offsetM: -24.5,
      attack: { kind: 'headwind', s: 7 },
      protectedS: 0,
      held: 2,
    });
    expect(raceOffsetOf(s!)).toBe(-24.5);
    expect(raceOffsetOf({ raceOffsetM: 12 })).toBe(12);
    // The plain field stays ≥ 0 (old clients drop a packet with a negative one).
    expect(sanitizeRiderState({ ...base, raceOffsetM: -1 })).toBeNull();
    for (const cards of [
      { v: 0 },
      { v: 1.5 },
      { v: 1, offsetM: -1e6 },
      { v: 1, attack: { kind: 'headwind', s: 9999 } },
      { v: 1, attack: { kind: '', s: 1 } },
      { v: 1, shieldS: -1 },
      { v: 1, held: 99 },
      { v: 1, away: 'yes' },
      [],
    ]) {
      expect(sanitizeRiderState({ ...base, cards })).toBeNull();
    }
  });
});

describe('AttackInbox (target side)', () => {
  it('a new attack is decided once; duplicates get the same verdict back', () => {
    const inbox = new AttackInbox();
    const a = attack();
    expect(inbox.check('peer-a', a, 'peer-b', true, 0)).toEqual({ action: 'decide' });
    inbox.record('peer-a', a.id, 'hit', 0, true);
    expect(inbox.check('peer-a', a, 'peer-b', true, 50)).toEqual({
      action: 'repeat',
      result: 'hit',
    });
    expect(inbox.check('peer-a', a, 'peer-b', true, 60_000)).toEqual({
      action: 'repeat',
      result: 'hit',
    });
  });

  it('refuses attacks for someone else, from non-members, too many, and replays of forgotten ids', () => {
    const inbox = new AttackInbox();
    expect(inbox.check('peer-a', attack({ to: 'peer-c' }), 'peer-b', true, 0)).toMatchObject({
      reason: 'not-for-us',
    });
    expect(inbox.check('peer-x', attack(), 'peer-b', false, 0)).toMatchObject({
      reason: 'not-a-member',
    });
    // Rate limit: at least 1 s apart, at most 3 per 30 s.
    let t = 0;
    for (let i = 1; i <= 3; i++, t += 1_500) {
      const a = attack({ id: `abcd1234.${i}` });
      expect(inbox.check('peer-a', a, 'peer-b', true, t)).toEqual({ action: 'decide' });
      inbox.record('peer-a', a.id, 'protected', t, true);
    }
    expect(inbox.check('peer-a', attack({ id: 'abcd1234.4' }), 'peer-b', true, t)).toMatchObject({
      reason: 'rate-limited',
    });
    expect(inbox.check('peer-c', attack({ id: 'abcd1234.4' }), 'peer-b', true, t)).toEqual({
      action: 'decide',
    });
    const soon = new AttackInbox();
    soon.record('peer-a', 'abcd1234.1', 'hit', 0, true);
    expect(soon.check('peer-a', attack({ id: 'abcd1234.2' }), 'peer-b', true, 500)).toMatchObject({
      reason: 'rate-limited',
    });
    expect(
      soon.check(
        'peer-a',
        attack({ id: 'abcd1234.2' }),
        'peer-b',
        true,
        ATTACK_INBOX_LIMITS.minGapMs,
      ),
    ).toEqual({
      action: 'decide',
    });
    // Replays: ids beyond what is remembered are refused, not applied again.
    const long = new AttackInbox({ remember: 4, perWindow: 1000, minGapMs: 0 });
    for (let i = 1; i <= 10; i++) long.record('peer-a', `abcd1234.${i}`, 'hit', i, true);
    expect(long.check('peer-a', attack({ id: 'abcd1234.2' }), 'peer-b', true, 99)).toMatchObject({
      reason: 'replay',
    });
    expect(long.check('peer-a', attack({ id: 'abcd1234.9' }), 'peer-b', true, 99)).toEqual({
      action: 'repeat',
      result: 'hit',
    });
    expect(long.check('peer-a', attack({ id: 'abcd1234.11' }), 'peer-b', true, 99)).toEqual({
      action: 'decide',
    });
  });
});

describe('AttackOutbox (attacker side)', () => {
  function outbox(retry: boolean) {
    const sent: { to: string; raw: string }[] = [];
    const done: AttackOutcomeEvent[] = [];
    const box = new AttackOutbox({
      epoch: 'test0001',
      retry,
      send: (to, raw) => (sent.push({ to, raw }), true),
      done: (o) => done.push(o),
    });
    return { box, sent, done };
  }

  it('re-sends with fresh positions until acknowledged, then reports once', () => {
    const { box, sent, done } = outbox(true);
    let gapM = 40;
    const id = box.send('peer-b', () => ({ kind: 'headwind', gapM, raceM: 1000 }), 0)!;
    expect(id).toBe('test0001.1');
    gapM = 35;
    box.pump(ATTACK_OUTBOX_TIMING.retryMs);
    expect(sent).toHaveLength(2);
    expect(decodeCardMessage(sent[1]!.raw)).toMatchObject({ id, gapM: 35, kind: 'headwind' });
    // An ack from someone else does not count.
    expect(box.ack('peer-c', { v: 1, type: 'card-ack', id, result: 'hit' })).toBe(false);
    expect(box.ack('peer-b', { v: 1, type: 'card-ack', id, result: 'hit' })).toBe(true);
    expect(box.ack('peer-b', { v: 1, type: 'card-ack', id, result: 'hit' })).toBe(false);
    box.pump(10_000);
    expect(done).toEqual([{ id, to: 'peer-b', kind: 'headwind', result: 'hit' }]);
  });

  it('gives up after the timeout; a reliable channel sends once', () => {
    const { box, sent, done } = outbox(false);
    box.send('peer-b', () => ({ kind: 'fog', gapM: 10, raceM: 5 }), 0);
    box.pump(1_000);
    box.pump(2_000);
    expect(sent).toHaveLength(1);
    box.pump(ATTACK_OUTBOX_TIMING.timeoutMs);
    expect(done).toMatchObject([{ result: 'timeout' }]);
    expect(box.size).toBe(0);
  });

  it('a target that leaves ends its attacks', () => {
    const { box, done } = outbox(true);
    box.send('peer-b', () => ({ kind: 'fog', gapM: 10, raceM: 5 }), 0);
    box.removePeer('peer-b');
    expect(done).toMatchObject([{ to: 'peer-b', result: 'timeout' }]);
  });
});
