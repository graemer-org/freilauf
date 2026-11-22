import { describe, expect, it } from 'vitest';
import {
  MAX_RELAY_LIST,
  buildOwnStanding,
  decodeStanding,
  displayName,
  encodeStanding,
  meetContact,
  newRiderId,
  relayAllowedTo,
  relayPolicy,
  removeContact,
  renameContact,
  setContactVisibility,
  setDisplayName,
  setFriendsOfFriends,
  standingFor,
  standingPeriod,
  unblockContact,
  visibilityFor,
} from './profile';
import { DAY, T0, at, ride, rider } from './testkit';
import { seededRandom } from './util';

const now = at(T0 + 2 * DAY); // Friday of 2026-W47

function withRides() {
  let s = rider('Anna', 1);
  s = ride(s, { id: 'a', start: T0, seconds: 3600, powerW: 200 });
  s = ride(s, { id: 'b', start: T0 - 7 * DAY, seconds: 1800, powerW: 250 });
  s = ride(s, { id: 'c', start: T0 - 40 * DAY, seconds: 1800, powerW: 250 });
  return s;
}

describe('rider id and profile', () => {
  it('derives a stable id from the supplied randomness', () => {
    const a = newRiderId(seededRandom(5));
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newRiderId(seededRandom(5))).toBe(a);
    expect(newRiderId(seededRandom(6))).not.toBe(a);
  });

  it('sanitises display names', () => {
    let s = rider('  Anna‮\u0000  Bike  ');
    expect(s.profile.name).toBe('Anna Bike');
    s = setDisplayName(s, 'x'.repeat(100));
    expect(Array.from(s.profile.name)).toHaveLength(32);
    expect(setDisplayName(s, '​​')).toBe(s);
  });
});

describe('contacts', () => {
  it('adds on first meeting with the default visibility and tracks last seen', () => {
    let s = rider('Anna');
    const b = newRiderId(seededRandom(99));
    s = meetContact(s, b, 'Ben', 1000);
    expect(s.contacts[b]).toMatchObject({
      name: 'Ben',
      visibility: 'totals',
      firstSeen: 1000,
      lastSeen: 1000,
    });
    s = meetContact(s, b, 'Benjamin', 5000);
    expect(s.contacts[b]).toMatchObject({ name: 'Benjamin', firstSeen: 1000, lastSeen: 5000 });
    s = renameContact(s, b, 'Benni');
    expect(displayName(s, b)).toBe('Benni');
    s = setContactVisibility(s, b, 'everything');
    expect(visibilityFor(s, b)).toBe('everything');
    expect(meetContact(s, s.profile.riderId, 'me', 1)).toBe(s);
    expect(meetContact(s, 'bad id!', 'x', 1)).toBe(s);
  });

  it('removing blocks, deletes cached data and survives the next meeting', () => {
    let s = rider('Anna');
    const b = newRiderId(seededRandom(98));
    s = meetContact(s, b, 'Ben', 1000);
    s = {
      ...s,
      standings: {
        [b]: { standing: buildOwnStanding(rider('Ben'), now, 1, now.ms), via: null, receivedAt: 1 },
      },
    };
    s = removeContact(s, b, 2000);
    expect(s.standings[b]).toBeUndefined();
    expect(s.contacts[b]?.blocked).toBe(true);
    expect(visibilityFor(s, b)).toBe('none');
    expect(meetContact(s, b, 'Ben', 3000)).toBe(s);
    expect(setContactVisibility(s, b, 'everything')).toBe(s);
    s = unblockContact(s, b);
    expect(s.contacts[b]).toBeUndefined();
  });
});

