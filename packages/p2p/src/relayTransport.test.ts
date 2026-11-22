import { describe, expect, it } from 'vitest';
import { GroupRide, type GroupRideDeps } from './group';
import { DEFAULT_ICE_SERVERS } from './ice';
import { generateInviteSecret, isValidInviteSecret, parseInvite } from './roomCode';
import { FakeClock, FakeTrysteroNetwork } from './testing';
import type { TransportLog } from './transport';
import {
  DEFAULT_RELAY_URLS,
  FREILAUF_APP_ID,
  MAX_PENDING_SENDS,
  RELAY_CONNECT_TIMEOUT_MS,
  RelayTransport,
  type TrysteroActionLike,
  type TrysteroModuleLike,
  type TrysteroRoomLike,
} from './transports/relay';

function world(options: { seed?: number } = {}) {
  const clock = new FakeClock();
  const net = new FakeTrysteroNetwork({ timers: clock.timers, now: clock.now, seed: options.seed });
  const deps = (peerId: string, relay: GroupRideDeps['relay'] = {}): GroupRideDeps => ({
    relay: { trystero: net.moduleFor(peerId), ...relay },
    now: clock.now,
    timers: clock.timers,
  });
  return { clock, net, deps };
}

describe('relay transport (fake Trystero)', () => {
  it('joins with the Freilauf app id, the secret as password and the pinned relays', async () => {
    const { clock, net, deps } = world();
    const anna = await GroupRide.create('Anna', deps('peer-a'));
    expect(anna.transport).toBe('relays');
    expect(isValidInviteSecret(anna.roomCode, anna.secret)).toBe(true);
    expect(net.configs).toEqual([
      {
        peerId: 'peer-a',
        roomId: anna.roomCode,
        config: {
          appId: FREILAUF_APP_ID,
          password: anna.secret,
          identity: 'none',
          maxUsers: 8,
          maxReceiveBytes: 64 * 1024,
          relayConfig: { urls: [...DEFAULT_RELAY_URLS], redundancy: DEFAULT_RELAY_URLS.length },
          rtcConfig: { iceServers: DEFAULT_ICE_SERVERS },
        },
      },
    ]);
    // The invite carries code and secret; both forms parse back to the same room.
    expect(anna.joinLink).toBe(`freilauf://join/${anna.roomCode}#${anna.secret}`);
    expect(anna.inviteCode).toMatch(
      /^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/,
    );
    for (const text of [anna.joinLink, anna.inviteCode]) {
      expect(parseInvite(text)).toEqual({
        ok: true,
        invite: { roomCode: anna.roomCode, secret: anna.secret },
      });
    }
    await clock.advanceAsync(300);
    expect(anna.signallingState).toBe('joined');
    anna.leave();
  });

  it('uses custom relays (all of them) and ICE servers', async () => {
    const { net, deps } = world();
    const relayUrls = ['wss://a.example', 'wss://b.example', 'wss://c.example'];
    const iceServers = [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }];
    const ride = await GroupRide.create('A', { ...deps('p', { relayUrls }), iceServers });
    expect(net.configs[0]?.config.relayConfig).toEqual({ urls: relayUrls, redundancy: 3 });
    expect(net.configs[0]?.config.rtcConfig).toEqual({ iceServers });
    ride.leave();
  });

  it('rejects a missing or mistyped secret before touching the network', async () => {
    const { net, deps } = world();
    await expect(GroupRide.join('ABCDEF', 'B', deps('p'))).rejects.toMatchObject({
      code: 'invalid-secret',
    });
    await expect(
      GroupRide.join('ABCDEF', 'B', deps('p', { secret: 'ABCDEFGHJKMN' })),
    ).rejects.toMatchObject({ code: 'invalid-secret' });
    expect(net.configs).toEqual([]);
  });

  it('two riders find each other, learn names from the hello, and see each other leave', async () => {
    const { clock, deps } = world();
    const anna = await GroupRide.create('Anna', deps('peer-a'));
    const ben = await GroupRide.join(anna.roomCode, 'Ben', deps('peer-b', { secret: anna.secret }));
    const joined: string[] = [];
    ben.onPeerJoined((p) => joined.push(`${p.peerId}:${p.name}`));
    await clock.advanceAsync(100);
    expect(anna.getPeers()).toEqual([
      { peerId: 'peer-b', name: 'Ben', status: 'connected', isOfferer: false, attempts: 0 },
    ]);
    expect(ben.getPeers().map((p) => p.name)).toEqual(['Anna']);
    expect(joined).toEqual(['peer-a:Rider']); // before the name is known
    anna.setLocalState({
      distanceM: 10,
      speedMps: 5,
      powerW: 150,
      cadenceRpm: 80,
      heartRateBpm: null,
      gear: 3,
    });
    await clock.advanceAsync(300);
    expect(ben.getRiders().map((r) => r.name)).toEqual(['Anna']);
    anna.leave();
    await clock.advanceAsync(50);
    expect(ben.getPeers()).toEqual([]);
    expect(ben.getRiders()).toEqual([]);
    ben.leave();
  });

  it('announces a peer before delivering its first message, even if it arrives before onPeerJoin', async () => {
    const { clock, net, deps } = world();
    net.conditions.joinSkewMs = 500;
    const anna = await GroupRide.create('Anna', deps('peer-a'));
    const order: string[] = [];
    anna.onPeerJoined(({ peerId }) => order.push(`joined ${peerId}`));
    anna.onChange(() => {
      if (anna.getRiders().length > 0 && !order.includes('state')) order.push('state');
    });
    const ben = await GroupRide.join(anna.roomCode, 'Ben', deps('peer-b', { secret: anna.secret }));
    ben.setLocalState({
      distanceM: 1,
      speedMps: 1,
      powerW: 1,
      cadenceRpm: 1,
      heartRateBpm: 1,
      gear: 1,
    });
    await clock.advanceAsync(400); // Anna's onPeerJoin(Ben) is still 100 ms away
    expect(order).toEqual(['joined peer-b', 'state']);
    expect(anna.getPeers().map((p) => p.name)).toEqual(['Ben']);
    await clock.advanceAsync(400);
    expect(order).toEqual(['joined peer-b', 'state']); // not announced twice
    anna.leave();
    ben.leave();
  });

  it('no relay reachable (fast failure): the ride ends with no-relay and logs the relays', async () => {
    const { clock, net, deps } = world();
    net.relaysReachable = false;
    net.relaysFailFast = false;
    const logs: TransportLog[] = [];
    const ride = await GroupRide.create('Anna', deps('peer-a'));
    ride.onLog((l) => logs.push(l));
    const failures: string[] = [];
    ride.onFailure((f) => failures.push(f.code));
    expect(ride.signallingState).toBe('connecting');
    // Every relay's first connection attempt fails: Trystero reports `relay-failed`.
    for (const room of net.members(ride.roomCode)) {
      room.emitError({ code: 'relay-failed', message: 'all signaling relays failed' });
    }
    expect(failures).toEqual(['no-relay']);
    expect(ride.hasLeft).toBe(true);
    expect(ride.failure?.code).toBe('no-relay');
    const last = logs.find((l) => l.message === 'giving up: no-relay');
    expect(last?.data?.['relaysNotOpen']).toEqual(DEFAULT_RELAY_URLS.map((u) => u.slice(6)));
    await clock.advanceAsync(10);
  });

  it('a relay failure while still starting rejects the join with no-relay', async () => {
    const { net, deps } = world();
    net.relaysReachable = false; // the fake reports relay-failed on the next microtask
    await expect(GroupRide.create('Anna', deps('peer-a'))).rejects.toMatchObject({
      code: 'no-relay',
    });
  });

  it('no relay reachable (connections hang): gives up after the timeout, not before', async () => {
    const { clock, net, deps } = world();
    net.relaysReachable = false;
    net.relaysFailFast = false;
    const ride = await GroupRide.create('Anna', deps('peer-a'));
    const failures: string[] = [];
    ride.onFailure((f) => failures.push(f.code));
    await clock.advanceAsync(RELAY_CONNECT_TIMEOUT_MS - 100, 50);
    expect(failures).toEqual([]);
    expect(ride.signallingState).toBe('connecting');
    await clock.advanceAsync(200, 50);
    expect(failures).toEqual(['no-relay']);
  });

  it('a relay that comes up in time: joined, then reconnecting when all are lost', async () => {
    const { clock, net, deps } = world();
    net.relaysReachable = false;
    net.relaysFailFast = false;
    const ride = await GroupRide.create('Anna', deps('peer-a'));
    await clock.advanceAsync(5_000, 50);
    net.restoreRelays();
    await clock.advanceAsync(300, 50);
    expect(ride.signallingState).toBe('joined');
    await clock.advanceAsync(RELAY_CONNECT_TIMEOUT_MS, 250);
    expect(ride.hasLeft).toBe(false);
    net.relaysReachable = false;
    await clock.advanceAsync(300, 50);
    expect(ride.signallingState).toBe('reconnecting');
    expect(ride.hasLeft).toBe(false);
    net.relaysReachable = true;
    await clock.advanceAsync(300, 50);
    expect(ride.signallingState).toBe('joined');
    ride.leave();
  });

  it('a different secret: nobody connects, both sides report secret-mismatch', async () => {
    const { clock, deps } = world();
    const anna = await GroupRide.create('Anna', deps('peer-a'));
    const mallory = await GroupRide.create('M', deps('peer-m'));
    // Same room code, another (valid) secret.
    const ben = await GroupRide.join(anna.roomCode, 'Ben', deps('peer-b', { secret: anna.secret }));
    await clock.advanceAsync(100);
    const wrong = await GroupRide.join(
      anna.roomCode,
      'Wrong',
      deps('peer-w', { secret: secretFor(anna.roomCode, anna.secret) }),
    );
    await clock.advanceAsync(100);
    expect(wrong.getPeers()).toEqual([]);
    expect(wrong.getProblems().map((p) => p.code)).toEqual(['secret-mismatch']);
    expect(anna.getProblems().map((p) => [p.code, p.peerId])).toEqual([
      ['secret-mismatch', 'peer-w'],
    ]);
    expect(anna.getPeers().map((p) => p.peerId)).toEqual(['peer-b']);
    // Problems expire after a minute.
    await clock.advanceAsync(61_000, 1_000);
    expect(anna.getProblems()).toEqual([]);
    for (const r of [anna, mallory, ben, wrong]) r.leave();
  });

  it('no direct path: peer-unreachable', async () => {
    const { clock, net, deps } = world();
    net.blockDirect = true;
    const anna = await GroupRide.create('Anna', deps('peer-a'));
    const ben = await GroupRide.join(anna.roomCode, 'Ben', deps('peer-b', { secret: anna.secret }));
    await clock.advanceAsync(100);
    expect(anna.getPeers()).toEqual([]);
    expect(ben.getProblems()).toMatchObject([{ code: 'peer-unreachable', peerId: 'peer-a' }]);
  });

  it('a ninth rider is turned away with room-full', async () => {
    const { clock, deps } = world();
    const first = await GroupRide.create('R0', deps('peer-0'));
    const rides = [first];
    for (let i = 1; i < 8; i++) {
      rides.push(
        await GroupRide.join(first.roomCode, `R${i}`, deps(`peer-${i}`, { secret: first.secret })),
      );
      await clock.advanceAsync(20);
    }
    expect(first.getPeers()).toHaveLength(7);
    const ninth = await GroupRide.join(
      first.roomCode,
      'R8',
      deps('peer-8', { secret: first.secret }),
    );
    const failures: string[] = [];
    ninth.onFailure((f) => failures.push(f.code));
    await clock.advanceAsync(50);
    expect(failures).toEqual(['room-full']);
    expect(first.getPeers()).toHaveLength(7);
  });

  it('a relay library that cannot be loaded rejects the join', async () => {
    const { clock } = world();
    const promise = GroupRide.create('A', {
      relay: { trystero: () => Promise.reject(new Error('chunk failed')) },
      now: clock.now,
      timers: clock.timers,
    });
    await expect(promise).rejects.toMatchObject({ code: 'relay-unavailable' });
  });
});

