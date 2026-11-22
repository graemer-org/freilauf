/**
 * Community sync end to end: CommunityService participants over the real `GroupRide` (via the
 * app's `adaptGroupRide`) on both transports — the fake WebRTC network with the in-process
 * signalling hub, and the fake relay (Trystero) network — on a fake clock. Covers meeting, standings, challenges, relaying and the peer-join no-leak rule
 * under delays, duplicates, loss and reordering.
 */
import { KIND_STANDING } from '@freilauf/community';
import { GroupRide } from '@freilauf/p2p';
import type { DocumentEvent } from '@freilauf/p2p';
import { createTestNetwork, FakeClock, TEST_TRANSPORTS } from '@freilauf/p2p/testing';
import type { FakeLinkConditions, TestTransportKind } from '@freilauf/p2p/testing';
import { describe, expect, it } from 'vitest';
import { adaptGroupRide } from '../main/groupConnector';
import { CommunityService } from './communityService';
import { CET, DAY, T0, memoryStorage, syntheticRide } from './testing/communityFixtures';

interface Rider {
  name: string;
  svc: CommunityService;
  ride: GroupRide | null;
  peerId: string;
  /** Every document this rider's GroupRide made available, with the sender. */
  received: { from: string; kind: string; text: string }[];
}

function world(kind: TestTransportKind, seed: number) {
  const clock = new FakeClock(T0);
  const network = createTestNetwork(kind, { clock, seed });
  let peerCounter = 0;
  let randomState = seed * 7919;
  const random = () => {
    randomState = (randomState * 1103515245 + 12345) % 2 ** 31;
    return randomState / 2 ** 31;
  };
  const riders: Rider[] = [];

  const rider = (name: string): Rider => {
    const svc = new CommunityService({
      storage: memoryStorage(),
      now: clock.now,
      utcOffsetMin: () => CET,
      random,
      timers: clock.timers,
      saveDelayMs: 1_000,
      yieldToUi: async () => {},
    });
    svc.setDisplayName(name);
    const r: Rider = { name, svc, ride: null, peerId: '', received: [] };
    riders.push(r);
    return r;
  };

  let host: GroupRide | null = null;
  const enter = async (r: Rider) => {
    // Peer ids sort in join order unless prefixed: vary who offers.
    r.peerId = `p${String(++peerCounter).padStart(2, '0')}-${r.name.toLowerCase()}`;
    const extra = { documentMessageMaxBytes: 400 };
    const ride = host
      ? await network.join(host, r.name, r.peerId, extra)
      : await network.create(r.name, r.peerId, extra);
    host ??= ride;
    r.ride = ride;
    ride.onDocument((e: DocumentEvent) => {
      if (e.type === 'available') {
        r.received.push({ from: e.document.peerId, kind: e.document.kind, text: e.document.text });
      }
    });
    r.svc.attach(adaptGroupRide(ride));
  };

  const leave = (r: Rider) => {
    r.svc.detach();
    r.ride?.leave();
    r.ride = null;
  };

  const settle = (ms = 6_000) => clock.advanceAsync(ms);

  const newRoom = () => {
    for (const r of riders) if (r.ride) leave(r);
    host = null;
  };

  return { clock, network, rider, enter, leave, settle, newRoom, riders };
}

const idOf = (r: Rider) => r.svc.view.profile.riderId;
const hour = (id: string, powerW: number, start = T0 - DAY) =>
  syntheticRide(id, start, 3600, powerW);

