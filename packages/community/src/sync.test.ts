import { describe, expect, it } from 'vitest';
import {
  type PublicStanding,
  encodeStanding,
  removeContact,
  setContactVisibility,
  setFriendsOfFriends,
  standingFor,
} from './profile';
import type { CommunityState } from './state';
import { ownStanding } from './state';
import {
  DEFAULT_TOTAL_BYTES,
  KIND_CHALLENGES,
  KIND_RELAY,
  KIND_STANDING,
  MAX_DOCUMENT_BYTES,
  documentsToShare,
  mergeIncoming,
  sessionLevel,
} from './sync';
import { DAY, HOUR, T0, type World, at, id, ride, rider, session } from './testkit';
import { utf8Length } from './util';

const day1 = at(T0);
const day2 = at(T0 + DAY);
const day3 = at(T0 + 2 * DAY);

function world(...names: string[]): World {
  const w: World = {};
  names.forEach((n, i) => {
    w[n] = ride(rider(n, 100 + i), {
      id: `${n}-1`,
      start: T0 - 2 * HOUR,
      seconds: 1800 + i * 600,
      powerW: 180 + i * 20,
    });
  });
  return w;
}

const st = (w: World, n: string) => w[n] as CommunityState;
const docText = (docs: { kind: string; text: string }[], kind: string) =>
  docs.find((d) => d.kind === kind)?.text;

function relayDoc(from: string, entries: unknown[]): { kind: string; text: string } {
  return {
    kind: KIND_RELAY,
    text: JSON.stringify({ f: 'freilauf-community', v: 1, t: 'relay', from, e: entries }),
  };
}
function helloDoc(from: string, name = 'X', s?: unknown): { kind: string; text: string } {
  return {
    kind: KIND_STANDING,
    text: JSON.stringify({
      f: 'freilauf-community',
      v: 1,
      t: 'standing',
      from,
      name,
      ...(s ? { s } : {}),
    }),
  };
}

describe('session level and publishing', () => {
  it('publishes identity only until every peer is identified', () => {
    const w = world('A');
    const res = documentsToShare(st(w, 'A'), [{ riderId: null }], day1);
    expect(res.level).toBe('none');
    expect(res.documents).toHaveLength(1);
    const doc = JSON.parse(res.documents[0]?.text ?? '{}');
    expect(doc).toEqual({
      f: 'freilauf-community',
      v: 1,
      t: 'standing',
      from: id(w, 'A'),
      name: 'A',
    });
    // An empty session is treated the same (a newcomer could join any moment).
    expect(documentsToShare(st(w, 'A'), [], day1).level).toBe('none');
  });

  it('exchanges standings at the default level (totals) on first meeting', () => {
    const { world: w } = session(world('A', 'B'), ['A', 'B'], day1);
    const a = st(w, 'A');
    expect(a.contacts[id(w, 'B')]).toMatchObject({
      name: 'B',
      visibility: 'totals',
      lastSeen: day1.ms,
    });
    const b = a.standings[id(w, 'B')];
    expect(b?.via).toBeNull();
    expect(b?.standing.level).toBe('totals');
    expect(b?.standing.weeks[0]?.best).toBeUndefined();
    expect(b?.standing.weeks[0]?.rides).toBe(1);
  });

  it('publishes best efforts only when everyone present may see everything', () => {
    let w = session(world('A', 'B', 'C'), ['A', 'B', 'C'], day1).world;
    w.A = setContactVisibility(st(w, 'A'), id(w, 'B'), 'everything');
    // A + B: B may see everything.
    let r = session(w, ['A', 'B'], day2);
    expect(docText(r.published.A ?? [], KIND_STANDING)).toContain('"l":"e"');
    expect(st(r.world, 'B').standings[id(w, 'A')]?.standing.weeks[0]?.best?.p20m).toBeGreaterThan(
      0,
    );
    // A + B + C: C only totals → everyone gets totals.
    w = r.world;
    w.A = ride(st(w, 'A'), { id: 'A-2', start: T0 + DAY, seconds: 600, powerW: 300 });
    r = session(w, ['A', 'B', 'C'], day2);
    expect(docText(r.published.A ?? [], KIND_STANDING)).toContain('"l":"t"');
    const seenByC = st(r.world, 'C').standings[id(w, 'A')]?.standing;
    expect(seenByC?.level).toBe('totals');
    expect(seenByC?.weeks[0]?.best).toBeUndefined();
    // B keeps the newer revision, at totals level (the newest revision wins).
    const seenByB = st(r.world, 'B').standings[id(w, 'A')]?.standing;
    expect(seenByB?.weeks[0]?.rides).toBe(2);
  });

  it('sends nothing at all while a removed rider is present, and ignores them', () => {
    let w = session(world('A', 'B', 'C'), ['A', 'B', 'C'], day1).world;
    w.A = removeContact(st(w, 'A'), id(w, 'B'), day1.ms);
    expect(st(w, 'A').standings[id(w, 'B')]).toBeUndefined();
    const before = st(w, 'A');
    expect(sessionLevel(before, [{ riderId: id(w, 'B') }, { riderId: id(w, 'C') }])).toBe('silent');
    w.A = ride(st(w, 'A'), { id: 'A-new', start: T0 + DAY, seconds: 3600, powerW: 250 });
    const r = session(w, ['A', 'B', 'C'], day2);
    expect(r.published.A).toEqual([]);
    expect(st(r.world, 'A').standings[id(w, 'B')]).toBeUndefined();
    // B and C did not get A's new ride.
    expect(st(r.world, 'B').standings[id(w, 'A')]?.standing.weeks[0]?.rides).toBe(1);
    expect(st(r.world, 'C').standings[id(w, 'A')]?.standing.weeks[0]?.rides).toBe(1);
  });
});

