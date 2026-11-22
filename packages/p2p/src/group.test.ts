import { afterEach, describe, expect, it } from 'vitest';
import type { SignallingServer } from '@freilauf/signalling';
import { GroupRide, type LocalRiderState } from './group';
import { FakeClock, FakeRtcNetwork, InMemorySignallingHub } from './testing';
import { startServer, wsFactory } from './testing/wsTestUtils';

function local(distanceM: number, speedMps = 10): LocalRiderState {
  return { distanceM, speedMps, powerW: 200, cadenceRpm: 90, heartRateBpm: null, gear: 11 };
}

describe('GroupRide (in-memory signalling, fake clock)', () => {
  async function setup() {
    const clock = new FakeClock();
    const hub = new InMemorySignallingHub();
    const network = new FakeRtcNetwork();
    const deps = (peerId: string) => ({
      signalling: hub.createChannel(peerId),
      createPeerConnection: network.createPeerConnection,
      now: clock.now,
      timers: clock.timers,
    });
    const anna = await GroupRide.create('Anna', deps('peer-a'));
    const ben = await GroupRide.join(anna.roomCode.toLowerCase(), 'Ben', deps('peer-b'));
    await clock.advanceAsync(50);
    return { clock, network, anna, ben };
  }

  it('broadcasts at 4 Hz and exposes extrapolated riders with gaps', async () => {
    const { clock, network, anna, ben } = await setup();
    expect(anna.getPeers().map((p) => p.status)).toEqual(['connected']);
    anna.setLocalState(local(1000, 10));
    ben.setLocalState(local(990, 8));
    await clock.advanceAsync(1000);

    const channel = network.connections[0]?.channels[0];
    expect(channel?.sent.length).toBeGreaterThanOrEqual(4);
    expect(channel?.sent.length).toBeLessThanOrEqual(5);

    const [seenByBen] = ben.getRiders();
    expect(seenByBen).toMatchObject({ peerId: 'peer-a', name: 'Anna', stale: false });
    // One second later: Anna is at 1000 + 10 m/s * 1 s, Ben at 990 + 8 m/s * 1 s.
    expect(seenByBen?.distanceM).toBeCloseTo(1010, 0);
    expect(seenByBen?.gapM).toBeCloseTo(1010 - 998, 0);
    const [seenByAnna] = anna.getRiders();
    expect(seenByAnna?.distanceM).toBeCloseTo(998, 0);
    expect(seenByAnna?.gapM).toBeCloseTo(-12, 0);
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
    expect(changes).toBeGreaterThan(0);
    expect(anna.hasLeft).toBe(true);
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
