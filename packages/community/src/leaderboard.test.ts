import { describe, expect, it } from 'vitest';
import { putChallenge, createChallenge, inviteToChallenge, respondToChallenge } from './challenges';
import { leaderboard } from './leaderboard';
import { renameContact, setContactVisibility, setFriendsOfFriends } from './profile';
import type { CommunityState } from './state';
import { DAY, HOUR, T0, type World, at, id, ride, rider, session } from './testkit';

const WEEK = '2026-W47';
const now = at(T0 + 4 * HOUR);

function build(): World {
  let w: World = {
    A: rider('Anna', 71),
    B: rider('Ben', 72),
    C: rider('Cleo', 73),
    D: rider('Dora', 74),
    E: rider('Emil', 75),
  };
  // Points: A 64, B 81, C 64 (tie with A), D shares nothing, E has no ride this week.
  w.A = ride(w.A as CommunityState, { id: 'a', start: T0, seconds: 3600, powerW: 200 });
  w.B = ride(w.B as CommunityState, { id: 'b', start: T0, seconds: 3600, powerW: 225 });
  w.C = ride(w.C as CommunityState, { id: 'c', start: T0, seconds: 3600, powerW: 200 });
  w.D = ride(w.D as CommunityState, { id: 'd', start: T0, seconds: 7200, powerW: 250 });
  w.E = ride(w.E as CommunityState, { id: 'e', start: T0 - 7 * DAY, seconds: 3600, powerW: 250 });
  w.D = setContactVisibility(
    session(w, ['A', 'D'], at(T0 + HOUR), undefined, 1).world.D as CommunityState,
    id(w, 'A'),
    'none',
  );
  w = session(w, ['A', 'D'], at(T0 + HOUR)).world;
  w = session(w, ['A', 'B', 'C', 'E'], at(T0 + 2 * HOUR)).world;
  return w;
}

describe('leaderboard', () => {
  it('ranks friends with ties, deltas and the you flag; non-sharers are absent', () => {
    const w = build();
    const rows = leaderboard(
      w.A as CommunityState,
      { period: WEEK, metric: 'points', scope: 'friends' },
      now,
    );
    expect(rows.map((r) => [r.rank, r.name, r.value, r.deltaToYou, r.you])).toEqual([
      [1, 'Ben', 81, 17, false],
      [2, 'Anna', 64, 0, true],
      [2, 'Cleo', 64, 0, false],
      [4, 'Emil', 0, -64, false],
    ]);
    expect(rows.find((r) => r.riderId === id(w, 'D'))).toBeUndefined();
    expect(rows.every((r) => !r.stale)).toBe(true);
    expect(rows.find((r) => r.you)?.relation).toBe('you');
    expect(rows.find((r) => r.name === 'Ben')?.relation).toBe('friend');
  });

  it('ranks other metrics, uses aliases and never ranks average speed', () => {
    const w = build();
    const a = renameContact(w.A as CommunityState, id(w, 'B'), 'Benni');
    const rows = leaderboard(a, { period: '2026-11', metric: 'distanceM', scope: 'friends' }, now);
    expect(rows.map((r) => r.name)).toEqual(['Anna', 'Benni', 'Cleo', 'Emil']);
    expect(rows.map((r) => r.value)).toEqual([36_000, 36_000, 36_000, 36_000]);
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 1, 1]);
    expect(
      leaderboard(a, { period: WEEK, metric: 'avgSpeedMps' as never, scope: 'friends' }, now),
    ).toEqual([]);
    expect(leaderboard(a, { period: 'garbage', metric: 'points', scope: 'friends' }, now)).toEqual(
      [],
    );
  });

  it('marks old standings as stale and omits periods a standing does not cover', () => {
    const w = build();
    const later = at(T0 + 3 * DAY);
    const rows = leaderboard(
      w.A as CommunityState,
      { period: WEEK, metric: 'points', scope: 'friends' },
      later,
    );
    expect(
      rows
        .filter((r) => r.stale)
        .map((r) => r.name)
        .sort(),
    ).toEqual(['Ben', 'Cleo', 'Emil']);
    // A week long before the friends' coverage: only I am listed.
    const old = leaderboard(
      w.A as CommunityState,
      { period: '2026-W30', metric: 'points', scope: 'friends' },
      now,
    );
    expect(old.map((r) => r.you)).toEqual([true]);
  });

  it('shows a challenge’s accepted participants including friends of friends', () => {
    let w = build();
    // F is a friend of B only and allows friends of friends; A sees F only via the challenge.
    w.F = setFriendsOfFriends(
      ride(rider('Fritz', 76), { id: 'f', start: T0, seconds: 3600, powerW: 250 }),
      true,
    );
    w = session(w, ['B', 'F'], at(T0 + 2 * HOUR)).world;
    w = session(w, ['A', 'B'], at(T0 + 3 * HOUR)).world;
    const friends = leaderboard(
      w.A as CommunityState,
      { period: WEEK, metric: 'points', scope: 'friends' },
      now,
    );
    expect(friends.find((r) => r.riderId === id(w, 'F'))).toBeUndefined();

    const created = createChallenge(
      { id: 'challenge-lb', type: 'duel', week: WEEK },
      { riderId: id(w, 'A'), name: 'Anna' },
      T0,
    );
    if (!created.ok) throw new Error();
    const inv = inviteToChallenge(
      created.challenge,
      id(w, 'A'),
      { riderId: id(w, 'F'), name: 'Fritz' },
      T0,
    );
    if (!inv.ok) throw new Error();
    const acc = respondToChallenge(inv.challenge, id(w, 'F'), 'accepted', T0);
    if (!acc.ok) throw new Error();
    const a = putChallenge(w.A as CommunityState, acc.challenge);
    const rows = leaderboard(a, { period: WEEK, metric: 'points', scope: 'challenge-lb' }, now);
    expect(rows.map((r) => [r.name, r.value, r.relation])).toEqual([
      ['Fritz', 100, 'friend-of-friend'],
      ['Anna', 64, 'you'],
    ]);
    expect(
      leaderboard(a, { period: WEEK, metric: 'points', scope: 'unknown-challenge' }, now),
    ).toEqual([]);
  });
});