describe('gossip in a friend graph A–B–C (A and C never meet)', () => {
  function setup(cAllowsFof: boolean) {
    let w = world('A', 'B', 'C');
    if (cAllowsFof) w.C = setFriendsOfFriends(st(w, 'C'), true);
    w = session(w, ['B', 'C'], day1).world;
    return session(w, ['A', 'B'], day2);
  }

  it("does not relay C's totals to A without C's consent", () => {
    const { world: w, published } = setup(false);
    expect(st(w, 'A').standings[id(w, 'C')]).toBeUndefined();
    expect(docText(published.B ?? [], KIND_RELAY)).toBeUndefined();
  });

  it("relays C's totals to A when C allows friends of friends", () => {
    const { world: w } = setup(true);
    const c = st(w, 'A').standings[id(w, 'C')];
    expect(c?.via).toBe(id(w, 'B'));
    expect(c?.standing.level).toBe('totals');
    expect(c?.standing.revision).toBe(st(w, 'C').published.revision);
    expect(c?.standing.updatedAt).toBe(st(w, 'C').published.updatedAt);
    // A does not know C: held as friend of a friend, not added as a contact.
    expect(st(w, 'A').contacts[id(w, 'C')]).toBeUndefined();
    // A does not pass C on (only direct friends of C relay).
    const w2 = { ...w, D: rider('D', 999) };
    const r2 = session(w2, ['A', 'D'], day3);
    expect(st(r2.world, 'D').standings[id(w, 'C')]).toBeUndefined();
  });

  it("lets a friend's new values reach an offline friend via a mutual friend (audience)", () => {
    // A and C met once (they are friends), then only meet B separately.
    let w = session(world('A', 'B', 'C'), ['A', 'C'], at(T0 - 3 * DAY)).world;
    w = session(w, ['B', 'C'], at(T0 - 3 * DAY)).world;
    w = session(w, ['A', 'B'], at(T0 - 3 * DAY)).world;
    const old = st(w, 'A').standings[id(w, 'C')]?.standing.revision ?? 0;
    w.C = ride(st(w, 'C'), { id: 'C-2', start: T0, seconds: 3600, powerW: 220 });
    w = session(w, ['B', 'C'], day1).world;
    w = session(w, ['A', 'B'], day2).world;
    const got = st(w, 'A').standings[id(w, 'C')];
    expect(got?.standing.revision).toBeGreaterThan(old);
    expect(got?.via).toBe(id(w, 'B'));
    expect(got?.standing.weeks[0]?.rides).toBe(2);
  });

  it('never lets a relay override a newer direct copy; equal revisions prefer direct', () => {
    const { world: w0, published } = setup(true);
    const relay = docText(published.B ?? [], KIND_RELAY) as string;
    const hello = docText(published.B ?? [], KIND_STANDING) as string;
    // A and C meet directly now (C's revision moves on).
    let w = session(w0, ['A', 'C'], day3).world;
    const direct = st(w, 'A').standings[id(w, 'C')];
    expect(direct?.via).toBeNull();
    // Replaying B's older relay changes nothing.
    const r = mergeIncoming(
      st(w, 'A'),
      {},
      [
        { kind: KIND_STANDING, text: hello },
        { kind: KIND_RELAY, text: relay },
      ],
      day3,
    );
    expect(r.state.standings[id(w, 'C')]).toEqual(direct);
    expect(r.changes.some((c) => c.type === 'standing-updated')).toBe(false);
    // Equal revision: a relayed copy does not replace a direct one, but direct replaces relayed.
    w = setup(true).world;
    const viaB = st(w, 'A').standings[id(w, 'C')];
    expect(viaB?.via).toBe(id(w, 'B'));
    const cStanding = ownStanding(st(w, 'C'), day2);
    const sameRev = mergeIncoming(
      st(w, 'A'),
      {},
      [
        helloDoc(
          id(w, 'C'),
          'C',
          encodeStanding(standingFor(cStanding, 'totals') as PublicStanding),
        ),
      ],
      day2,
    );
    expect(sameRev.state.standings[id(w, 'C')]?.via).toBeNull();
    expect(sameRev.state.standings[id(w, 'C')]?.standing.revision).toBe(viaB?.standing.revision);
  });

  it('ignores relayed entries about myself and entries the origin did not allow for me', () => {
    const { world: w } = setup(true);
    const a = st(w, 'A');
    const myStanding = encodeStanding(ownStanding(a, day2));
    const r = mergeIncoming(
      a,
      {},
      [helloDoc(id(w, 'B'), 'B'), relayDoc(id(w, 'B'), [myStanding])],
      day2,
    );
    expect(r.state.standings[a.profile.riderId]).toBeUndefined();
    // C's standing without consent for A (audience without A, no friends-of-friends).
    const c = ownStanding(setFriendsOfFriends(st(w, 'C'), false), day2);
    const strict = encodeStanding({
      ...(standingFor(c, 'totals') as PublicStanding),
      revision: c.revision + 5,
    });
    const r2 = mergeIncoming(
      a,
      {},
      [helloDoc(id(w, 'B'), 'B'), relayDoc(id(w, 'B'), [strict])],
      day2,
    );
    expect(r2.state.standings[id(w, 'C')]?.standing.revision).toBe(
      a.standings[id(w, 'C')]?.standing.revision,
    );
  });

  it('keeps removed contacts out of relays (friends-of-friends exclusion)', () => {
    let w = world('A', 'B', 'C');
    w.A = setFriendsOfFriends(st(w, 'A'), true);
    w = session(w, ['A', 'B'], day1).world;
    w = session(w, ['A', 'C'], day1).world;
    w.A = removeContact(st(w, 'A'), id(w, 'B'), day1.ms);
    w = session(w, ['A', 'C'], day2).world; // C learns A's new exclusion list
    const before = st(w, 'B').standings[id(w, 'A')]?.standing.revision;
    const r = session(w, ['B', 'C'], day3);
    expect(docText(r.published.C ?? [], KIND_RELAY) ?? '').not.toContain(id(w, 'A'));
    expect(st(r.world, 'B').standings[id(w, 'A')]?.standing.revision).toBe(before);
  });

  it('converges: everyone ends with the newest revision of everyone allowed', () => {
    let w = world('A', 'B', 'C', 'D');
    for (const n of ['A', 'B', 'C', 'D']) w[n] = setFriendsOfFriends(st(w, n), true);
    const pairs: [string, string][] = [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['A', 'B'],
      ['B', 'C'],
      ['A', 'B'],
    ];
    pairs.forEach(([x, y], i) => {
      w = session(w, [x, y], at(T0 + i * HOUR)).world;
    });
    // A got C (via B). D is two hops away: B is not D's friend, so D never reaches A.
    expect(st(w, 'A').standings[id(w, 'C')]?.standing.revision).toBe(st(w, 'C').published.revision);
    expect(st(w, 'A').standings[id(w, 'D')]).toBeUndefined();
    expect(st(w, 'B').standings[id(w, 'D')]?.via).toBe(id(w, 'C'));
  });
});

