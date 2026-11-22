import { describe, expect, it } from 'vitest';
import { utf8Length, type DocumentEvent, type StartAnnouncement } from './documents';
import { BROADCAST_INTERVAL_MS, GroupRide, type LocalRiderState } from './group';
import {
  createTestNetwork,
  FakeClock,
  TEST_TRANSPORTS,
  type FakeLinkConditions,
  type TestTransportKind,
} from './testing';

function local(distanceM: number, speedMps = 0): LocalRiderState {
  return { distanceM, speedMps, powerW: 200, cadenceRpm: 90, heartRateBpm: null, gear: 11 };
}

/** A deterministic stand-in for an encoded workout (~`bytes` long, JSON with some Unicode). */
function fakeWorkout(name: string, bytes = 3_000): string {
  const steps: string[] = [];
  let i = 0;
  while (steps.join(',').length < bytes - 120) {
    steps.push(
      JSON.stringify({
        kind: 'steady',
        durationS: 60 + i,
        power: 0.5 + (i % 7) / 20,
        label: `Stufe ${i} — „ok“ 🚴`,
      }),
    );
    i++;
  }
  return JSON.stringify({
    format: 'freilauf-workout',
    version: 1,
    workout: { id: name, name, steps: [steps.join(',')] },
  });
}

interface Options {
  seed?: number;
  conditions?: FakeLinkConditions;
  documentMessageMaxBytes?: number;
}

async function setup(kind: TestTransportKind, count: number, options: Options = {}) {
  const clock = new FakeClock();
  const network = createTestNetwork(kind, { clock, seed: options.seed ?? 1 });
  const extra = { documentMessageMaxBytes: options.documentMessageMaxBytes };
  const rides: GroupRide[] = [];
  const events = new Map<GroupRide, DocumentEvent[]>();
  const starts = new Map<GroupRide, StartAnnouncement[]>();
  const track = (ride: GroupRide) => {
    const ev: DocumentEvent[] = [];
    const st: StartAnnouncement[] = [];
    ride.onDocument((e) => ev.push(e));
    ride.onStart((s) => st.push(s));
    events.set(ride, ev);
    starts.set(ride, st);
    rides.push(ride);
    return ride;
  };
  const first = track(await network.create('Rider0', 'peer-0', extra));
  const join = async (index: number) => {
    const ride = track(await network.join(first, `Rider${index}`, `peer-${index}`, extra));
    await clock.advanceAsync(100);
    return ride;
  };
  for (let i = 1; i < count; i++) await join(i);
  // Connect on a perfect link, then apply the requested conditions.
  network.setConditions({ ...options.conditions });
  return { clock, network, rides, events, starts, join };
}

const texts = (ride: GroupRide) =>
  ride
    .getSharedDocuments()
    .map((d) => `${d.peerId}/${d.kind}:${d.text.length}`)
    .sort();

