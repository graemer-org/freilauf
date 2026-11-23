import { afterEach, describe, expect, it } from 'vitest';
import type { SignallingServer } from '@freilauf/signalling';
import { GroupRide, type LocalRiderState } from './group';
import {
  createTestNetwork,
  FakeClock,
  FakeRtcNetwork,
  InMemorySignallingHub,
  TEST_TRANSPORTS,
} from './testing';
import { startServer, wsFactory } from './testing/wsTestUtils';

function local(distanceM: number, speedMps = 10): LocalRiderState {
  return { distanceM, speedMps, powerW: 200, cadenceRpm: 90, heartRateBpm: null, gear: 11 };
}

describe.each(TEST_TRANSPORTS)('GroupRide (%s, fake clock)', (kind) => {
  async function setup() {
    const clock = new FakeClock();
    const net = createTestNetwork(kind, { clock });
    const anna = await net.create('Anna', 'peer-a');
    const ben = await net.join(
      { roomCode: anna.roomCode.toLowerCase(), secret: anna.secret },
      'Ben',
      'peer-b',
    );
    await clock.advanceAsync(50);
    return { clock, net, anna, ben };
  }

  it('broadcasts at 4 Hz and exposes extrapolated riders with gaps', async () => {
    const { clock, net, anna, ben } = await setup();
    expect(anna.getPeers().map((p) => p.status)).toEqual(['connected']);
    anna.setLocalState(local(1000, 10));
    ben.setLocalState(local(990, 8));
    const before = net.sentMessages().length;
    await clock.advanceAsync(1000);

    // Two riders, 4–5 state packets each.
    const sent = net.sentMessages().length - before;
    expect(sent).toBeGreaterThanOrEqual(8);
    expect(sent).toBeLessThanOrEqual(10);

    const [seenByBen] = ben.getRiders();
    expect(seenByBen).toMatchObject({ peerId: 'peer-a', name: 'Anna', stale: false });
    // One second later: Anna is at 1000 + 10 m/s * 1 s, Ben at 990 + 8 m/s * 1 s.
    expect(seenByBen?.distanceM).toBeCloseTo(1010, 0);
    expect(seenByBen?.gapM).toBeCloseTo(1010 - 998, 0);
    const [seenByAnna] = anna.getRiders();
    expect(seenByAnna?.distanceM).toBeCloseTo(998, 0);
    expect(seenByAnna?.gapM).toBeCloseTo(-12, 0);
  });

  it('knows the other rider by name before any state was sent', async () => {
    const { anna, ben } = await setup();
    expect(anna.getPeers()).toMatchObject([{ peerId: 'peer-b', name: 'Ben', status: 'connected' }]);
    expect(ben.getPeers()).toMatchObject([{ peerId: 'peer-a', name: 'Anna', status: 'connected' }]);
    expect(anna.transport).toBe(kind);
  });

  it('marks riders stale after 3 s without updates and removes them on leave', async () => {
    const { clock, anna, ben } = await setup();
    anna.setLocalState(local(500));
    await clock.advanceAsync(300);
    expect(ben.getRiders()).toHaveLength(1);
    // Looking 3.5 s ahead without delivering further packets: stale, extrapolation capped at 2 s.
    const stopAt = clock.now();
    const [later] = ben.getRiders(stopAt + 3500);
    expect(later?.stale).toBe(true);
    // Last packet left at +200 ms (502 m); +2 s at 10 m/s at most.
    expect(later?.distanceM).toBeCloseTo(502 + 20, 0);

    let changes = 0;
    ben.onChange(() => changes++);
    anna.leave();
    await clock.advanceAsync(50);
    expect(ben.getRiders()).toEqual([]);
    expect(ben.getPeers()).toEqual([]);
    expect(changes).toBeGreaterThan(0);
    expect(anna.hasLeft).toBe(true);
  });

  it('riders on the same route are placed by route position, not by ridden distance', async () => {
    const { clock, anna, ben } = await setup();
    const shape = { lengthM: 97_600, loop: true };
    // Anna rode 1 km from km 40 (she started there); Ben rode 40 km from the start.
    anna.setLocalState({
      ...local(1000, 10),
      route: { id: 'isar-ursprung', m: 41_000 },
      routeShape: shape,
    });
    ben.setLocalState({
      ...local(40_000, 10),
      route: { id: 'isar-ursprung', m: 40_000 },
      routeShape: shape,
    });
    await clock.advanceAsync(1000);
    const [annaSeenByBen] = ben.getRiders();
    // 1 km ahead on the road, although she has ridden 39 km less.
    expect(annaSeenByBen?.sameRoute).toBe(true);
    expect(annaSeenByBen?.gapM).toBeCloseTo(1000, 0);
    expect(annaSeenByBen?.distanceM).toBeCloseTo(1010, 0); // ridden distance is still reported
    expect(anna.getRiders()[0]?.gapM).toBeCloseTo(-1000, 0);

    // Anna jumps to km 40.0: now they ride side by side.
    anna.setLocalState({
      ...local(1010, 10),
      route: { id: 'isar-ursprung', m: 40_010 },
      routeShape: shape,
    });
    await clock.advanceAsync(500);
    expect(Math.abs(ben.getRiders()[0]!.gapM)).toBeLessThan(3);

    // A rider on another route (or without one) falls back to ridden distance.
    ben.setLocalState({
      ...local(40_015, 10),
      route: { id: 'other-route', m: 5 },
      routeShape: shape,
    });
    await clock.advanceAsync(500);
    const [byDistance] = ben.getRiders();
    expect(byDistance?.sameRoute).toBeUndefined();
    expect(byDistance!.gapM).toBeLessThan(-38_000); // ~39 km behind by ridden distance
  });

  it('rejects invalid local state and invalid room codes', async () => {
    const { anna } = await setup();
    expect(anna.setLocalState({ ...local(1), powerW: Number.NaN })).toBe(false);
    expect(anna.setLocalState(local(1))).toBe(true);
    await expect(
      GroupRide.join('0OIL!!', 'X', { signalling: new InMemorySignallingHub().createChannel() }),
    ).rejects.toMatchObject({ code: 'invalid-room' });
  });
});