describe('RelayTransport limits', () => {
  /** A Trystero stand-in whose sends never complete (a congested channel). */
  function stuckModule() {
    const handlers: {
      join?: (c: { peerId: string }) => unknown;
      msg?: (d: unknown, c: { peerId: string }) => unknown;
      gate?: (c: { peerId: string; byteLength: number }) => boolean;
    } = {};
    let sends = 0;
    const action = (ns: string): TrysteroActionLike => ({
      send: () => {
        sends++;
        return new Promise<void>(() => {});
      },
      onMessage: (h) => {
        if (ns === 'fl-msg') handlers.msg = h;
        return () => {};
      },
      onReceive: (h) => {
        if (ns === 'fl-msg') handlers.gate = h;
        return () => {};
      },
    });
    const room: TrysteroRoomLike = {
      makeAction: action,
      onPeerJoin: (h) => {
        handlers.join = h;
        return () => {};
      },
      onPeerLeave: () => () => {},
      onError: () => () => {},
      getSelf: () => Promise.resolve({ peerId: 'self' }),
      leave: () => Promise.resolve(),
    };
    const mod: TrysteroModuleLike = { joinRoom: () => room };
    return { mod, handlers, sends: () => sends };
  }

  it('stops queueing behind a congested peer and drops oversize messages', async () => {
    const clock = new FakeClock();
    const { mod, handlers, sends } = stuckModule();
    const t = new RelayTransport({
      secret: 'x',
      trystero: mod,
      timers: clock.timers,
      now: clock.now,
    });
    const received: string[] = [];
    t.on('message', (m) => received.push(m.data));
    await t.start('ABCDEF', 'Me');
    handlers.join?.({ peerId: 'other' });
    const helloSends = sends();
    let accepted = 0;
    for (let i = 0; i < MAX_PENDING_SENDS + 10; i++) if (t.send('other', `m${i}`)) accepted++;
    expect(accepted).toBe(MAX_PENDING_SENDS);
    expect(sends() - helloSends).toBe(MAX_PENDING_SENDS);
    expect(t.send('nobody', 'x')).toBe(false);
    // Incoming: the size gate and the string check.
    expect(handlers.gate?.({ peerId: 'other', byteLength: 16 * 1024 })).toBe(true);
    expect(handlers.gate?.({ peerId: 'other', byteLength: 16 * 1024 + 1 })).toBe(false);
    handlers.msg?.({ not: 'a string' }, { peerId: 'other' });
    handlers.msg?.('ok', { peerId: 'other' });
    expect(received).toEqual(['ok']);
    t.close();
  });

  it('refuses to send a message over 16 KiB', async () => {
    const clock = new FakeClock();
    const net = new FakeTrysteroNetwork({ timers: clock.timers, now: clock.now });
    const a = new RelayTransport({
      secret: 's',
      trystero: net.moduleFor('a'),
      timers: clock.timers,
      now: clock.now,
    });
    const b = new RelayTransport({
      secret: 's',
      trystero: net.moduleFor('b'),
      timers: clock.timers,
      now: clock.now,
    });
    await a.start('ABCDEF', 'A');
    await b.start('ABCDEF', 'B');
    await clock.advanceAsync(50);
    expect(a.send('b', 'x'.repeat(16 * 1024))).toBe(true);
    expect(a.send('b', '€'.repeat(6_000))).toBe(false); // 18 000 bytes
    a.close();
    b.close();
  });
});

describe('pinned relays', () => {
  it('are all part of the relay list the installed Trystero ships', async () => {
    const mod = (await import('trystero')) as unknown as { defaultRelayUrls: string[] };
    for (const url of DEFAULT_RELAY_URLS) expect(mod.defaultRelayUrls).toContain(url);
  });
});

/** Another valid secret for the same code (differs from `not`). */
function secretFor(code: string, not: string): string {
  let i = 0;
  for (;;) {
    const bytes = (n: number) => Uint8Array.from({ length: n }, (_, k) => (k * 7 + i * 13) % 248);
    i++;
    const s = generateInviteSecret(code, bytes);
    if (s !== not) return s;
  }
}