describe.each(TEST_TRANSPORTS)('GroupRide shared documents (%s)', (kind) => {
  it('delivers a shared document to every rider', async () => {
    const { clock, rides, events } = await setup(kind, 3);
    const [anna, ben, cleo] = rides as [GroupRide, GroupRide, GroupRide];
    const text = fakeWorkout('sweet-spot');
    const res = anna.shareDocument('workout', text);
    expect(res).toMatchObject({ ok: true, id: expect.stringMatching(/^[0-9a-f]{16}$/) });
    if (!res.ok) return;
    await clock.advanceAsync(200);
    for (const r of [ben, cleo]) {
      expect(r.getSharedDocuments()).toEqual([
        {
          peerId: 'peer-0',
          peerName: 'Rider0',
          kind: 'workout',
          id: res.id,
          text,
          receivedAt: expect.any(Number),
        },
      ]);
      expect(events.get(r)).toEqual([
        { type: 'available', document: expect.objectContaining({ id: res.id, text }) },
      ]);
    }
    expect(anna.getSharedDocuments()).toEqual([]);
    expect(anna.getLocalDocuments()).toEqual([{ kind: 'workout', id: res.id, text }]);
    // Re-sharing the identical text is a no-op.
    expect(anna.shareDocument('workout', text)).toEqual(res);
    await clock.advanceAsync(3_000);
    expect(events.get(ben)).toHaveLength(1);
  });

  it('a late joiner receives the current documents automatically', async () => {
    const { clock, rides, events, join } = await setup(kind, 2);
    const [anna, ben] = rides as [GroupRide, GroupRide];
    anna.shareDocument('workout', fakeWorkout('a'));
    ben.shareDocument('route', 'ben route');
    await clock.advanceAsync(200);
    const cleo = await join(2);
    await clock.advanceAsync(500);
    expect(texts(cleo)).toEqual([`peer-0/workout:${fakeWorkout('a').length}`, 'peer-1/route:9']);
    expect(events.get(cleo)?.map((e) => e.type)).toEqual(['available', 'available']);
    expect(texts(anna)).toEqual(['peer-1/route:9']);
  });

  it('a replaced document supersedes the old one', async () => {
    const { clock, rides, events } = await setup(kind, 2);
    const [anna, ben] = rides as [GroupRide, GroupRide];
    const v1 = anna.shareDocument('workout', fakeWorkout('v1'));
    await clock.advanceAsync(200);
    const v2 = anna.shareDocument('workout', fakeWorkout('v2'));
    if (!v1.ok || !v2.ok) throw new Error('share failed');
    expect(v2.id).not.toBe(v1.id);
    await clock.advanceAsync(200);
    expect(ben.getSharedDocuments().map((d) => d.id)).toEqual([v2.id]);
    expect(ben.getSharedDocuments()[0]?.text).toBe(fakeWorkout('v2'));
    expect(events.get(ben)).toEqual([
      { type: 'available', document: expect.objectContaining({ id: v1.id }) },
      { type: 'removed', peerId: 'peer-0', kind: 'workout', id: v1.id, reason: 'replaced' },
      { type: 'available', document: expect.objectContaining({ id: v2.id }) },
    ]);
  });

  it('withdrawal and the sharer leaving remove documents', async () => {
    const { clock, rides, events } = await setup(kind, 3);
    const [anna, ben, cleo] = rides as [GroupRide, GroupRide, GroupRide];
    const w = anna.shareDocument('workout', 'w1');
    const r = anna.shareDocument('route', 'r1');
    if (!w.ok || !r.ok) throw new Error('share failed');
    await clock.advanceAsync(200);
    expect(texts(ben)).toEqual(['peer-0/route:2', 'peer-0/workout:2']);

    expect(anna.unshareDocument('workout')).toBe(true);
    expect(anna.unshareDocument('workout')).toBe(false);
    await clock.advanceAsync(200);
    expect(texts(ben)).toEqual(['peer-0/route:2']);
    expect(events.get(ben)?.at(-1)).toEqual({
      type: 'removed',
      peerId: 'peer-0',
      kind: 'workout',
      id: w.id,
      reason: 'withdrawn',
    });

    anna.leave();
    await clock.advanceAsync(200);
    for (const x of [ben, cleo]) {
      expect(x.getSharedDocuments()).toEqual([]);
      expect(events.get(x)?.at(-1)).toEqual({
        type: 'removed',
        peerId: 'peer-0',
        kind: 'route',
        id: r.id,
        reason: 'peer-left',
      });
    }
  });

  it('delivers chunked documents within the configured message size', async () => {
    const { clock, network, rides } = await setup(kind, 2, { documentMessageMaxBytes: 250 });
    const [anna, ben] = rides as [GroupRide, GroupRide];
    const text = fakeWorkout('chunky', 3_200);
    const res = anna.shareDocument('workout', text);
    if (!res.ok) throw new Error(res.reason);
    await clock.advanceAsync(300);
    expect(ben.getSharedDocuments()[0]?.text).toBe(text);
    const chunks = network.sentMessages().filter((m) => m.includes('"doc-chunk"'));
    expect(chunks.length).toBeGreaterThan(12);
    for (const c of chunks) expect(utf8Length(c)).toBeLessThanOrEqual(250);
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    // Relays: the channel is reliable and ordered, so only the delay applies there.
    it(`converges with 40 % loss, reordering and duplicates (seed ${seed})`, async () => {
      const { clock, network, rides } = await setup(kind, 4, {
        seed,
        conditions: { lossRate: 0.4, maxDelayMs: 80, duplicateRate: 0.1 },
      });
      const [anna, ben, cleo, dan] = rides as [GroupRide, GroupRide, GroupRide, GroupRide];
      for (const [i, r] of rides.entries()) r.setLocalState(local(1000 + i * 10));
      const big = fakeWorkout('big', 6_000); // ~7.5 kB once escaped: 10 chunks at the default size
      const small = fakeWorkout('small', 800);
      anna.shareDocument('workout', big);
      cleo.shareDocument('workout', small);
      let elapsed = 0;
      const done = () =>
        [ben, dan].every((r) => r.getSharedDocuments().length === 2) &&
        anna.getSharedDocuments().length === 1 &&
        cleo.getSharedDocuments().length === 1;
      while (!done() && elapsed < 20_000) {
        await clock.advanceAsync(250);
        elapsed += 250;
      }
      expect(elapsed).toBeLessThan(20_000);
      for (const r of [ben, dan]) {
        const byPeer = new Map(r.getSharedDocuments().map((d) => [d.peerId, d.text]));
        expect(byPeer.get('peer-0')).toBe(big);
        expect(byPeer.get('peer-2')).toBe(small);
      }
      if (kind === 'self-hosted') expect(network.dropped).toBeGreaterThan(0);
      // Rider state keeps flowing alongside (on the reliable relay channel the documents can
      // be complete before the first 4 Hz tick of every rider has arrived).
      await clock.advanceAsync(500);
      expect(
        ben
          .getRiders()
          .map((x) => x.name)
          .sort(),
      ).toEqual(['Rider0', 'Rider2', 'Rider3']);
    });
  }

  it('rejects oversize and malformed input without side effects', async () => {
    const { clock, network, rides } = await setup(kind, 2);
    const [anna, ben] = rides as [GroupRide, GroupRide];
    await clock.advanceAsync(300);
    const rejected = [
      anna.shareDocument('workout', 'x'.repeat(16 * 1024 + 1)),
      anna.shareDocument('workout', '€'.repeat(6_000)), // 18 000 UTF-8 bytes
      anna.shareDocument('Workout', 'x'),
      anna.shareDocument('a b', 'x'),
      anna.shareDocument('', 'x'),
      anna.shareDocument('-x', 'x'),
      anna.shareDocument('k'.repeat(33), 'x'),
      anna.shareDocument('workout', ''),
      anna.shareDocument('workout', 42 as unknown as string),
    ];
    expect(rejected.map((r) => (r.ok ? 'ok' : r.reason))).toEqual([
      'too-large',
      'too-large',
      'invalid-kind',
      'invalid-kind',
      'invalid-kind',
      'invalid-kind',
      'invalid-kind',
      'empty',
      'invalid-text',
    ]);
    expect(anna.announceStart('workout', 'nothex', 1000)).toEqual({
      ok: false,
      reason: 'invalid-id',
    });
    expect(anna.announceStart('workout', '0123456789abcdef', -1)).toEqual({
      ok: false,
      reason: 'invalid-delay',
    });
    expect(anna.announceStart('workout', '0123456789abcdef', Number.NaN)).toMatchObject({
      ok: false,
    });
    expect(anna.announceStart('Bad', '0123456789abcdef', 10)).toMatchObject({ ok: false });
    // No messages beyond the regular state broadcasts went out, nothing is shared.
    await clock.advanceAsync(10);
    const docMessages = network.sentMessages().filter((m) => m.includes('"doc-'));
    expect(docMessages).toEqual([]);
    expect(anna.getLocalDocuments()).toEqual([]);
    expect(ben.getSharedDocuments()).toEqual([]);
  });

  it('enforces the local caps on kinds and bytes', async () => {
    const { rides } = await setup(kind, 1);
    const [anna] = rides as [GroupRide];
    const full = 'x'.repeat(16 * 1024);
    expect(anna.shareDocument('a', full).ok).toBe(true);
    expect(anna.shareDocument('b', full).ok).toBe(true);
    expect(anna.shareDocument('c', 'x')).toEqual({ ok: false, reason: 'too-many-bytes' });
    expect(anna.shareDocument('a', 'small').ok).toBe(true); // replacing frees space
    expect(anna.shareDocument('c', 'x').ok).toBe(true);
    expect(anna.shareDocument('d', 'x').ok).toBe(true);
    expect(anna.shareDocument('e', 'x')).toEqual({ ok: false, reason: 'too-many-documents' });
    expect(anna.getLocalDocuments().map((d) => d.kind)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('survives malformed and unknown messages from a peer; state sync is unaffected', async () => {
    const { clock, network, rides } = await setup(kind, 2);
    const [anna, ben] = rides as [GroupRide, GroupRide];
    anna.setLocalState(local(500));
    // Inject raw messages on the channel (as a buggy or newer client would).
    for (const raw of [
      '{"v":1,"type":"doc-list","sid":"abcd","rev":1,"docs":[{"k":"w","id":"0000000000000000","n":99999,"c":1}]}',
      '{"v":1,"type":"doc-chunk","k":"w","id":"0000000000000000","n":1,"c":1,"i":0,"d":"x"}',
      '{"v":1,"type":"doc-future","whatever":[1,2,3]}',
      '{"v":2,"type":"state","state":{}}',
      'garbage "doc-',
      '{"v":1,"type":"doc-req","k":"w","id":"0000000000000000","m":[0]}',
    ]) {
      network.inject(anna, ben, raw);
    }
    await clock.advanceAsync(500);
    expect(ben.getSharedDocuments()).toEqual([]);
    expect(anna.getSharedDocuments()).toEqual([]);
    expect(ben.getRiders().map((r) => r.name)).toEqual(['Rider0']);
    expect(anna.hasLeft).toBe(false);
  });

  it('does not send document traffic until something is shared', async () => {
    const { clock, network, rides } = await setup(kind, 2);
    rides[0]!.setLocalState(local(1));
    await clock.advanceAsync(3_000);
    const all = network.sentMessages();
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((m) => m.includes('"doc-'))).toEqual([]);
  });

  it('broadcasts the document list once per second, not with every state packet', async () => {
    const { clock, network, rides } = await setup(kind, 2);
    const [anna] = rides as [GroupRide];
    anna.setLocalState(local(1));
    anna.shareDocument('workout', 'tiny');
    await clock.advanceAsync(100);
    const count = () => network.sentMessages().filter((m) => m.includes('"doc-list"')).length;
    const before = count();
    await clock.advanceAsync(5_000);
    expect(count() - before).toBeGreaterThanOrEqual(4);
    expect(count() - before).toBeLessThanOrEqual(6);
  });
});

describe.each(TEST_TRANSPORTS)('GroupRide synchronised start (%s)', (kind) => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`receivers agree with the sender's start instant despite loss (seed ${seed})`, async () => {
      const { clock, rides, starts } = await setup(kind, 4, {
        seed,
        conditions: { lossRate: 0.4, maxDelayMs: 80, duplicateRate: 0.5 },
      });
      const [anna, ...others] = rides as [GroupRide, ...GroupRide[]];
      const shared = anna.shareDocument('workout', fakeWorkout('start'));
      if (!shared.ok) throw new Error(shared.reason);
      await clock.advanceAsync(1_000);
      const res = anna.announceStart('workout', shared.id, 5_000);
      if (!res.ok) throw new Error(res.reason);
      await clock.advanceAsync(6_000);
      for (const r of others) {
        const got = starts.get(r) ?? [];
        expect(got).toHaveLength(1); // de-duplicated
        expect(got[0]).toMatchObject({
          announceId: res.announceId,
          peerId: 'peer-0',
          peerName: 'Rider0',
          kind: 'workout',
          id: shared.id,
        });
        // Shared fake clock: local instants are directly comparable here.
        expect(Math.abs(got[0]!.startsAt - res.startsAt)).toBeLessThanOrEqual(
          BROADCAST_INTERVAL_MS,
        );
        const refined = r.getStartAnnouncements()[0];
        expect(refined).toBeDefined();
        expect(Math.abs(refined!.startsAt - res.startsAt)).toBeLessThanOrEqual(
          BROADCAST_INTERVAL_MS,
        );
        expect(refined!.startsAt).toBeLessThanOrEqual(got[0]!.startsAt);
      }
      expect(starts.get(anna)).toEqual([]); // not delivered to the announcer itself
    });
  }

  it('tells a rider who connects during the countdown', async () => {
    const { clock, rides, starts, join } = await setup(kind, 2);
    const [anna] = rides as [GroupRide];
    const res = anna.announceStart('workout', '0123456789abcdef', 30_000);
    if (!res.ok) throw new Error(res.reason);
    await clock.advanceAsync(5_000);
    const late = await join(2);
    await clock.advanceAsync(100);
    const got = starts.get(late) ?? [];
    expect(got).toHaveLength(1);
    expect(Math.abs(got[0]!.startsAt - res.startsAt)).toBeLessThanOrEqual(BROADCAST_INTERVAL_MS);
    expect(got[0]!.startsInMs).toBeGreaterThan(20_000);
  });
});