describe('standings and visibility', () => {
  it('builds the own standing from the ledger', () => {
    const st = buildOwnStanding(withRides(), now, 3, now.ms);
    expect(st).toMatchObject({
      revision: 3,
      level: 'everything',
      asOfWeek: '2026-W47',
      asOfMonth: '2026-11',
    });
    expect(st.weeks.map((w) => w.key)).toEqual(['2026-W47', '2026-W46', '2026-W41']);
    expect(st.months.map((m) => m.key)).toEqual(['2026-11', '2026-10']);
    expect(st.weeks[0]).toMatchObject({ rides: 1, points: 64, best: { p20m: 200 } });
    expect(st.weeklyRides).toEqual([1, 1, 0, 0, 0, 0, 1]);
  });

  it('redacts per level', () => {
    const full = buildOwnStanding(withRides(), now, 1, now.ms);
    expect(standingFor(full, 'none')).toBeNull();
    const totals = standingFor(full, 'totals');
    expect(totals?.level).toBe('totals');
    expect(totals?.weeks.every((w) => w.best === undefined)).toBe(true);
    expect(totals?.months.every((m) => m.best === undefined)).toBe(true);
    expect(totals?.weeks[0]?.points).toBe(64);
    expect(JSON.stringify(encodeStanding(totals as never))).not.toContain('"e"');
    expect(standingFor(full, 'everything')).toBe(full);
    // Never adds detail back.
    expect(standingFor(totals as never, 'everything')?.weeks[0]?.best).toBeUndefined();
  });

  it('round-trips the wire format at both levels', () => {
    const full = buildOwnStanding(withRides(), now, 7, now.ms);
    expect(decodeStanding(JSON.parse(JSON.stringify(encodeStanding(full))), now.ms)).toEqual(full);
    const totals = standingFor(full, 'totals');
    expect(decodeStanding(encodeStanding(totals as never), now.ms)).toEqual(totals);
  });

  it('rejects implausible standings', () => {
    const wire = encodeStanding(buildOwnStanding(withRides(), now, 7, now.ms));
    const row = (wire.w as unknown[][])[0] as unknown[];
    const bad: Record<string, unknown>[] = [
      { ...wire, u: now.ms + 3_600_000 }, // future beyond tolerance
      { ...wire, u: 1000 }, // before 2020
      { ...wire, r: 0 },
      { ...wire, r: 1.5 },
      { ...wire, id: 'no' },
      { ...wire, aw: '2026-W40' }, // as-of week does not match timestamp
      { ...wire, w: [[...row.slice(0, 2), 8 * 86_400, ...row.slice(3)]] }, // > 24 h per riding day
      { ...wire, w: [[row[0], 1, 3600, 2_100_000, ...row.slice(4)]] }, // > 2000 km / week
      { ...wire, w: [[row[0], 1, 3600, 1000, 0, 0, 9999, 0, 1, null, null, null, null]] }, // points
      { ...wire, w: [['2026-W30', ...row.slice(1)]] }, // outside covered weeks
      { ...wire, w: [row, row] }, // duplicate
      { ...wire, w: Array.from({ length: 9 }, () => row) },
      { ...wire, h: [5] }, // history disagrees with rows
      { ...wire, h: Array.from({ length: 60 }, () => 0) },
      {
        ...wire,
        au: Array.from(
          { length: MAX_RELAY_LIST + 1 },
          (_, i) => `rider${String(i).padStart(4, '0')}`,
        ),
      },
      { ...wire, ff: 0, ex: ['abcdefgh'] },
      { ...wire, l: 'x' },
      { ...wire, n: 'x'.repeat(500) },
      { ...wire, w: [[row[0], Number.NaN, ...row.slice(2)]] },
      { ...wire, w: [[...row.slice(0, 9)]] }, // level e needs best efforts
    ];
    for (const b of bad) expect(decodeStanding(b, now.ms)).toBeNull();
    expect(decodeStanding('x', now.ms)).toBeNull();
    expect(decodeStanding(null, now.ms)).toBeNull();
  });

  it('answers period queries: covered, zero, not covered, future', () => {
    const st = buildOwnStanding(withRides(), now, 1, now.ms);
    expect(standingPeriod(st, '2026-W47')).toMatchObject({ totals: { rides: 1 }, complete: false });
    expect(standingPeriod(st, '2026-W46')).toMatchObject({ totals: { rides: 1 }, complete: true });
    expect(standingPeriod(st, '2026-W45')).toMatchObject({ totals: { rides: 0 }, complete: true });
    expect(standingPeriod(st, '2026-W48')).toMatchObject({ totals: { rides: 0 }, complete: false });
    expect(standingPeriod(st, '2026-W30')).toBeNull();
    expect(standingPeriod(st, '2026-04')).toBeNull();
  });
});

describe('relay policy', () => {
  it('lists the audience and, with friends-of-friends, the excluded riders', () => {
    let s = rider('Anna');
    const ids = [1, 2, 3].map((i) => newRiderId(seededRandom(200 + i)));
    const [b, c, d] = ids as [string, string, string];
    s = meetContact(s, b, 'B', 1);
    s = meetContact(s, c, 'C', 2);
    s = meetContact(s, d, 'D', 3);
    s = setContactVisibility(s, c, 'none');
    s = removeContact(s, d, 4);
    expect(relayPolicy(s)).toEqual({ friendsOfFriends: false, audience: [b], exclude: [] });
    s = setFriendsOfFriends(s, true);
    const p = relayPolicy(s);
    expect(p.friendsOfFriends).toBe(true);
    expect(p.exclude.sort()).toEqual([c, d].sort());
    const st = { ...buildOwnStanding(s, now, 1, now.ms), relay: p };
    expect(relayAllowedTo(st, b)).toBe(true);
    expect(relayAllowedTo(st, c)).toBe(false);
    expect(relayAllowedTo(st, d)).toBe(false);
    expect(relayAllowedTo(st, newRiderId(seededRandom(777)))).toBe(true); // a friend of a friend
    expect(relayAllowedTo(st, s.profile.riderId)).toBe(false);
  });

  it('falls back to audience-only when the exclusion list would not fit', () => {
    let s = setFriendsOfFriends(rider('Anna'), true);
    for (let i = 0; i < MAX_RELAY_LIST + 1; i++) {
      const id = newRiderId(seededRandom(1000 + i));
      s = meetContact(s, id, `R${i}`, i);
      s = setContactVisibility(s, id, 'none');
    }
    expect(relayPolicy(s)).toEqual({ friendsOfFriends: false, audience: [], exclude: [] });
  });
});