describe('budget', () => {
  it('stays within the caps with 50 friends, prioritising newest relays', () => {
    let w: World = { H: rider('Hub', 500), X: rider('X', 501) };
    for (let i = 0; i < 50; i++) {
      const n = `F${i}`;
      w[n] = setFriendsOfFriends(
        ride(rider(n, 600 + i), { id: `${n}-r`, start: T0 - DAY, seconds: 1800, powerW: 200 }),
        true,
      );
      w = session(w, ['H', n], at(T0 + i * 60_000), undefined, 2).world;
    }
    expect(Object.keys(st(w, 'H').standings)).toHaveLength(50);
    const r = session(w, ['H', 'X'], at(T0 + HOUR));
    const docs = r.published.H ?? [];
    const sizes = docs.map((d) => utf8Length(d.text));
    for (const s of sizes) expect(s).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(DEFAULT_TOTAL_BYTES);
    const relayed = JSON.parse(docText(docs, KIND_RELAY) ?? '{}').e as { id: string; u: number }[];
    expect(relayed.length).toBeGreaterThan(3);
    expect(relayed.length).toBeLessThan(50);
    const us = relayed.map((e) => e.u);
    expect([...us].sort((a, b) => b - a)).toEqual(us);
    // The newest friend (met last) is first.
    expect(relayed[0]?.id).toBe(id(w, 'F49'));
    expect(Object.keys(st(r.world, 'X').standings)).toHaveLength(relayed.length + 1);

    // A tight budget is respected, too.
    const tight = documentsToShare(st(r.world, 'H'), [{ riderId: id(w, 'X') }], at(T0 + HOUR), {
      maxTotalBytes: 4096,
    });
    expect(tight.documents.reduce((a, d) => a + utf8Length(d.text), 0)).toBeLessThanOrEqual(4096);
    expect(tight.documents[0]?.kind).toBe(KIND_STANDING);
    expect(tight.documents[0]?.text).toContain('"s":');
  });
});

