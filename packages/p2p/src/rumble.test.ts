import { describe, expect, it } from 'vitest';
import {
  ATTACK_INBOX_LIMITS,
  ATTACK_OUTBOX_TIMING,
  AttackInbox,
  AttackOutbox,
  CLAIM_INBOX_LIMITS,
  ClaimInbox,
  ClaimOutbox,
  MAX_LIVE_PUDDLES,
  PUDDLE_TIMING,
  PuddleLedger,
  PuddleWatch,
  attackEpoch,
  claimPosition,
  decodeRumbleMessage,
  encodeAck,
  encodeAttack,
  encodeClaim,
  encodeClaimAck,
  puddleGap,
  type AttackMessage,
  type AttackOutcomeEvent,
  type ClaimOutcomeEvent,
} from './rumble';
import {
  decodeStateMessage,
  encodeStateMessage,
  raceOffsetOf,
  sanitizeRiderState,
} from './riderState';

const attack = (over: Partial<AttackMessage> = {}): AttackMessage => ({
  v: 2,
  type: 'rumble-attack',
  id: 'abcd1234.1',
  to: 'peer-b',
  kind: 'bottle',
  gapM: 40,
  raceM: 1200,
  ...over,
});

describe('Rumble messages (v2)', () => {
  it('round-trip; anything malformed is dropped without throwing', () => {
    const raw = encodeAttack({
      id: 'abcd1234.7',
      to: 'peer-b',
      kind: 'hornets',
      gapM: 12.34,
      raceM: 99.99,
      routeId: 'isar',
    });
    expect(decodeRumbleMessage(raw)).toEqual({
      v: 2,
      type: 'rumble-attack',
      id: 'abcd1234.7',
      to: 'peer-b',
      kind: 'hornets',
      gapM: 12.3,
      raceM: 100,
      routeId: 'isar',
    });
    expect(decodeRumbleMessage(encodeAck('abcd1234.7', 'blocked'))).toEqual({
      v: 2,
      type: 'rumble-ack',
      id: 'abcd1234.7',
      result: 'blocked',
    });
    expect(
      decodeRumbleMessage(
        encodeClaim({ id: 'abcd1234.8', to: 'peer-a', puddle: 'zz99yy88.3', raceM: 12.34 }),
      ),
    ).toEqual({
      v: 2,
      type: 'puddle-claim',
      id: 'abcd1234.8',
      to: 'peer-a',
      puddle: 'zz99yy88.3',
      raceM: 12.3,
    });
    expect(decodeRumbleMessage(encodeClaimAck('abcd1234.8', 'taken'))).toEqual({
      v: 2,
      type: 'puddle-ack',
      id: 'abcd1234.8',
      result: 'taken',
    });
    const claim = {
      v: 2,
      type: 'puddle-claim',
      id: 'abcd1234.9',
      to: 'peer-a',
      puddle: 'zz99yy88.3',
      raceM: 5,
    };
    const bad: unknown[] = [
      null,
      42,
      '{',
      'x'.repeat(600),
      JSON.stringify({ ...attack(), v: 1 }),
      JSON.stringify({ ...attack(), v: 3 }),
      JSON.stringify({ ...attack(), id: 'no-dot' }),
      JSON.stringify({ ...attack(), id: 'abcd1234.0' }),
      JSON.stringify({ ...attack(), kind: 'Head wind!' }),
      JSON.stringify({ ...attack(), kind: 7 }),
      JSON.stringify({ ...attack(), gapM: Number.NaN }),
      JSON.stringify({ ...attack(), gapM: '1' }),
      JSON.stringify({ ...attack(), raceM: 1e12 }),
      JSON.stringify({ ...attack(), to: '' }),
      JSON.stringify({ ...attack(), routeId: 'Not A Route' }),
      JSON.stringify({ v: 2, type: 'rumble-ack', id: 'abcd1234.1', result: 'crushed' }),
      JSON.stringify({ v: 2, type: 'puddle-ack', id: 'abcd1234.1', result: 'hit' }),
      JSON.stringify({ v: 2, type: 'rumble-steal', id: 'abcd1234.1' }),
      JSON.stringify({ ...claim, puddle: 'no-dot' }),
      JSON.stringify({ ...claim, puddle: 7 }),
      JSON.stringify({ ...claim, raceM: 'far' }),
      JSON.stringify({ ...claim, to: undefined }),
      JSON.stringify({ ...claim, v: 1 }),
      JSON.stringify([attack()]),
      // The superseded format (ADR 0007) is not understood: an old app cannot attack.
      JSON.stringify({ ...attack(), v: 1, type: 'card-attack' }),
      JSON.stringify({ v: 1, type: 'card-ack', id: 'abcd1234.1', result: 'hit' }),
    ];
    for (const b of bad) expect(decodeRumbleMessage(b)).toBeNull();
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
    expect(decodeRumbleMessage(state)).toBeNull();
    expect(decodeStateMessage(encodeAttack({ ...attack() }))).toBeNull();
  });

  it('attack ids are an epoch and a counter', () => {
    expect(attackEpoch(() => 0.5)).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe('rider state: mode and items', () => {
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
      sanitizeRiderState({ ...base, rules: { powerUps: true, mode: 'rumble' } })?.rules,
    ).toEqual({
      powerUps: true,
      mode: 'rumble',
    });
    for (const mode of ['tag', 'cardRace']) {
      expect(sanitizeRiderState({ ...base, rules: { powerUps: true, mode } })?.rules).toEqual({
        powerUps: true,
      });
    }
  });

  it('validates items; a negative race offset only travels there', () => {
    const s = sanitizeRiderState({
      ...base,
      items: {
        v: 2,
        offsetM: -24.5,
        hit: { kind: 'bottle', s: 7 },
        protectedS: 0,
        held: 2,
        away: false,
        puddles: [
          { id: 'abcd1234.1', m: 1200.5, routeId: 'isar', s: 41.2 },
          { id: 'abcd1234.2', m: 900, s: 0, used: true, extra: 1 },
        ],
        extra: 1,
      },
    });
    expect(s?.items).toEqual({
      v: 2,
      offsetM: -24.5,
      hit: { kind: 'bottle', s: 7 },
      protectedS: 0,
      held: 2,
      puddles: [
        { id: 'abcd1234.1', m: 1200.5, routeId: 'isar', s: 41.2 },
        { id: 'abcd1234.2', m: 900, s: 0, used: true },
      ],
    });
    expect(raceOffsetOf(s!)).toBe(-24.5);
    expect(raceOffsetOf({ raceOffsetM: 12 })).toBe(12);
    // The plain field stays ≥ 0 (old clients drop a packet with a negative one).
    expect(sanitizeRiderState({ ...base, raceOffsetM: -1 })).toBeNull();
    const puddle = { id: 'abcd1234.1', m: 10, s: 5 };
    for (const items of [
      { v: 0 },
      { v: 1 },
      { v: 2.5 },
      { v: 2, offsetM: -1e6 },
      { v: 2, hit: { kind: 'bottle', s: 9999 } },
      { v: 2, hit: { kind: '', s: 1 } },
      { v: 2, capeS: -1 },
      { v: 2, held: 99 },
      { v: 2, away: 'yes' },
      { v: 2, puddles: {} },
      {
        v: 2,
        puddles: [
          puddle,
          { ...puddle, id: 'abcd1234.2' },
          { ...puddle, id: 'abcd1234.3' },
          { ...puddle, id: 'abcd1234.4' },
          { ...puddle, id: 'abcd1234.5' },
        ],
      },
      { v: 2, puddles: [puddle, puddle] },
      { v: 2, puddles: [{ ...puddle, id: 'x' }] },
      { v: 2, puddles: [{ ...puddle, m: Number.NaN }] },
      { v: 2, puddles: [{ ...puddle, s: 700 }] },
      { v: 2, puddles: [{ ...puddle, routeId: 'Not A Route' }] },
      { v: 2, puddles: [{ ...puddle, used: 'yes' }] },
      [],
    ]) {
      expect(sanitizeRiderState({ ...base, items })).toBeNull();
    }
  });

  it('an app of the superseded format (cards, v1) reads as one without Freilauf Rumble', () => {
    const old = sanitizeRiderState({
      ...base,
      cards: { v: 1, offsetM: -30, attack: { kind: 'headwind', s: 4 } },
      rules: { powerUps: true, mode: 'cardRace' },
    });
    expect(old).not.toBeNull();
    expect(old!.items).toBeUndefined();
    expect('cards' in old!).toBe(false);
    expect(old!.rules).toEqual({ powerUps: true });
    // Placed by its plain race offset only (never the old signed one).
    expect(raceOffsetOf(old!)).toBe(0);
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
    const id = box.send('peer-b', () => ({ kind: 'bottle', gapM, raceM: 1000 }), 0)!;
    expect(id).toBe('test0001.1');
    gapM = 35;
    box.pump(ATTACK_OUTBOX_TIMING.retryMs);
    expect(sent).toHaveLength(2);
    expect(decodeRumbleMessage(sent[1]!.raw)).toMatchObject({ id, gapM: 35, kind: 'bottle' });
    // An ack from someone else does not count.
    expect(box.ack('peer-c', { id, result: 'hit' })).toBe(false);
    expect(box.ack('peer-b', { id, result: 'hit' })).toBe(true);
    expect(box.ack('peer-b', { id, result: 'hit' })).toBe(false);
    box.pump(10_000);
    expect(done).toEqual([{ id, to: 'peer-b', kind: 'bottle', result: 'hit' }]);
  });

  it('gives up after the timeout; a reliable channel sends once', () => {
    const { box, sent, done } = outbox(false);
    box.send('peer-b', () => ({ kind: 'hornets', gapM: 10, raceM: 5 }), 0);
    box.pump(1_000);
    box.pump(2_000);
    expect(sent).toHaveLength(1);
    box.pump(ATTACK_OUTBOX_TIMING.timeoutMs);
    expect(done).toMatchObject([{ result: 'timeout' }]);
    expect(box.size).toBe(0);
  });

  it('a target that leaves ends its attacks', () => {
    const { box, done } = outbox(true);
    box.send('peer-b', () => ({ kind: 'hornets', gapM: 10, raceM: 5 }), 0);
    box.removePeer('peer-b');
    expect(done).toMatchObject([{ to: 'peer-b', result: 'timeout' }]);
  });
});

describe('puddle claims: inbox and outbox', () => {
  it('claims are deduplicated and rate-limited per sender like attacks', () => {
    const inbox = new ClaimInbox();
    const c = { id: 'cccc0001.1', to: 'peer-a' };
    expect(inbox.check('peer-c', c, 'peer-a', true, 0)).toEqual({ action: 'decide' });
    inbox.record('peer-c', c.id, 'granted', 0, true);
    // A duplicate (a lost ack, a re-send) gets the same verdict, without a second decision.
    expect(inbox.check('peer-c', c, 'peer-a', true, 400)).toEqual({
      action: 'repeat',
      result: 'granted',
    });
    expect(
      inbox.check('peer-c', { ...c, id: 'cccc0001.2', to: 'peer-b' }, 'peer-a', true, 0),
    ).toMatchObject({ reason: 'not-for-us' });
    expect(inbox.check('peer-x', { ...c, id: 'cccc0001.3' }, 'peer-a', false, 0)).toMatchObject({
      reason: 'not-a-member',
    });
    for (let i = 2; i <= CLAIM_INBOX_LIMITS.perWindow; i++) {
      expect(inbox.check('peer-c', { ...c, id: `cccc0001.${i}` }, 'peer-a', true, i)).toEqual({
        action: 'decide',
      });
      inbox.record('peer-c', `cccc0001.${i}`, 'gone', i, true);
    }
    expect(inbox.check('peer-c', { ...c, id: 'cccc0001.99' }, 'peer-a', true, 10)).toMatchObject({
      reason: 'rate-limited',
    });
  });

  it('the claim outbox re-sends with the claimer’s latest position and reports once', () => {
    const sent: string[] = [];
    const done: ClaimOutcomeEvent[] = [];
    const box = new ClaimOutbox({
      epoch: 'test0002',
      retry: true,
      send: (_to, raw) => (sent.push(raw), true),
      done: (o) => done.push(o),
    });
    let raceM = 100;
    const id = box.send('peer-a', () => ({ puddle: 'pppp0001.1', raceM }), 0)!;
    raceM = 104;
    box.pump(ATTACK_OUTBOX_TIMING.retryMs);
    expect(sent.map((r) => decodeRumbleMessage(r))).toMatchObject([
      { type: 'puddle-claim', id, puddle: 'pppp0001.1', raceM: 100 },
      { type: 'puddle-claim', id, puddle: 'pppp0001.1', raceM: 104 },
    ]);
    expect(box.ack('peer-a', { id, result: 'granted' })).toBe(true);
    expect(box.ack('peer-a', { id, result: 'granted' })).toBe(false);
    box.send('peer-a', () => ({ puddle: 'pppp0001.2', raceM }), 1_000);
    box.pump(1_000 + ATTACK_OUTBOX_TIMING.timeoutMs);
    expect(done).toEqual([
      { id, to: 'peer-a', puddle: 'pppp0001.1', result: 'granted' },
      { id: 'test0002.2', to: 'peer-a', puddle: 'pppp0001.2', result: 'timeout' },
    ]);
  });
});

describe('PuddleLedger (the dropper decides its own puddle)', () => {
  it('placement, broadcast, and drying up after 60 s', () => {
    const book = new PuddleLedger('drop0001');
    const id = book.drop({ m: 500, routeId: 'isar' }, 0)!;
    expect(id).toBe('drop0001.1');
    expect(book.wire(0)).toEqual([{ id, m: 500, routeId: 'isar', s: 60 }]);
    expect(book.wire(30_000)).toEqual([{ id, m: 500, routeId: 'isar', s: 30 }]);
    expect(book.wire(PUDDLE_TIMING.lifeMs)).toEqual([]);
    expect(book.live(PUDDLE_TIMING.lifeMs)).toBe(0);
    // A claim for a dried-up or unknown puddle: gone.
    const late = PUDDLE_TIMING.lifeMs + PUDDLE_TIMING.graceMs;
    expect(
      book.decide({ from: 'peer-c', puddle: id, raceM: 500, routeId: 'isar' }, late).result,
    ).toBe('gone');
    expect(
      book.decide({ from: 'peer-c', puddle: 'drop0001.9', raceM: 500, routeId: 'isar' }, 0).result,
    ).toBe('gone');
  });

  it('two riders claim at once: the first is hit, the second gets taken; repeats stay granted', () => {
    const book = new PuddleLedger('drop0002');
    const id = book.drop({ m: 500 }, 0)!;
    expect(book.decide({ from: 'peer-c', puddle: id, raceM: 501 }, 1_000)).toEqual({
      result: 'granted',
      first: true,
    });
    expect(book.decide({ from: 'peer-b', puddle: id, raceM: 500 }, 1_001)).toEqual({
      result: 'taken',
      first: false,
    });
    // The same claimer again (its re-send under a new id after a lost ack): still granted, not again first.
    expect(book.decide({ from: 'peer-c', puddle: id, raceM: 530 }, 1_400)).toEqual({
      result: 'granted',
      first: false,
    });
    expect(book.hitBy(id)).toBe('peer-c');
    // Used: broadcast as used for a moment, then gone; it never hits anyone else.
    expect(book.wire(1_500)).toEqual([{ id, m: 500, s: 0, used: true }]);
    expect(book.wire(1_000 + PUDDLE_TIMING.keepUsedMs + 1)).toEqual([]);
    expect(book.decide({ from: 'peer-b', puddle: id, raceM: 500 }, 9_000).result).toBe('gone');
  });

  it('refuses implausible claims without using the puddle up; caps the puddles on the road', () => {
    const book = new PuddleLedger('drop0003');
    const id = book.drop({ m: 500, routeId: 'loop' }, 0)!;
    expect(book.decide({ from: 'peer-c', puddle: id, raceM: 400, routeId: 'loop' }, 0).result).toBe(
      'refused',
    );
    expect(book.decide({ from: 'peer-c', puddle: id, raceM: 800, routeId: 'loop' }, 0).result).toBe(
      'refused',
    );
    expect(book.decide({ from: 'peer-c', puddle: id, raceM: 500 }, 0).result).toBe('refused');
    expect(
      book.decide({ from: 'peer-c', puddle: id, raceM: 500, routeId: 'other' }, 0).result,
    ).toBe('refused');
    // Round the loop: 5 m past the start line counts as just past a puddle 10 m before it.
    const near = book.drop({ m: 990, routeId: 'loop' }, 0)!;
    expect(
      book.decide({ from: 'peer-b', puddle: near, raceM: 5, routeId: 'loop' }, 0, {
        lengthM: 1000,
        loop: true,
      }).result,
    ).toBe('granted');
    expect(book.decide({ from: 'peer-c', puddle: id, raceM: 505, routeId: 'loop' }, 0).result).toBe(
      'granted',
    );
    for (let i = 0; i < MAX_LIVE_PUDDLES; i++) expect(book.drop({ m: 10 * i }, 100)).not.toBeNull();
    expect(book.drop({ m: 99 }, 100)).toBeNull();
  });
});

describe('PuddleWatch (each rider checks for themselves)', () => {
  const me = (raceM: number) => ({ raceM, route: null });
  const rider = (puddles: { id: string; m: number; s: number; used?: true }[]) => ({
    peerId: 'peer-a',
    name: 'Anna',
    items: { v: 2, puddles },
  });

  it('reports a crossing once, from ahead to reached; never a puddle first seen behind, used or dry', () => {
    const w = new PuddleWatch();
    const anna = rider([{ id: 'drop0001.1', m: 100, s: 50 }]);
    expect(w.update([anna], me(90)).crossed).toEqual([]);
    expect(w.update([anna], me(97)).near[0]!.gapM).toBe(3);
    expect(w.update([anna], me(101)).crossed.map((c) => c.puddle.id)).toEqual(['drop0001.1']);
    expect(w.update([anna], me(104)).crossed).toEqual([]);
    const behind = new PuddleWatch();
    expect(behind.update([anna], me(110)).crossed).toEqual([]);
    expect(behind.update([anna], me(120)).crossed).toEqual([]);
    // A jump over it (more than a step) is no crossing.
    const jump = new PuddleWatch();
    jump.update([anna], me(0));
    expect(jump.update([anna], me(400)).crossed).toEqual([]);
    for (const p of [
      { id: 'drop0001.1', m: 100, s: 0 },
      { id: 'drop0001.1', m: 100, s: 9, used: true as const },
    ]) {
      const used = new PuddleWatch();
      used.update([rider([p])], me(95));
      expect(used.update([rider([p])], me(105)).crossed).toEqual([]);
    }
    // The rider's own puddles: never.
    const self = new PuddleWatch();
    self.update([anna], me(95), 'peer-a');
    expect(self.update([anna], me(105), 'peer-a').crossed).toEqual([]);
  });

  it('measures along a shared route (round a loop) and ignores puddles on other roads', () => {
    const route = { id: 'loop', m: 995, lengthM: 1000, loop: true };
    expect(puddleGap({ m: 5, routeId: 'loop' }, { raceM: 0, route })).toBe(10);
    expect(puddleGap({ m: 5, routeId: 'other' }, { raceM: 0, route })).toBeNull();
    expect(puddleGap({ m: 50 }, { raceM: 40, route })).toBe(10);
    expect(claimPosition({ m: 5, routeId: 'loop' }, { raceM: 3, route })).toBe(995);
    expect(claimPosition({ m: 5 }, { raceM: 3, route })).toBe(3);
  });
});
