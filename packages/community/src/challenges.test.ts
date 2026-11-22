import { describe, expect, it } from 'vitest';
import {
  type Challenge,
  type ChallengeInput,
  cancelChallenge,
  challengeProgress,
  createChallenge,
  decodeChallenge,
  encodeChallenge,
  inviteToChallenge,
  leaveChallenge,
  mergeChallenge,
  putChallenge,
  respondToChallenge,
  streakWeeks,
} from './challenges';
import { buildOwnStanding, standingFor, type PublicStanding } from './profile';
import { type CommunityState, allStandings } from './state';
import { KIND_CHALLENGES } from './sync';
import { DAY, HOUR, T0, type World, at, id, ride, rider, session } from './testkit';

// T0 = Wed 2026-11-18 12:00 CET, week 2026-W47 (Mon 16 – Sun 22 Nov).
const WEEK = '2026-W47';
const midWeek = at(T0 + DAY); // Thursday
const afterWeek = at(T0 + 6 * DAY); // Tuesday of W48

function ok(r: ReturnType<typeof createChallenge>): Challenge {
  if (!r.ok) throw new Error(r.reason);
  return r.challenge;
}

function make(
  creator: CommunityState,
  input: Omit<ChallengeInput, 'id'>,
  idSuffix = 'x',
): Challenge {
  return ok(
    createChallenge(
      { id: `chal-${input.type}-${idSuffix}`.slice(0, 32), ...input },
      { riderId: creator.profile.riderId, name: creator.profile.name },
      T0 - DAY,
    ),
  );
}

