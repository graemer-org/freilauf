import { describe, expect, it } from 'vitest';
import { PeerMesh, type PeerStatus } from './mesh';
import { FakeClock, FakeRtcNetwork, InMemorySignallingHub } from './testing';

async function setupMesh(ids: string[]) {
  const clock = new FakeClock();
  const hub = new InMemorySignallingHub();
  const network = new FakeRtcNetwork();
  const nodes = ids.map((id) => {
    const signalling = hub.createChannel(id);
    const mesh = new PeerMesh({
      signalling,
      createPeerConnection: network.createPeerConnection,
      timers: clock.timers,
    });
    const inbox: Array<{ peerId: string; data: string }> = [];
    const statuses: Array<[string, PeerStatus]> = [];
    mesh.on('message', (m) => inbox.push(m));
    mesh.on('status', ({ peerId, status }) => statuses.push([peerId, status]));
    return { id, signalling, mesh, inbox, statuses };
  });
  for (const n of nodes) await n.signalling.join('ROOM42', n.id.toUpperCase());
  await clock.advanceAsync(50);
  return { clock, hub, network, nodes };
}

const statusesOf = (mesh: PeerMesh) =>
  Object.fromEntries(mesh.getPeers().map((p) => [p.peerId, p.status]));

describe('PeerMesh', () => {
  it('connects a full mesh with one offerer per pair', async () => {
    const { network, nodes } = await setupMesh(['peer-b', 'peer-a', 'peer-c']);
    for (const n of nodes) {
      expect(Object.values(statusesOf(n.mesh))).toEqual(['connected', 'connected']);
    }
    // 3 pairs -> exactly 6 peer connections (no glare duplicates).
    expect(network.connections).toHaveLength(6);
    const [b, a] = nodes;
    expect(a?.mesh.getPeers().find((p) => p.peerId === 'peer-b')?.isOfferer).toBe(true);
    expect(b?.mesh.getPeers().find((p) => p.peerId === 'peer-a')?.isOfferer).toBe(false);
    expect(network.connections[0]?.config.iceServers[0]?.urls).toBe('stun:stun.l.google.com:19302');
  });

  it('delivers messages over the data channel', async () => {
    const { clock, nodes } = await setupMesh(['peer-a', 'peer-b', 'peer-c']);
    const [a, b, c] = nodes;
    expect(a?.mesh.broadcast('hello')).toBe(2);
    expect(c?.mesh.send('peer-b', 'just b')).toBe(true);
    await clock.advanceAsync(10);
    expect(b?.inbox).toEqual([
      { peerId: 'peer-a', data: 'hello' },
      { peerId: 'peer-c', data: 'just b' },
    ]);
    expect(c?.inbox).toEqual([{ peerId: 'peer-a', data: 'hello' }]);
  });

  it('tears down and re-offers after a connection failure', async () => {
    const { clock, network, nodes } = await setupMesh(['peer-a', 'peer-b']);
    const [a, b] = nodes;
    const pc = network.open[0];
    if (!pc) throw new Error('no connection');
    network.fail(pc);
    await clock.advanceAsync(10);
    expect(a?.mesh.getStatus('peer-b')).toBe('failed');
    expect(b?.mesh.getStatus('peer-a')).toBe('failed');
    await clock.advanceAsync(1100); // first retry after 1 s
    expect(a?.mesh.getStatus('peer-b')).toBe('connected');
    expect(b?.mesh.getStatus('peer-a')).toBe('connected');
    expect(network.connections).toHaveLength(4);
    expect(network.open).toHaveLength(2);
    expect(a?.statuses.map(([, s]) => s)).toEqual([
      'connecting',
      'connected',
      'failed',
      'connecting',
      'connected',
    ]);
  });

  it('times out a stuck attempt and retries with backoff', async () => {
    const clock = new FakeClock();
    const hub = new InMemorySignallingHub();
    const network = new FakeRtcNetwork();
    network.blockConnectivity = true;
    const make = (id: string) => {
      const signalling = hub.createChannel(id);
      const mesh = new PeerMesh({
        signalling,
        createPeerConnection: network.createPeerConnection,
        timers: clock.timers,
        connectTimeoutMs: 5_000,
      });
      return { signalling, mesh };
    };
    const a = make('peer-a');
    const b = make('peer-b');
    await a.signalling.join('ROOM42', 'A');
    await b.signalling.join('ROOM42', 'B');
    await clock.advanceAsync(4_900, 100);
    expect(a.mesh.getStatus('peer-b')).toBe('connecting');
    await clock.advanceAsync(200, 100);
    expect(a.mesh.getStatus('peer-b')).toBe('failed');
    network.blockConnectivity = false;
    await clock.advanceAsync(1_100, 100);
    expect(a.mesh.getStatus('peer-b')).toBe('connected');
    expect(a.mesh.getPeers()[0]?.attempts).toBe(0);
  });

  it('removes a peer that leaves and stops retrying', async () => {
    const { clock, network, nodes } = await setupMesh(['peer-a', 'peer-b', 'peer-c']);
    const [a, b, c] = nodes;
    const left: string[] = [];
    a?.mesh.on('peer-left', ({ peerId }) => left.push(peerId));
    c?.mesh.close();
    c?.signalling.leave();
    await clock.advanceAsync(5_000, 100);
    expect(left).toEqual(['peer-c']);
    expect(Object.keys(statusesOf(a!.mesh))).toEqual(['peer-b']);
    expect(Object.keys(statusesOf(b!.mesh))).toEqual(['peer-a']);
    expect(network.open).toHaveLength(2);
    expect(clock.pendingTimers).toBe(0);
  });
});