describe('hostile input', () => {
  const w = session(world('A', 'B'), ['A', 'B'], day1).world;
  const a = st(w, 'A');
  const b = id(w, 'B');
  const good = encodeStanding(ownStanding(st(w, 'B'), day1));

  const garbage: { kind: string; text: string }[][] = [
    [{ kind: KIND_STANDING, text: 'not json' }],
    [{ kind: KIND_STANDING, text: '[]' }],
    [{ kind: KIND_STANDING, text: 'x'.repeat(20_000) }],
    [
      {
        kind: KIND_STANDING,
        text: JSON.stringify({ f: 'other', v: 1, t: 'standing', from: b, name: 'B' }),
      },
    ],
    [
      {
        kind: KIND_STANDING,
        text: JSON.stringify({ f: 'freilauf-community', v: 1, t: 'relay', from: b, name: 'B' }),
      },
    ],
    [
      {
        kind: KIND_STANDING,
        text: JSON.stringify({
          f: 'freilauf-community',
          v: 1,
          t: 'standing',
          from: '../../etc',
          name: 'B',
        }),
      },
    ],
    [
      {
        kind: KIND_STANDING,
        text: JSON.stringify({ f: 'freilauf-community', v: 1, t: 'standing', from: b, name: 7 }),
      },
    ],
    [helloDoc(b, 'B', { ...good, r: -1 })],
    [helloDoc(b, 'B', { ...good, u: day1.ms + DAY })],
    [helloDoc(b, 'B', { ...good, id: a.profile.riderId })],
    [helloDoc(b, 'B', { ...good, w: [['2026-W47', 1e9, 0, 0, 0, 0, 0, 0, 0]] })],
    [helloDoc(b, 'B', { ...good, __proto__: { polluted: true }, h: 'x' })],
    [
      {
        kind: KIND_STANDING,
        text:
          '{"f":"freilauf-community","v":1,"t":"standing","from":"' +
          b +
          '","name":"B","s":{"id":"' +
          b +
          '","w":[' +
          '[],'.repeat(3000) +
          '[]]}}',
      },
    ],
    [{ kind: 'workout', text: 'whatever' }],
    [],
    null as never,
    [{ kind: KIND_STANDING, text: null as never }],
  ];

  it('rejects garbage documents and leaves the state untouched', () => {
    for (const docs of garbage) {
      const r = mergeIncoming(a, { peerId: 'p' }, docs, day1);
      expect(r.state).toBe(a);
    }
  });

  it('rejects a whole relay or challenge document if one entry is bad, keeping the rest of the state', () => {
    const relayGarbage = [
      relayDoc(b, [{ ...good, h: [1e6] }]),
      relayDoc(
        b,
        Array.from({ length: 40 }, () => good),
      ),
      relayDoc('someoneElse1', [good]),
      relayDoc(b, 'nope' as never),
      {
        kind: KIND_CHALLENGES,
        text: JSON.stringify({
          f: 'freilauf-community',
          v: 1,
          t: 'challenges',
          from: b,
          c: [{ id: 'x' }],
        }),
      },
      {
        kind: KIND_CHALLENGES,
        text: JSON.stringify({
          f: 'freilauf-community',
          v: 1,
          t: 'challenges',
          from: b,
          c: Array.from({ length: 17 }, () => ({})),
        }),
      },
    ];
    const hello = docText(session(w, ['A', 'B'], day1).published.B ?? [], KIND_STANDING) as string;
    for (const doc of relayGarbage) {
      const r = mergeIncoming(a, {}, [{ kind: KIND_STANDING, text: hello }, doc], day1);
      expect(r.changes.some((c) => c.type === 'rejected')).toBe(true);
      expect(r.state.standings).toEqual(a.standings);
      expect(r.state.challenges).toEqual(a.challenges);
    }
  });

  it('ignores documents claiming to be from myself and a future format version', () => {
    const self = mergeIncoming(a, {}, [helloDoc(a.profile.riderId, 'me')], day1);
    expect(self.state).toBe(a);
    const future = mergeIncoming(
      a,
      {},
      [
        {
          kind: KIND_STANDING,
          text: JSON.stringify({ f: 'freilauf-community', v: 2, t: 'standing', from: b }),
        },
      ],
      day1,
    );
    expect(future.state).toBe(a);
    expect(future.changes[0]?.type).toBe('ignored');
  });

  it('is idempotent for repeated delivery', () => {
    const docs = session(w, ['A', 'B'], day1).published.B ?? [];
    const once = mergeIncoming(a, {}, docs, day1).state;
    const twice = mergeIncoming(once, {}, docs, day1);
    expect(twice.state.standings).toEqual(once.standings);
    expect(twice.changes.filter((c) => c.type === 'standing-updated')).toEqual([]);
  });
});