function invite(ch: Challenge, who: CommunityState): Challenge {
  const r = inviteToChallenge(
    ch,
    ch.creator,
    { riderId: who.profile.riderId, name: who.profile.name },
    T0 - DAY,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.challenge;
}

function accept(ch: Challenge, who: CommunityState, t = T0 - DAY + 1000): Challenge {
  const r = respondToChallenge(ch, who.profile.riderId, 'accepted', t);
  if (!r.ok) throw new Error(r.reason);
  return r.challenge;
}

function standings(
  now: ReturnType<typeof at>,
  ...riders: CommunityState[]
): Record<string, PublicStanding> {
  return Object.fromEntries(
    riders.map((r) => [r.profile.riderId, buildOwnStanding(r, now, 1, now.ms)]),
  );
}

describe('templates', () => {
  const a = rider('A', 1);
  const c = (input: Omit<ChallengeInput, 'id'>) =>
    createChallenge({ id: 'challenge1', ...input }, { riderId: a.profile.riderId, name: 'A' }, T0);

  it('creates every template with sensible defaults', () => {
    const cases: [Omit<ChallengeInput, 'id'>, string][] = [
      [
        { type: 'personal-goal', week: WEEK, metric: 'distanceM', target: 100_000 },
        '100 km this week',
      ],
      [
        { type: 'group-goal', week: WEEK, metric: 'distanceM', target: 500_000 },
        '500 km together this week',
      ],
      [{ type: 'duel', week: WEEK }, 'Duel: most points this week'],
      [{ type: 'streak', week: WEEK, target: 2 }, 'Streak: 2+ rides every week'],
      [{ type: 'consistency', week: WEEK, target: 4 }, 'Ride on 4 days this week'],
      [{ type: 'beat-your-best', week: WEEK, metric: 'p20m' }, 'Beat your best 20-minute power'],
      [{ type: 'ride-together', week: WEEK, target: 2 }, '2 group rides this week'],
    ];
    for (const [input, title] of cases) {
      const ch = ok(c(input));
      expect(ch.title).toBe(title);
      expect(ch.participants).toEqual([
        { riderId: a.profile.riderId, name: 'A', state: 'accepted', rev: 1, updatedAt: T0 },
      ]);
      expect(decodeChallenge(JSON.parse(JSON.stringify(encodeChallenge(ch))), T0, 0)).toEqual(ch);
    }
  });

  it('validates template parameters', () => {
    expect(c({ type: 'duel', week: WEEK, metric: 'distanceM' })).toEqual({
      ok: false,
      reason: 'invalid-metric',
    });
    expect(c({ type: 'personal-goal', week: WEEK, metric: 'points', target: 0 })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
    expect(c({ type: 'consistency', week: WEEK, target: 8 })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
    expect(c({ type: 'streak', week: '2025-W53', target: 1 })).toEqual({
      ok: false,
      reason: 'invalid-week',
    });
    expect(c({ type: 'nope' as never, week: WEEK })).toEqual({
      ok: false,
      reason: 'invalid-template',
    });
    expect(
      createChallenge(
        { id: 'bad', type: 'duel', week: WEEK },
        { riderId: a.profile.riderId, name: 'A' },
        T0,
      ),
    ).toEqual({
      ok: false,
      reason: 'invalid-id',
    });
    const t = ok(c({ type: 'duel', week: WEEK, title: '  Big‮ duel \u0007 ' }));
    expect(t.title).toBe('Big duel');
  });
});

describe('invitations', () => {
  const a = rider('A', 11);
  const b = rider('B', 12);
  const c = rider('C', 13);

  it('only the creator invites; duels take exactly one opponent', () => {
    let duel = make(a, { type: 'duel', week: WEEK });
    expect(
      inviteToChallenge(duel, b.profile.riderId, { riderId: c.profile.riderId, name: 'C' }, T0),
    ).toEqual({
      ok: false,
      reason: 'not-creator',
    });
    duel = invite(duel, b);
    expect(duel.defRev).toBe(2);
    expect(
      inviteToChallenge(duel, a.profile.riderId, { riderId: c.profile.riderId, name: 'C' }, T0),
    ).toEqual({
      ok: false,
      reason: 'full',
    });
    expect(
      inviteToChallenge(duel, a.profile.riderId, { riderId: b.profile.riderId, name: 'B' }, T0),
    ).toEqual({
      ok: false,
      reason: 'already-invited',
    });
  });

  it('follows the response state machine', () => {
    let ch = invite(make(a, { type: 'consistency', week: WEEK, target: 3 }), b);
    expect(respondToChallenge(ch, c.profile.riderId, 'accepted', T0)).toEqual({
      ok: false,
      reason: 'not-participant',
    });
    const declined = respondToChallenge(ch, b.profile.riderId, 'declined', T0);
    expect(declined.ok && declined.challenge.participants[1]).toMatchObject({
      state: 'declined',
      rev: 1,
    });
    ch = accept(ch, b);
    expect(ch.participants[1]).toMatchObject({ state: 'accepted', rev: 1 });
    expect(respondToChallenge(ch, b.profile.riderId, 'declined', T0)).toEqual({
      ok: false,
      reason: 'invalid-transition',
    });
    const left = leaveChallenge(ch, b.profile.riderId, T0);
    expect(left.ok && left.challenge.participants[1]).toMatchObject({ state: 'left', rev: 2 });
    const cancelled = cancelChallenge(ch, a.profile.riderId, T0);
    expect(cancelled.ok && cancelled.challenge.status).toBe('cancelled');
    if (cancelled.ok) {
      expect(respondToChallenge(cancelled.challenge, b.profile.riderId, 'accepted', T0)).toEqual({
        ok: false,
        reason: 'cancelled',
      });
    }
    expect(cancelChallenge(ch, b.profile.riderId, T0)).toEqual({
      ok: false,
      reason: 'not-creator',
    });
  });
});

describe('conflict rules (mergeChallenge)', () => {
  const a = rider('A', 21);
  const b = rider('B', 22);
  const c = rider('C', 23);
  const A = a.profile.riderId;
  const B = b.profile.riderId;
  const C = c.profile.riderId;
  const base = invite(
    invite(make(a, { type: 'group-goal', week: WEEK, metric: 'distanceM', target: 300_000 }), b),
    c,
  );

  it('takes unknown challenges only if they include me', () => {
    expect(mergeChallenge(undefined, base, B, A)?.challenge).toBe(base);
    expect(mergeChallenge(undefined, base, 'outsider1', A)).toBeNull();
  });

  it('higher defRev wins the definition; equal defRev prefers the creator’s copy', () => {
    const edited = { ...base, title: 'Renamed', defRev: base.defRev + 1 };
    expect(mergeChallenge(base, edited, B, C)?.challenge.title).toBe('Renamed');
    expect(mergeChallenge(edited, base, B, A)?.challenge.title).toBe('Renamed');
    const sameRev = { ...base, title: 'Forged' };
    expect(mergeChallenge(base, sameRev, B, C)?.changed).toBe(false); // not from creator
    expect(mergeChallenge(base, sameRev, B, A)?.challenge.title).toBe('Forged'); // from creator
  });

  it('each participant is authoritative for their own response', () => {
    const bAccepted = accept(base, b);
    // B's response reaches C via anyone; the higher rev wins.
    const atC = mergeChallenge(base, bAccepted, C, A)?.challenge as Challenge;
    expect(atC.participants.find((p) => p.riderId === B)?.state).toBe('accepted');
    // An older copy does not undo it.
    expect(mergeChallenge(atC, base, C, A)?.changed).toBe(false);
    // My own entry is never changed from outside, even with a higher rev.
    const forged = {
      ...base,
      participants: base.participants.map((p) =>
        p.riderId === C ? { ...p, state: 'declined' as const, rev: 9 } : p,
      ),
    };
    expect(
      mergeChallenge(atC, forged, C, B)?.challenge.participants.find((p) => p.riderId === C)?.state,
    ).toBe('invited');
  });

  it('cancellation is sticky and immutable fields cannot change', () => {
    const cancelled = cancelChallenge(base, A, T0);
    if (!cancelled.ok) throw new Error();
    const later = { ...base, defRev: cancelled.challenge.defRev + 5 };
    expect(mergeChallenge(cancelled.challenge, later, B, A)?.challenge.status).toBe('cancelled');
    expect(mergeChallenge(base, { ...base, creator: B, defRev: 50 }, C, B)?.changed).toBe(false);
    expect(mergeChallenge(base, { ...base, type: 'duel', defRev: 50 }, C, A)?.changed).toBe(false);
  });

  it('unions participants within the template cap', () => {
    const extra = Array.from({ length: 20 }, (_, i) => ({
      riderId: `rider${String(i).padStart(4, '0')}`,
      name: 'X',
      state: 'invited' as const,
      rev: 0,
      updatedAt: T0,
    }));
    const big = { ...base, participants: [...base.participants, ...extra] };
    expect(mergeChallenge(base, big, B, A)?.challenge.participants).toHaveLength(16);
  });

  it('caps stored challenges', () => {
    let s = rider('S', 24);
    for (let i = 0; i < 70; i++) {
      s = putChallenge(s, { ...base, id: `chall${String(i).padStart(4, '0')}`, updatedAt: T0 + i });
    }
    expect(Object.keys(s.challenges)).toHaveLength(64);
    expect(s.challenges.chall0000).toBeUndefined();
    expect(s.challenges.chall0069).toBeDefined();
  });
});

describe('progress per template', () => {
  it('personal goal', () => {
    let a = rider('A', 31);
    a = ride(a, { id: 'a1', start: T0 - DAY, seconds: 3600, powerW: 200 }); // 36 km
    const ch = make(a, { type: 'personal-goal', week: WEEK, metric: 'distanceM', target: 30_000 });
    const p = challengeProgress(ch, standings(midWeek, a), midWeek);
    expect(p.status).toBe('running');
    expect(p.participants[0]).toMatchObject({
      value: 36_000,
      target: 30_000,
      fraction: 1.2,
      complete: true,
      final: false,
    });
    expect(p.startsAt).toBe(Date.UTC(2026, 10, 15, 23));
    expect(p.endsAt).toBe(Date.UTC(2026, 10, 22, 23));
    expect(p.remainingMs).toBe(Date.UTC(2026, 10, 22, 23) - midWeek.ms);
    expect(challengeProgress(ch, {}, at(T0 - 3 * DAY)).status).toBe('upcoming');
    expect(challengeProgress(ch, standings(afterWeek, a), afterWeek)).toMatchObject({
      status: 'finished',
      remainingMs: 0,
    });
  });

  it('group goal sums the accepted participants', () => {
    let a = rider('A', 32);
    let b = rider('B', 33);
    const c = rider('C', 34);
    a = ride(a, { id: 'a1', start: T0 - DAY, seconds: 3600, powerW: 200 }); // 36 km
    b = ride(b, { id: 'b1', start: T0, seconds: 1800, powerW: 200 }); // 18 km
    let ch = make(a, { type: 'group-goal', week: WEEK, metric: 'distanceM', target: 50_000 });
    ch = accept(invite(invite(ch, b), c), b);
    const p = challengeProgress(ch, standings(midWeek, a, b, c), midWeek);
    expect(p.combined).toEqual({
      value: 54_000,
      target: 50_000,
      fraction: 1.08,
      complete: true,
      partial: false,
    });
    expect(p.leader).toBe(a.profile.riderId);
    expect(p.participants[2]).toMatchObject({ state: 'invited', value: null });
    // B's data unknown → partial.
    const partial = challengeProgress(ch, standings(midWeek, a), midWeek);
    expect(partial.combined).toMatchObject({ value: 36_000, complete: false, partial: true });
  });

  it('duel: leader during the week, winner or draw at the end', () => {
    let a = rider('A', 35);
    let b = rider('B', 36);
    a = ride(a, { id: 'a1', start: T0, seconds: 3600, powerW: 225, ftpW: 250 }); // 81
    b = ride(b, { id: 'b1', start: T0, seconds: 3600, powerW: 200, ftpW: 250 }); // 64
    const ch = accept(invite(make(a, { type: 'duel', week: WEEK }), b), b);
    const during = challengeProgress(ch, standings(midWeek, a, b), midWeek);
    expect(during.leader).toBe(a.profile.riderId);
    expect(during.result).toBeNull();
    // After the week, with standings produced after it ended: final.
    const end = challengeProgress(ch, standings(afterWeek, a, b), afterWeek);
    expect(end.result).toEqual({
      outcome: 'winner',
      riderId: a.profile.riderId,
      provisional: false,
    });
    // Week over, but B's last standing is from mid-week → provisional.
    const mixed = { ...standings(afterWeek, a), ...standings(midWeek, b) };
    expect(challengeProgress(ch, mixed, afterWeek).result).toMatchObject({ provisional: true });
    // Draw (same ride as A), and B overtaking with a second ride (+0.3 h at FTP = +30).
    b = ride(b, { id: 'b2', start: T0 + HOUR * 3, seconds: 1080, powerW: 250, ftpW: 250 });
    const b3 = ride(rider('B', 36), { id: 'b1', start: T0, seconds: 3600, powerW: 225, ftpW: 250 });
    const draw = challengeProgress(ch, standings(afterWeek, a, b3), afterWeek);
    expect(draw.result).toEqual({ outcome: 'draw', provisional: false });
    expect(draw.leader).toBeNull();
    expect(challengeProgress(ch, standings(afterWeek, a, b), afterWeek).result).toMatchObject({
      outcome: 'winner',
      riderId: b.profile.riderId,
    });
  });

  it('streak counts consecutive qualifying weeks, across weeks and year boundaries', () => {
    let a = rider('A', 37);
    // Two rides per week in W44, W45, W46; one so far in W47 (current week: does not break).
    for (const [w, n] of [
      [-21, 2],
      [-14, 2],
      [-7, 2],
      [0, 1],
    ] as const) {
      for (let i = 0; i < n; i++) {
        a = ride(a, {
          id: `s${w}-${i}`,
          start: T0 + w * DAY + i * DAY,
          seconds: 1800,
          powerW: 180,
        });
      }
    }
    const ch = make(a, { type: 'streak', week: '2026-W44', target: 2 });
    const p = challengeProgress(ch, standings(midWeek, a), midWeek);
    expect(p.participants[0]?.value).toBe(3);
    expect(p.endsAt).toBeNull();
    expect(p.status).toBe('running');
    // A second ride this week extends it to 4.
    const a2 = ride(a, { id: 'extra', start: T0 + DAY, seconds: 1800, powerW: 180 });
    expect(challengeProgress(ch, standings(midWeek, a2), midWeek).participants[0]?.value).toBe(4);
    // Next week without enough rides in W47 breaks it once W48 is current.
    const nextWeek = at(T0 + 7 * DAY);
    expect(challengeProgress(ch, standings(nextWeek, a), nextWeek).participants[0]?.value).toBe(0);

    // Across New Year (2026 has 53 weeks).
    let y = rider('Y', 38);
    const w52 = Date.UTC(2026, 11, 23, 12); // W52
    for (const d of [0, 7, 14])
      y = ride(y, { id: `y${d}`, start: w52 + d * DAY, seconds: 900, powerW: 150 });
    const jan = at(Date.UTC(2027, 0, 7, 12)); // 2027-W01
    const st = buildOwnStanding(y, jan, 1, jan.ms);
    expect(streakWeeks(st, '2026-W52', 1, '2027-W01')).toEqual({ weeks: 3, capped: false });
    expect(streakWeeks(st, '2026-W53', 1, '2027-W01')).toEqual({ weeks: 2, capped: false });
    expect(streakWeeks(st, '2027-W02', 1, '2027-W01')).toEqual({ weeks: 0, capped: false });
  });

  it('streak is capped at the 52-week history', () => {
    let a = rider('A', 39);
    for (let i = 0; i < 53; i++)
      a = ride(a, { id: `w${i}`, start: T0 - i * 7 * DAY, seconds: 600, powerW: 150 });
    const st = buildOwnStanding(a, midWeek, 1, midWeek.ms);
    expect(streakWeeks(st, '2025-W01', 1, WEEK)).toEqual({ weeks: 52, capped: true });
  });

  it('consistency counts distinct days', () => {
    let a = rider('A', 40);
    a = ride(a, { id: 'c1', start: T0 - 2 * DAY, seconds: 900, powerW: 150 });
    a = ride(a, { id: 'c2', start: T0 - 2 * DAY + 3 * HOUR, seconds: 900, powerW: 150 }); // same day
    a = ride(a, { id: 'c3', start: T0, seconds: 900, powerW: 150 });
    const ch = make(a, { type: 'consistency', week: WEEK, target: 3 });
    expect(challengeProgress(ch, standings(midWeek, a), midWeek).participants[0]).toMatchObject({
      value: 2,
      target: 3,
      complete: false,
    });
    a = ride(a, { id: 'c4', start: T0 + DAY, seconds: 900, powerW: 150 });
    expect(challengeProgress(ch, standings(midWeek, a), midWeek).participants[0]?.complete).toBe(
      true,
    );
  });

  it('beat your best compares with the best of the previous four weeks', () => {
    let a = rider('A', 41);
    let b = rider('B', 42);
    a = ride(a, { id: 'old', start: T0 - 14 * DAY, seconds: 1300, powerW: 220 });
    a = ride(a, { id: 'older', start: T0 - 35 * DAY, seconds: 1300, powerW: 300 }); // 5 weeks ago: ignored
    b = ride(b, { id: 'b', start: T0, seconds: 1300, powerW: 200 });
    let ch = make(a, { type: 'beat-your-best', week: WEEK, metric: 'p20m' });
    ch = accept(invite(ch, b), b);
    let st = standings(midWeek, a, b);
    let p = challengeProgress(ch, st, midWeek);
    expect(p.participants[0]).toMatchObject({ value: 0, target: 220, complete: false });
    expect(p.participants[1]).toMatchObject({ value: 200, target: 0, complete: true });
    a = ride(a, { id: 'new', start: T0, seconds: 1300, powerW: 230 });
    st = standings(midWeek, a, b);
    p = challengeProgress(ch, st, midWeek);
    expect(p.participants[0]).toMatchObject({ value: 230, target: 220, complete: true });
    // A friend who shares totals only: unknown.
    const bTotals = standingFor(
      st[b.profile.riderId] as PublicStanding,
      'totals',
    ) as PublicStanding;
    expect(
      challengeProgress(ch, { ...st, [b.profile.riderId]: bTotals }, midWeek).participants[1]
        ?.value,
    ).toBeNull();
  });

  it('ride together counts group rides', () => {
    let a = rider('A', 43);
    a = ride(a, { id: 'g1', start: T0 - DAY, seconds: 1800, powerW: 180, group: true });
    a = ride(a, { id: 's1', start: T0, seconds: 1800, powerW: 180 });
    const ch = make(a, { type: 'ride-together', week: WEEK, target: 2 });
    expect(challengeProgress(ch, standings(midWeek, a), midWeek).participants[0]).toMatchObject({
      value: 1,
      fraction: 0.5,
      complete: false,
    });
  });

  it('shows cancelled challenges as such', () => {
    const a = rider('A', 44);
    const r = cancelChallenge(make(a, { type: 'duel', week: WEEK }), a.profile.riderId, T0);
    expect(r.ok && challengeProgress(r.challenge, {}, midWeek).status).toBe('cancelled');
  });
});

describe('challenges over the gossip', () => {
  it('invitations and responses travel through mutual friends; progress is derived locally', () => {
    let w: World = {};
    for (const [n, i] of [
      ['A', 51],
      ['B', 52],
      ['C', 53],
    ] as const) {
      w[n] = rider(n, i);
    }
    // Everyone knows everyone (met before), A and C will not meet again.
    w = session(w, ['A', 'B', 'C'], at(T0 - 3 * DAY)).world;
    const A = w.A as CommunityState;
    let ch = make(A, { type: 'group-goal', week: WEEK, metric: 'distanceM', target: 100_000 }, 'g');
    ch = invite(invite(ch, w.B as CommunityState), w.C as CommunityState);
    w.A = putChallenge(A, ch);
    w.A = ride(w.A, { id: 'a', start: T0 - DAY, seconds: 3600, powerW: 200 });

    // A meets B: B receives the invitation and accepts.
    w = session(w, ['A', 'B'], at(T0 - DAY + HOUR)).world;
    const atB = (w.B as CommunityState).challenges[ch.id] as Challenge;
    expect(atB.participants.find((p) => p.riderId === id(w, 'B'))?.state).toBe('invited');
    const accepted = respondToChallenge(atB, id(w, 'B'), 'accepted', T0 - DAY + 2 * HOUR);
    if (!accepted.ok) throw new Error();
    w.B = putChallenge(w.B as CommunityState, accepted.challenge);
    w.B = ride(w.B, { id: 'b', start: T0 - DAY, seconds: 1800, powerW: 200 });

    // B meets C: C learns of the invitation (through B), accepts and rides.
    w = session(w, ['B', 'C'], at(T0)).world;
    const atC = (w.C as CommunityState).challenges[ch.id] as Challenge;
    expect(atC).toBeDefined();
    const cAcc = respondToChallenge(atC, id(w, 'C'), 'accepted', T0 + HOUR);
    if (!cAcc.ok) throw new Error();
    w.C = putChallenge(w.C as CommunityState, cAcc.challenge);
    w.C = ride(w.C, { id: 'c', start: T0 + HOUR, seconds: 3600, powerW: 200 });

    // C meets B, B meets A: A sees both acceptances and everyone's distance.
    w = session(w, ['B', 'C'], at(T0 + 3 * HOUR)).world;
    w = session(w, ['A', 'B'], at(T0 + 4 * HOUR)).world;
    const atA = (w.A as CommunityState).challenges[ch.id] as Challenge;
    expect(atA.participants.map((p) => p.state)).toEqual(['accepted', 'accepted', 'accepted']);
    const now = at(T0 + 5 * HOUR);
    const p = challengeProgress(atA, allStandings(w.A as CommunityState, now), now);
    expect(p.combined).toMatchObject({
      value: 36_000 + 18_000 + 36_000,
      complete: false,
      partial: false,
    });
  });

  it('progress is never taken from the wire', () => {
    const a = rider('A', 61);
    const ch = make(a, { type: 'personal-goal', week: WEEK, metric: 'points', target: 100 });
    const wire = { ...encodeChallenge(ch), progress: 1e9, complete: true };
    const decoded = decodeChallenge(wire, T0, 0);
    expect(decoded).not.toHaveProperty('progress');
    expect(KIND_CHALLENGES).toBe('fl-challenges');
  });
});
