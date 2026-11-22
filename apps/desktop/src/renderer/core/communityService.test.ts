import { CHALLENGE_TYPES, KIND_STANDING } from '@freilauf/community';
import type { RideListItem } from '../../shared/contract';
import type { RecordedRide } from '@freilauf/session';
import { describe, expect, it, vi } from 'vitest';
import {
  CHALLENGE_TEMPLATES,
  COMMUNITY_CORRUPT_KEY,
  COMMUNITY_META_KEY,
  COMMUNITY_STORAGE_KEY,
  CommunityService,
} from './communityService';
import type { CommunityServiceOptions, CreateChallengeInput } from './communityService';
import {
  CET,
  DAY,
  FakeHub,
  HOUR,
  T0,
  memoryStorage,
  syntheticRide,
} from './testing/communityFixtures';

function clock(start = T0) {
  let now = start;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    },
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (h: unknown) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
  };
}

let seed = 1;
function service(options: Partial<CommunityServiceOptions> & { name?: string } = {}) {
  const c = clock();
  let r = (seed++ * 2654435761) >>> 0;
  const random = () => {
    r = (r + 0x6d2b79f5) >>> 0;
    let t = r;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const svc = new CommunityService({
    storage: memoryStorage(),
    now: c.now,
    utcOffsetMin: () => CET,
    random,
    timers: c.timers,
    saveDelayMs: 0,
    yieldToUi: async () => {},
    ...options,
  });
  if (options.name) svc.setDisplayName(options.name);
  return { svc, clock: c };
}

/** 1 h at 200 W with FTP 250: IF 0.8 → 64 points. */
const hour = (id: string, start = T0 - DAY) => syntheticRide(id, start, 3600, 200);

describe('CommunityService: own rides', () => {
  it('records a ride into this week and month with points', () => {
    const { svc } = service();
    expect(svc.recordRide(hour('r1'), { ftpW: 250, groupRide: false })).toBe(true);
    const { week, month } = svc.view;
    expect(week.key).toBe('2026-W47');
    expect(week.totals).toMatchObject({ rides: 1, points: 64, movingS: 3600, distanceM: 36_000 });
    expect(month.key).toBe('2026-11');
    expect(month.totals.points).toBe(64);
    expect(week.startsAt).toBe(Date.UTC(2026, 10, 16) - CET * 60_000);
    expect(svc.view.leaderboard.rows).toEqual([
      expect.objectContaining({ you: true, value: 64, rank: 1 }),
    ]);
  });

  it('is idempotent per ride id and removes deleted rides', () => {
    const { svc } = service();
    svc.recordRide(hour('r1'), { ftpW: 250, groupRide: true });
    expect(svc.recordRide(hour('r1'), { ftpW: 100, groupRide: false })).toBe(false);
    expect(svc.view.week.totals).toMatchObject({ rides: 1, points: 64, groupRides: 1 });
    svc.removeRide('r1');
    expect(svc.view.week.totals.rides).toBe(0);
    svc.removeRide('r1'); // no-op
    // An id the facts cannot use (> 64 characters) is refused, not fatal.
    expect(svc.recordRide(hour('x'.repeat(80)), { ftpW: 250, groupRide: false })).toBe(false);
  });

  it('backfills finished rides once, oldest first, with the current FTP, skipping deleted ones', async () => {
    const { svc } = service();
    svc.recordRide(hour('already'), { ftpW: 250, groupRide: false });
    const rides: Record<string, RecordedRide> = {
      a: hour('a', T0 - 3 * DAY),
      b: hour('b', T0 - 2 * DAY),
      c: hour('c', T0 - 4 * DAY),
      gone: hour('gone', T0 - 5 * DAY),
      autosave: hour('autosave', T0 - 6 * DAY),
      already: hour('already'),
    };
    const item = (id: string, finished = true): RideListItem => ({
      id,
      name: id,
      startedAt: rides[id]!.startedAt,
      durationS: 3600,
      distanceM: 36_000,
      avgPowerW: 200,
      finished,
    });
    const loaded: string[] = [];
    const source = {
      list: vi.fn(async () => [
        item('a'),
        item('b'),
        item('c'),
        item('gone'),
        item('already'),
        item('autosave', false),
      ]),
      load: vi.fn(async (id: string) => {
        loaded.push(id);
        if (id === 'gone') return null;
        if (id === 'c') svc.removeRide('b'); // "b" deleted while the backfill runs
        return rides[id] ?? null;
      }),
    };
    await svc.backfill(source, 250);
    expect(loaded).toEqual(['gone', 'c', 'a']);
    const facts = svc.state.ledger.rides;
    expect(Object.keys(facts).sort()).toEqual(['a', 'already', 'c']);
    expect(facts.a).toMatchObject({ backfilled: true, ftpW: 250, groupRide: false, points: 64 });
    expect(facts.already?.backfilled).toBeUndefined();
    expect(svc.view.backfill).toMatchObject({ status: 'done', added: 2, total: 4 });
    await svc.backfill(source, 250);
    expect(source.list).toHaveBeenCalledTimes(1);
  });

  it('reports a failed backfill and tries again on the next start', async () => {
    const storage = memoryStorage();
    const { svc } = service({ storage });
    await svc.backfill(
      { list: async () => Promise.reject(new Error('offline')), load: async () => null },
      250,
    );
    expect(svc.view.backfill.status).toBe('failed');
    const again = service({ storage }).svc;
    expect(again.view.backfill.status).toBe('pending');
  });
});

describe('CommunityService: persistence', () => {
  it('round-trips through storage (periods stripped) and keeps the rider id', () => {
    const storage = memoryStorage();
    const { svc } = service({ storage });
    svc.recordRide(hour('r1'), { ftpW: 250, groupRide: false });
    svc.setFriendsOfFriends(true);
    svc.setLeaderboardView({ period: 'thisMonth', metric: 'distanceM' });
    svc.flush();
    const stored = JSON.parse(storage.map.get(COMMUNITY_STORAGE_KEY)!);
    expect(stored.ledger.periods).toEqual({});
    expect(Object.keys(stored.ledger.rides)).toEqual(['r1']);
    const reloaded = service({ storage }).svc;
    expect(reloaded.view.profile.riderId).toBe(svc.view.profile.riderId);
    expect(reloaded.view.profile.friendsOfFriends).toBe(true);
    expect(reloaded.view.week.totals.points).toBe(64);
    expect(reloaded.view.leaderboard).toMatchObject({ period: 'thisMonth', metric: 'distanceM' });
    expect(JSON.parse(storage.map.get(COMMUNITY_META_KEY)!)).toMatchObject({
      leaderboard: { period: 'thisMonth' },
    });
  });

  it('debounces saves and writes pending changes on flush/dispose', () => {
    const storage = memoryStorage();
    const { svc, clock: c } = service({ storage, saveDelayMs: 2_000 });
    const before = storage.writes;
    svc.recordRide(hour('r1'), { ftpW: 250, groupRide: false });
    svc.recordRide(hour('r2', T0 - 2 * DAY), { ftpW: 250, groupRide: false });
    expect(storage.writes).toBe(before);
    c.advance(2_000);
    expect(storage.writes).toBe(before + 1);
    svc.recordRide(hour('r3', T0 - 3 * DAY), { ftpW: 250, groupRide: false });
    svc.dispose();
    expect(storage.writes).toBe(before + 2);
    expect(
      Object.keys(JSON.parse(storage.map.get(COMMUNITY_STORAGE_KEY)!).ledger.rides),
    ).toHaveLength(3);
  });

  it('survives corrupt data (and keeps a copy of it), repairs partly broken data', () => {
    const storage = memoryStorage();
    storage.map.set(COMMUNITY_STORAGE_KEY, '{not json');
    storage.map.set(COMMUNITY_META_KEY, '[[[');
    const { svc } = service({ storage });
    expect(svc.view.profile.riderId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(storage.map.get(COMMUNITY_CORRUPT_KEY)).toBe('{not json');
    expect(svc.view.leaderboard.period).toBe('thisWeek');

    const partly = memoryStorage();
    const good = service({ storage: partly }).svc;
    good.recordRide(hour('r1'), { ftpW: 250, groupRide: false });
    good.flush();
    const raw = JSON.parse(partly.map.get(COMMUNITY_STORAGE_KEY)!);
    raw.ledger.rides.bogus = { rideId: 'bogus', points: 1e9 };
    raw.contacts = 'nope';
    partly.map.set(COMMUNITY_STORAGE_KEY, JSON.stringify(raw));
    const repaired = service({ storage: partly }).svc;
    expect(repaired.view.profile.riderId).toBe(good.view.profile.riderId);
    expect(Object.keys(repaired.state.ledger.rides)).toEqual(['r1']);
  });

  it('works with blocked storage and tells the rider once when saving fails', () => {
    const notices: string[] = [];
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    const { svc } = service({ storage: blocked, onNotice: (_k, m) => notices.push(m) });
    svc.recordRide(hour('r1'), { ftpW: 250, groupRide: false });
    svc.recordRide(hour('r2', T0 - 2 * DAY), { ftpW: 250, groupRide: false });
    expect(svc.view.week.totals.rides).toBe(2);
    expect(svc.view.storage.saveFailed).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/could not save/i);

    const full = memoryStorage();
    const s2 = service({ storage: full }).svc;
    full.full = true;
    s2.recordRide(hour('r1'), { ftpW: 250, groupRide: false });
    expect(s2.view.storage.saveFailed).toBe(true);
    full.full = false;
    s2.recordRide(hour('r2', T0 - 2 * DAY), { ftpW: 250, groupRide: false });
    expect(s2.view.storage.saveFailed).toBe(false);
    expect(Object.keys(JSON.parse(full.map.get(COMMUNITY_STORAGE_KEY)!).ledger.rides)).toHaveLength(
      2,
    );
  });

  it('works without storage at all', () => {
    const { svc } = service({ storage: null });
    svc.recordRide(hour('r1'), { ftpW: 250, groupRide: false });
    svc.flush();
    expect(svc.view.week.totals.points).toBe(64);
  });
});

/** Two or more services in a synchronous fake session. */
function session(...names: string[]) {
  const hub = new FakeHub();
  const riders = names.map((name, i) => {
    const { svc, clock: c } = service({ name });
    return { name, svc, clock: c, peerId: `peer-${i}` };
  });
  const groups = new Map<string, ReturnType<FakeHub['join']>>();
  const join = (name: string) => {
    const r = riders.find((x) => x.name === name)!;
    const g = hub.join(r.peerId, name);
    groups.set(name, g);
    r.svc.attach(g);
    return g;
  };
  const leave = (name: string) => {
    riders.find((x) => x.name === name)!.svc.detach();
    groups.get(name)?.leave();
  };
  const get = (name: string) => riders.find((x) => x.name === name)!.svc;
  return { hub, riders, join, leave, get, groups };
}

describe('CommunityService: contacts and sync', () => {
  it('riders in a session become contacts and see each other on the leaderboard', () => {
    const { hub, join, get } = session('Anna', 'Ben');
    get('Anna').recordRide(hour('a1'), { ftpW: 250, groupRide: true });
    get('Ben').recordRide(syntheticRide('b1', T0 - DAY, 1800, 250), { ftpW: 250, groupRide: true });
    join('Anna');
    join('Ben');
    hub.flush();
    const anna = get('Anna').view;
    expect(anna.contacts).toEqual([
      expect.objectContaining({ name: 'Ben', visibility: 'totals', present: true }),
    ]);
    expect(anna.contacts[0]?.standing).toMatchObject({
      viaRiderId: null,
      stale: false,
      ageHours: 0,
    });
    expect(anna.session).toMatchObject({ active: true, peers: 1, identified: 1, level: 'totals' });
    expect(anna.leaderboard.rows.map((r) => [r.name, r.value])).toEqual([
      ['Anna', 64],
      ['Ben', 50],
    ]);
    expect(get('Ben').view.leaderboard.rows.map((r) => r.name)).toEqual(['Anna', 'Ben']);
  });

  it('visibility, rename, remove (blocks) and unblock', () => {
    const { hub, join, get, groups } = session('Anna', 'Ben');
    get('Anna').recordRide(hour('a1'), { ftpW: 250, groupRide: false });
    join('Anna');
    join('Ben');
    hub.flush();
    const ben = get('Ben').view.profile.riderId;
    const anna = get('Anna');
    expect(anna.setContactVisibility(ben, 'everything')).toEqual({ ok: true });
    hub.flush();
    expect(anna.view.session.level).toBe('everything');
    expect(anna.renameContact(ben, '  Benny ')).toEqual({ ok: true });
    expect(anna.view.contacts[0]).toMatchObject({
      alias: 'Benny',
      displayName: 'Benny',
      name: 'Ben',
    });
    expect(anna.renameContact(ben, '')).toEqual({ ok: true });
    expect(anna.view.contacts[0]?.alias).toBeNull();
    expect(anna.setContactVisibility('nobody-at-all', 'none')).toMatchObject({ ok: false });

    // Removing a rider who is present silences us at once (synchronously).
    expect(anna.removeContact(ben)).toEqual({ ok: true });
    expect(groups.get('Anna')!.local.size).toBe(0);
    expect(anna.view.contacts).toEqual([]);
    expect(anna.view.blocked).toEqual([expect.objectContaining({ riderId: ben, name: 'Ben' })]);
    expect(anna.view.session.level).toBe('silent');
    expect(anna.renameContact(ben, 'x')).toMatchObject({ ok: false });
    expect(anna.unblockContact(ben)).toEqual({ ok: true });
    expect(anna.view.blocked).toEqual([]);
    expect(anna.unblockContact(ben)).toMatchObject({ ok: false });
  });

  it('default visibility and the friends-of-friends flag are profile settings', () => {
    const { svc } = service();
    svc.setDefaultVisibility('none');
    svc.setFriendsOfFriends(true);
    expect(svc.view.profile).toMatchObject({ defaultVisibility: 'none', friendsOfFriends: true });
  });

  it('never serves a newcomer the richer documents published before it joined', () => {
    const { hub, join, get, groups } = session('Anna', 'Ben', 'Cleo');
    get('Anna').recordRide(syntheticRide('a1', T0 - DAY, 1500, 260), {
      ftpW: 250,
      groupRide: false,
    });
    join('Anna');
    join('Ben');
    hub.flush();
    get('Anna').setContactVisibility(get('Ben').view.profile.riderId, 'everything');
    hub.flush();
    const rich = groups.get('Anna')!.local.get(KIND_STANDING)!.text;
    expect(rich).toContain('"l":"e"');
    join('Cleo'); // unknown to Anna
    // Synchronously narrowed in the join event: identity only.
    expect(groups.get('Anna')!.local.get(KIND_STANDING)!.text).not.toContain('"s":');
    hub.flush();
    const fromAnna = groups.get('Cleo')!.received.filter((d) => d.from === 'peer-0');
    expect(fromAnna.length).toBeGreaterThan(0);
    for (const d of fromAnna) expect(d.text).not.toContain('"l":"e"');
    // Cleo is identified now and gets Anna's default (totals), still no best efforts.
    expect(get('Anna').view.session).toMatchObject({ identified: 2, level: 'totals' });
  });

  it('keeps the community documents within the budget next to a workout', () => {
    const { hub, join, get, groups } = session('Anna', 'Ben');
    join('Anna');
    join('Ben');
    hub.flush();
    const g = groups.get('Anna')!;
    const workout = 'w'.repeat(14_000);
    get('Anna').makeRoom(workout.length);
    expect(g.shareDocument('workout', workout)).toBeNull();
    get('Anna').resync();
    let total = 0;
    for (const d of g.getLocalDocuments()) total += d.text.length;
    expect(total).toBeLessThanOrEqual(32_768);
    expect(g.local.has(KIND_STANDING)).toBe(true);
  });

  it('forgets peer mappings on leave and withdraws documents on detach', () => {
    const { hub, join, leave, get, groups } = session('Anna', 'Ben');
    join('Anna');
    join('Ben');
    hub.flush();
    leave('Ben');
    expect(get('Anna').view.session).toMatchObject({ peers: 0, identified: 0, level: 'none' });
    expect(get('Anna').view.contacts[0]?.present).toBe(false);
    get('Anna').detach();
    expect(groups.get('Anna')!.local.size).toBe(0);
    expect(get('Anna').view.session).toEqual({
      active: false,
      peers: 0,
      identified: 0,
      level: null,
    });
  });
});

describe('CommunityService: challenges', () => {
  function pair() {
    const s = session('Anna', 'Ben');
    s.get('Anna').recordRide(hour('a1'), { ftpW: 250, groupRide: false });
    s.get('Ben').recordRide(syntheticRide('b1', T0 - DAY, 1800, 250), {
      ftpW: 250,
      groupRide: false,
    });
    s.join('Anna');
    s.join('Ben');
    s.hub.flush();
    return {
      ...s,
      anna: s.get('Anna'),
      ben: s.get('Ben'),
      benId: s.get('Ben').view.profile.riderId,
    };
  }

  const inputs: Record<string, CreateChallengeInput> = {
    'personal-goal': { type: 'personal-goal', metric: 'distanceM', target: 100_000 },
    'group-goal': { type: 'group-goal', metric: 'points', target: 200 },
    duel: { type: 'duel' },
    streak: { type: 'streak', target: 2 },
    consistency: { type: 'consistency', target: 3 },
    'beat-your-best': { type: 'beat-your-best', metric: 'p20m' },
    'ride-together': { type: 'ride-together', target: 2 },
  };

  it('describes all seven templates for the UI', () => {
    expect(CHALLENGE_TEMPLATES.map((t) => t.type)).toEqual(CHALLENGE_TYPES);
    expect(CHALLENGE_TEMPLATES.find((t) => t.type === 'duel')).toEqual({
      type: 'duel',
      metrics: [{ metric: 'points', target: null }],
      maxParticipants: 2,
    });
    expect(JSON.parse(JSON.stringify(CHALLENGE_TEMPLATES))).toEqual(CHALLENGE_TEMPLATES);
  });

  for (const type of CHALLENGE_TYPES) {
    it(`${type}: create, invite, accept, progress, leave, cancel`, () => {
      const { hub, anna, ben, benId } = pair();
      const created = anna.createChallenge({ ...inputs[type]!, invite: [benId] });
      expect(created).toMatchObject({ ok: true, challengeId: expect.any(String) });
      if (!created.ok) return;
      const id = created.challengeId!;
      hub.flush();
      expect(ben.view.invitations.map((c) => c.id)).toEqual([id]);
      expect(ben.view.invitations[0]).toMatchObject({ type, myState: 'invited', isCreator: false });
      expect(ben.respondToChallenge(id, 'accepted')).toEqual({ ok: true, challengeId: id });
      hub.flush();
      expect(ben.view.invitations).toEqual([]);
      const mine = anna.view.challenges.find((c) => c.id === id)!;
      expect(mine).toMatchObject({ isCreator: true, myState: 'accepted', status: 'active' });
      expect(mine.progress.participants.map((p) => p.state)).toEqual(['accepted', 'accepted']);
      expect(mine.progress.status).toBe('running');
      expect(ben.leaveChallenge(id)).toMatchObject({ ok: true });
      expect(ben.cancelChallenge(id)).toEqual({
        ok: false,
        error: 'Only the rider who created the challenge can do that.',
      });
      expect(anna.cancelChallenge(id)).toMatchObject({ ok: true });
      hub.flush();
      expect(ben.view.challenges.find((c) => c.id === id)?.status).toBe('cancelled');
      expect(anna.respondToChallenge(id, 'declined')).toEqual({
        ok: false,
        error: 'This challenge was cancelled.',
      });
    });
  }

  it('group goal progress sums both riders', () => {
    const { hub, anna, ben, benId } = pair();
    const created = anna.createChallenge({
      type: 'group-goal',
      metric: 'points',
      target: 200,
      invite: [benId],
    });
    if (!created.ok) throw new Error(created.error);
    hub.flush();
    ben.respondToChallenge(created.challengeId!, 'accepted');
    hub.flush();
    const c = anna.view.challenges[0]!;
    expect(c.progress.combined).toMatchObject({
      value: 64 + 50,
      target: 200,
      complete: false,
      partial: false,
    });
    expect(
      anna.leaderboard({ period: 'thisWeek', metric: 'points', scope: c.id }).rows,
    ).toHaveLength(2);
  });

  it('validates input with messages for the rider', () => {
    const { anna, benId } = pair();
    expect(anna.createChallenge({ type: 'group-goal', metric: 'points', target: 0 })).toEqual({
      ok: false,
      error: 'The target must be a whole number from 1 to 56000.',
    });
    expect(anna.createChallenge({ type: 'duel', metric: 'distanceM' })).toMatchObject({
      ok: false,
    });
    expect(anna.createChallenge({ type: 'nope' as never })).toEqual({
      ok: false,
      error: 'Unknown challenge type.',
    });
    expect(anna.createChallenge({ type: 'duel', week: '2026-W40' })).toEqual({
      ok: false,
      error: 'Pick this week or a later one.',
    });
    expect(anna.createChallenge({ type: 'duel', week: 'soon' })).toMatchObject({ ok: false });
    expect(anna.createChallenge({ type: 'duel', invite: ['stranger-123456'] })).toEqual({
      ok: false,
      error: 'Only friends you have ridden with can be invited.',
    });
    const next = anna.createChallenge({ type: 'duel', week: 'nextWeek' });
    if (!next.ok) throw new Error(next.error);
    expect(anna.view.challenges.find((c) => c.id === next.challengeId)).toMatchObject({
      week: '2026-W48',
      canInvite: true,
    });
    expect(anna.inviteToChallenge(next.challengeId!, benId)).toMatchObject({ ok: true });
    expect(anna.inviteToChallenge(next.challengeId!, benId)).toEqual({
      ok: false,
      error: 'That rider is already in this challenge.',
    });
    expect(anna.leaveChallenge('missing')).toMatchObject({ ok: false });
    expect(anna.respondToChallenge(next.challengeId!, 'accepted')).toEqual({
      ok: false,
      error: 'That is not possible in the current state of the challenge.',
    });
  });
});

describe('CommunityService: view-model stability', () => {
  it('unchanged inputs keep every object identical', () => {
    const { hub, join, get, riders } = session('Anna', 'Ben');
    get('Anna').recordRide(hour('a1'), { ftpW: 250, groupRide: false });
    join('Anna');
    join('Ben');
    hub.flush();
    const anna = get('Anna');
    const before = anna.view;
    const listener = vi.fn();
    anna.subscribe(listener);
    anna.tick(); // same minute
    anna.resync();
    hub.flush();
    anna.setFriendsOfFriends(false); // already false
    expect(anna.view).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    // A profile change replaces only the profile part.
    anna.setDefaultVisibility('everything');
    const after = anna.view;
    expect(after).not.toBe(before);
    expect(after.profile).not.toBe(before.profile);
    for (const k of [
      'week',
      'month',
      'leaderboard',
      'challenges',
      'contacts',
      'session',
    ] as const) {
      expect(after[k]).toBe(before[k]);
    }
    expect(listener).toHaveBeenCalledTimes(1);

    // Time-based values move at most once a minute.
    riders[0]!.clock.advance(30_000);
    anna.tick();
    expect(anna.view).toBe(after);
  });

  it('rolls the week over on the minute tick', () => {
    const { svc, clock: c } = service();
    svc.recordRide(hour('r1'), { ftpW: 250, groupRide: false });
    expect(svc.view.week.totals.rides).toBe(1);
    c.advance(5 * DAY); // into the next week
    expect(svc.view.week.key).toBe('2026-W47'); // not recomputed without a tick
    svc.tick();
    expect(svc.view.week.key).toBe('2026-W48');
    expect(svc.view.week.totals.rides).toBe(0);
    expect(svc.view.month.totals.rides).toBe(1);
    svc.setLeaderboardView({ period: 'lastWeek' });
    expect(svc.view.leaderboard).toMatchObject({ periodKey: '2026-W47' });
    expect(svc.view.leaderboard.rows[0]?.value).toBe(64);
    expect(svc.setLeaderboardView({ metric: 'avgSpeed' as never })).toMatchObject({ ok: false });
    expect(svc.setLeaderboardView({ scope: 'no-such-challenge' })).toMatchObject({ ok: false });
  });

  it('marks friends stale after 36 h without news', () => {
    const { hub, join, get, riders, leave } = session('Anna', 'Ben');
    get('Ben').recordRide(hour('b1'), { ftpW: 250, groupRide: false });
    join('Anna');
    join('Ben');
    hub.flush();
    leave('Ben');
    riders[0]!.clock.advance(40 * HOUR);
    get('Anna').tick();
    expect(get('Anna').view.contacts[0]?.standing).toMatchObject({ stale: true, ageHours: 40 });
  });
});