describe('GroupRide end-to-end (real signalling server, fake WebRTC)', () => {
  let server: SignallingServer | null = null;
  const rides: GroupRide[] = [];

  afterEach(async () => {
    for (const r of rides.splice(0)) r.leave();
    await server?.close();
    server = null;
  });

  it('three riders see each other; a rider who leaves disappears', async () => {
    const started = await startServer();
    server = started.server;
    const network = new FakeRtcNetwork();
    const deps = {
      signallingUrl: started.url,
      createWebSocket: wsFactory(),
      createPeerConnection: network.createPeerConnection,
    };
    const anna = await GroupRide.create('Anna', deps);
    rides.push(anna);
    expect(anna.joinLink).toBe(
      `freilauf://join/${anna.roomCode}?s=${encodeURIComponent(started.url)}`,
    );
    const ben = await GroupRide.join(anna.roomCode, 'Ben', deps);
    const cleo = await GroupRide.join(anna.roomCode, 'Cleo', deps);
    rides.push(ben, cleo);

    anna.setLocalState(local(1200, 0));
    ben.setLocalState(local(1000, 0));
    cleo.setLocalState(local(1100, 0));

    const names = (r: GroupRide) => r.getRiders().map((x) => x.name);
    await expect.poll(() => names(anna), { timeout: 5000 }).toEqual(['Cleo', 'Ben']);
    await expect.poll(() => names(ben), { timeout: 5000 }).toEqual(['Anna', 'Cleo']);
    await expect.poll(() => names(cleo), { timeout: 5000 }).toEqual(['Anna', 'Ben']);
    expect(ben.getRiders().map((r) => r.gapM)).toEqual([200, 100]);
    for (const r of [anna, ben, cleo]) {
      expect(r.getPeers().map((p) => p.status)).toEqual(['connected', 'connected']);
    }

    cleo.leave();
    await expect.poll(() => names(anna), { timeout: 5000 }).toEqual(['Ben']);
    await expect.poll(() => names(ben), { timeout: 5000 }).toEqual(['Anna']);
    expect(anna.getPeers().map((p) => p.peerId)).toEqual([ben.localPeerId]);
  });

  it('reports a full room', async () => {
    const started = await startServer({ maxPeersPerRoom: 2 });
    server = started.server;
    const network = new FakeRtcNetwork();
    const deps = {
      signallingUrl: started.url,
      createWebSocket: wsFactory(),
      createPeerConnection: network.createPeerConnection,
    };
    const a = await GroupRide.create('A', deps);
    const b = await GroupRide.join(a.roomCode, 'B', deps);
    rides.push(a, b);
    await expect(GroupRide.join(a.roomCode, 'C', deps)).rejects.toMatchObject({
      code: 'room-full',
    });
  });
});