describe.each(TEST_TRANSPORTS)('community sync over GroupRide (%s)', (kind) => {
  it('A and B meet, exchange standings, run a group goal; B relays A to C only when allowed', async () => {
    const w = world(kind, 1);
    const anna = w.rider('Anna');
    const ben = w.rider('Ben');
    const cleo = w.rider('Cleo');
    anna.svc.recordRide(hour('a1', 200), { ftpW: 250, groupRide: false }); // 64 points
    ben.svc.recordRide(hour('b1', 225), { ftpW: 250, groupRide: false }); // 81 points
    cleo.svc.recordRide(hour('c1', 150), { ftpW: 250, groupRide: false }); // 36 points

    await w.enter(anna);
    await w.enter(ben);
    await w.settle();
    expect(anna.svc.view.contacts.map((c) => [c.name, c.present])).toEqual([['Ben', true]]);
    expect(anna.svc.view.leaderboard.rows.map((r) => [r.name, r.value])).toEqual([
      ['Ben', 81],
      ['Anna', 64],
    ]);
    expect(ben.svc.view.leaderboard.rows.map((r) => r.name)).toEqual(['Ben', 'Anna']);
    expect(anna.svc.view.session).toMatchObject({ peers: 1, identified: 1, level: 'totals' });

    // Group goal: A creates and invites B, B accepts; progress reflects both.
    const created = anna.svc.createChallenge({
      type: 'group-goal',
      metric: 'points',
      target: 300,
      invite: [idOf(ben)],
    });
    if (!created.ok) throw new Error(created.error);
    const id = created.challengeId!;
    await w.settle();
    expect(ben.svc.view.invitations.map((c) => c.id)).toEqual([id]);
    expect(ben.svc.respondToChallenge(id, 'accepted')).toMatchObject({ ok: true });
    await w.settle();
    const progress = anna.svc.view.challenges.find((c) => c.id === id)?.progress;
    expect(progress?.participants.map((p) => [p.name, p.state, p.value])).toEqual([
      ['Anna', 'accepted', 64],
      ['Ben', 'accepted', 81],
    ]);
    expect(progress?.combined).toMatchObject({ value: 145, target: 300, partial: false });
    expect(ben.svc.view.challenges[0]?.progress.combined?.value).toBe(145);

    // B–C without A: A has friends-of-friends off and C is not in A's audience → no relay.
    w.newRoom();
    await w.enter(ben);
    await w.enter(cleo);
    await w.settle();
    expect(cleo.svc.view.contacts.map((c) => c.name)).toEqual(['Ben']);
    expect(cleo.svc.state.standings[idOf(anna)]).toBeUndefined();
    for (const d of cleo.received) expect(d.text).not.toContain(idOf(anna) + '","n":"Anna"');

    // A turns friends-of-friends on and meets B again; then B relays A's totals to C.
    w.newRoom();
    anna.svc.setFriendsOfFriends(true);
    await w.enter(anna);
    await w.enter(ben);
    await w.settle();
    expect(ben.svc.state.standings[idOf(anna)]?.standing.relay.friendsOfFriends).toBe(true);
    w.newRoom();
    await w.enter(ben);
    await w.enter(cleo);
    await w.settle();
    const relayed = cleo.svc.state.standings[idOf(anna)];
    expect(relayed).toMatchObject({ via: idOf(ben), standing: { level: 'totals' } });
    // A friend of a friend is not a contact and not on the friends board.
    expect(cleo.svc.view.contacts.map((c) => c.name)).toEqual(['Ben']);
    expect(cleo.svc.view.leaderboard.rows.map((r) => r.name)).toEqual(['Ben', 'Cleo']);
    w.newRoom();
  });

  const LINKS: FakeLinkConditions = { maxDelayMs: 150, duplicateRate: 0.2, lossRate: 0.1 };

  for (const seed of [1, 2, 3]) {
    it(`no leak: a newcomer never receives A's richer standing (unknown newcomer, seed ${seed})`, async () => {
      const w = world(kind, seed);
      const anna = w.rider('Anna');
      const ben = w.rider('Ben');
      const cleo = w.rider('Cleo');
      // 25 min hard: best efforts up to p20m exist → the 'everything' standing has them.
      anna.svc.recordRide(syntheticRide('a1', T0 - DAY, 1500, 280), {
        ftpW: 250,
        groupRide: false,
      });
      await w.enter(anna);
      await w.enter(ben);
      await w.settle();
      anna.svc.setContactVisibility(idOf(ben), 'everything');
      await w.settle();
      const fromAnnaToBen = ben.received.filter(
        (d) => d.from === anna.peerId && d.kind === KIND_STANDING,
      );
      expect(fromAnnaToBen.at(-1)?.text).toContain('"l":"e"');

      w.network.setConditions(LINKS);
      // Anna keeps re-publishing her rich standing to Ben while Cleo arrives.
      anna.svc.recordRide(syntheticRide('a2', T0 - 2 * DAY, 1300, 270), {
        ftpW: 250,
        groupRide: false,
      });
      await w.clock.advanceAsync(40, 5);
      await w.enter(cleo);
      await w.settle(10_000);

      const fromAnna = cleo.received.filter((d) => d.from === anna.peerId);
      expect(fromAnna.length).toBeGreaterThan(0);
      for (const d of fromAnna) expect(d.text).not.toContain('"l":"e"');
      // Cleo is identified and became a contact at Anna's default (totals).
      expect(cleo.svc.state.standings[idOf(anna)]?.standing.level).toBe('totals');
      expect(anna.svc.view.session).toMatchObject({ peers: 2, identified: 2, level: 'totals' });
      w.newRoom();
    });

    it(`no leak: a known rider set to 'none' gets identity only, never A's standing (seed ${seed})`, async () => {
      const w = world(kind, seed + 10);
      const anna = w.rider('Anna');
      const ben = w.rider('Ben');
      const cleo = w.rider('Cleo');
      anna.svc.recordRide(syntheticRide('a1', T0 - DAY, 1500, 280), {
        ftpW: 250,
        groupRide: false,
      });
      // Anna and Cleo meet first; Anna then hides everything from Cleo.
      await w.enter(anna);
      await w.enter(cleo);
      await w.settle();
      anna.svc.setContactVisibility(idOf(cleo), 'none');
      w.newRoom();
      cleo.received.length = 0;

      await w.enter(anna);
      await w.enter(ben);
      await w.settle();
      anna.svc.setContactVisibility(idOf(ben), 'everything');
      await w.settle();
      w.network.setConditions(LINKS);
      await w.enter(cleo);
      await w.settle(10_000);

      const fromAnna = cleo.received.filter((d) => d.from === anna.peerId);
      expect(fromAnna.map((d) => d.kind)).toContain(KIND_STANDING);
      for (const d of fromAnna) {
        expect(d.kind).toBe(KIND_STANDING);
        expect(d.text).not.toContain('"s":'); // identity only
      }
      expect(anna.svc.view.session.level).toBe('none');
      // Ben still has the rich version from before Cleo joined, but nothing new reached Cleo.
      w.newRoom();
    });
  }
});
