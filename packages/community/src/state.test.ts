import { describe, expect, it } from 'vitest';
import { putChallenge, createChallenge } from './challenges';
import { buildOwnStanding, meetContact, removeContact, setFriendsOfFriends } from './profile';
import {
  MAX_CACHED_STANDINGS,
  SCHEMA_VERSION,
  type CommunityState,
  addRide,
  emptyState,
  estimateStateBytes,
  evictStandings,
  migrate,
  removeRide,
} from './state';
import { DAY, T0, at, facts, id, ride, rider, session } from './testkit';
import { ledgerTotals } from './totals';
import { seededRandom } from './util';

function populated(): CommunityState {
  let w = { A: rider('A', 81), B: rider('B', 82), C: rider('C', 83) };
  w.A = ride(w.A, { id: 'a1', start: T0, seconds: 3600, powerW: 200 });
  w.B = ride(w.B, { id: 'b1', start: T0, seconds: 3600, powerW: 200 });
  w = session(w, ['A', 'B', 'C'], at(T0 + 3_600_000)).world as typeof w;
  let a = setFriendsOfFriends(w.A, true);
  a = removeContact(a, id(w, 'C'), T0);
  const ch = createChallenge(
    { id: 'challenge-st', type: 'duel', week: '2026-W47' },
    { riderId: a.profile.riderId, name: 'A' },
    T0,
  );
  if (ch.ok) a = putChallenge(a, ch.challenge);
  return a;
}

describe('state', () => {
  it('starts empty and versioned', () => {
    const s = emptyState('riderAAAAAAA', 'Anna', 5);
    expect(s).toMatchObject({
      schema: SCHEMA_VERSION,
      profile: {
        riderId: 'riderAAAAAAA',
        name: 'Anna',
        friendsOfFriends: false,
        defaultVisibility: 'totals',
      },
    });
    expect(estimateStateBytes(s)).toBe(JSON.stringify(s).length);
  });

  it('adds and removes own rides incrementally', () => {
    let s = emptyState('riderAAAAAAA', 'Anna', 5);
    s = addRide(s, facts({ id: 'r', start: T0, seconds: 3600, powerW: 200 }));
    expect(ledgerTotals(s.ledger, '2026-W47').points).toBe(64);
    s = removeRide(s, 'r');
    expect(ledgerTotals(s.ledger, '2026-W47').rides).toBe(0);
    expect(removeRide(s, 'r')).toBe(s);
  });

  it('round-trips through JSON via migrate', () => {
    const a = populated();
    const back = migrate(JSON.parse(JSON.stringify(a)), seededRandom(1), T0);
    expect(back).toEqual(a);
    expect(migrate(JSON.stringify(a), seededRandom(1), T0)).toEqual(a);
  });

  it('returns a fresh state for unusable input, never throwing', () => {
    for (const raw of [
      undefined,
      null,
      42,
      'not json',
      '[]',
      [],
      { schema: 1 },
      { profile: 'x' },
    ]) {
      const s = migrate(raw, seededRandom(7), T0);
      expect(s.schema).toBe(SCHEMA_VERSION);
      expect(s.profile.riderId).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(Object.keys(s.ledger.rides)).toHaveLength(0);
    }
    const throwing = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom');
        },
        ownKeys: () => {
          throw new Error('boom');
        },
      },
    );
    expect(migrate(throwing, seededRandom(7), T0).schema).toBe(SCHEMA_VERSION);
  });

  it('repairs partially corrupt state item by item', () => {
    const a = populated();
    const j = JSON.parse(JSON.stringify(a));
    const bId = Object.keys(a.contacts).find((k) => !a.contacts[k]?.blocked) as string;
    j.ledger.rides.bogus = { rideId: 'bogus', points: 1e9 };
    j.ledger.rides.a1.points = 'lots'; // corrupt own ride → dropped
    j.ledger.periods = { '2026-W47': { rides: 999 } }; // derived data → rebuilt
    j.contacts.notAnId = { riderId: 'notAnId!' };
    j.contacts[bId].visibility = 'sometimes';
    j.standings.ghostghost = { standing: { id: 'x' }, via: null, receivedAt: 1 };
    j.standings[bId].standing.weeks[0].distanceM = -5;
    j.challenges['challenge-st'].participants = 'nope';
    j.published.revision = -1;
    const s = migrate(j, seededRandom(1), T0);
    expect(s.profile).toEqual(a.profile);
    expect(Object.keys(s.ledger.rides)).toEqual([]);
    expect(s.ledger.periods).toEqual({});
    expect(s.contacts[bId]?.visibility).toBe('none'); // unknown visibility → most private
    expect(s.contacts.notAnId).toBeUndefined();
    expect(s.standings).toEqual({});
    expect(s.challenges).toEqual({});
    expect(s.published).toEqual({ revision: 0, updatedAt: 0, digest: '' });
  });

  it('drops cached data about blocked riders and about myself', () => {
    const a = populated();
    const j = JSON.parse(JSON.stringify(a));
    const blocked = Object.keys(a.contacts).find((k) => a.contacts[k]?.blocked) as string;
    j.standings[blocked] = {
      standing: buildOwnStanding(rider('C', 83), at(T0), 1, T0),
      via: null,
      receivedAt: 1,
    };
    j.standings[a.profile.riderId] = j.standings[blocked];
    const s = migrate(j, seededRandom(1), T0);
    expect(s.standings[blocked]).toBeUndefined();
    expect(s.standings[a.profile.riderId]).toBeUndefined();
  });

  it('evicts cached standings: friends of friends first, then oldest', () => {
    let s = rider('Hub', 90);
    const standings: CommunityState['standings'] = {};
    for (let i = 0; i < MAX_CACHED_STANDINGS + 10; i++) {
      const other = rider(`R${i}`, 1000 + i);
      const rid = other.profile.riderId;
      if (i < 20) s = meetContact(s, rid, `R${i}`, i);
      standings[rid] = {
        standing: buildOwnStanding(other, at(T0), 1, T0),
        via: i < 20 ? null : 'someRelay1',
        receivedAt: T0 + i * DAY,
      };
    }
    const kept = evictStandings(standings, s.contacts);
    expect(Object.keys(kept)).toHaveLength(MAX_CACHED_STANDINGS);
    // All 20 contacts survive although they are the oldest; the 10 oldest others are gone.
    for (const c of Object.keys(s.contacts)) expect(kept[c]).toBeDefined();
    const dropped = Object.keys(standings).filter((k) => !kept[k]);
    expect(
      dropped.map((k) => standings[k]?.receivedAt).sort((x, y) => (x ?? 0) - (y ?? 0)),
    ).toEqual(Array.from({ length: 10 }, (_, i) => T0 + (20 + i) * DAY));
  });
});
