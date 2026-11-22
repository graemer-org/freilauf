import { afterEach, describe, expect, it } from 'vitest';
import type { SignallingServer } from '@freilauf/signalling';
import { startServer, wsFactory } from '../testing/wsTestUtils';
import { SignallingError, type SignallingEvents } from './channel';
import { WebSocketSignalling, type WebSocketSignallingOptions } from './websocket';

let server: SignallingServer | null = null;
const channels: WebSocketSignalling[] = [];

afterEach(async () => {
  for (const c of channels.splice(0)) c.leave();
  await server?.close();
  server = null;
});

async function setup() {
  const started = await startServer();
  server = started.server;
  return started.url;
}

function channel(url: string, peerId: string, extra: Partial<WebSocketSignallingOptions> = {}) {
  const c = new WebSocketSignalling({ url, peerId, createWebSocket: wsFactory(), ...extra });
  channels.push(c);
  return c;
}

function nextEvent<K extends keyof SignallingEvents>(
  c: WebSocketSignalling,
  event: K,
): Promise<SignallingEvents[K]> {
  return new Promise((resolve) => {
    const off = c.on(event, (v) => {
      off();
      resolve(v);
    });
  });
}

describe('WebSocketSignalling + signalling server', () => {
  it('joins, lists peers, announces newcomers and relays signals', async () => {
    const url = await setup();
    const a = channel(url, 'peer-a');
    expect(await a.join('ROOM42', 'Anna')).toEqual([]);
    expect(a.state).toBe('joined');

    const b = channel(url, 'peer-b');
    const joinedA = nextEvent(a, 'peer-joined');
    const peersB = nextEvent(b, 'peers');
    expect(await b.join('ROOM42', 'Ben')).toEqual([{ peerId: 'peer-a', name: 'Anna' }]);
    expect(await peersB).toEqual([{ peerId: 'peer-a', name: 'Anna' }]);
    expect(await joinedA).toEqual({ peerId: 'peer-b', name: 'Ben' });

    const got = nextEvent(b, 'signal');
    expect(a.sendSignal('peer-b', { kind: 'offer', sdp: 'v=0' })).toBe(true);
    expect(await got).toEqual({ from: 'peer-a', data: { kind: 'offer', sdp: 'v=0' } });
  });

  it('sanitises the name before joining', async () => {
    const url = await setup();
    const a = channel(url, 'peer-a');
    await a.join('ROOM42', '\u0000' + 'x'.repeat(40));
    const b = channel(url, 'peer-b');
    const [peer] = await b.join('ROOM42', 'Ben');
    expect(peer?.name).toBe('x'.repeat(24));
  });

  it('rejects a full room with a clear error and does not reconnect', async () => {
    const url = await setup();
    for (let i = 0; i < 8; i++) await channel(url, `peer-${i}`).join('FULL01', `R${i}`);
    const ninth = channel(url, 'peer-9');
    const closed = nextEvent(ninth, 'closed');
    const err = await ninth.join('FULL01', 'Nine').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignallingError);
    expect((err as SignallingError).code).toBe('room-full');
    expect((err as SignallingError).message).toMatch(/full/);
    expect(await closed).toEqual({ reason: 'room-full' });
    expect(ninth.state).toBe('closed');
  });

  it('announces leave to the others', async () => {
    const url = await setup();
    const a = channel(url, 'peer-a');
    const b = channel(url, 'peer-b');
    await a.join('ROOM42', 'Anna');
    await b.join('ROOM42', 'Ben');
    const left = nextEvent(a, 'peer-left');
    const closed = nextEvent(b, 'closed');
    b.leave();
    expect(await left).toEqual({ peerId: 'peer-b' });
    expect(await closed).toEqual({ reason: 'left' });
    expect(b.sendSignal('peer-a', 1)).toBe(false);
  });

  it('reports invalid input', async () => {
    const url = await setup();
    const bad = channel(url, 'peer-a');
    await expect(bad.join('no spaces!', 'x')).rejects.toMatchObject({ code: 'invalid-room' });
    const badId = channel(url, '!');
    await expect(badId.join('ROOM42', 'x')).rejects.toMatchObject({ code: 'invalid-peer-id' });

    const a = channel(url, 'peer-b');
    await a.join('ROOM42', 'Anna');
    const error = nextEvent(a, 'error');
    a.sendSignal('peer-zzz', 1);
    expect(await error).toMatchObject({ code: 'unknown-peer', fatal: false });
    expect(a.state).toBe('joined');
  });

  it('reconnects with backoff and re-joins with the same peer id', async () => {
    const url = await setup();
    const factory = wsFactory();
    const a = channel(url, 'peer-a', {
      createWebSocket: factory,
      reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
    });
    const b = channel(url, 'peer-b');
    await a.join('ROOM42', 'Anna');
    await b.join('ROOM42', 'Ben');

    const states: string[] = [];
    a.on('state', (s) => states.push(s));
    const rejoined = nextEvent(a, 'peers');
    factory.sockets[0]?.terminate();
    expect(await rejoined).toEqual([{ peerId: 'peer-b', name: 'Ben' }]);
    expect(states).toEqual(['reconnecting', 'joined']);
    expect(factory.sockets).toHaveLength(2);

    const got = nextEvent(a, 'signal');
    b.sendSignal('peer-a', 'still there?');
    expect(await got).toEqual({ from: 'peer-b', data: 'still there?' });
  });

  it('gives up joining after the join timeout', async () => {
    const url = await setup();
    await server?.close();
    server = null;
    const a = channel(url, 'peer-a', {
      joinTimeoutMs: 150,
      reconnect: { initialDelayMs: 20, maxDelayMs: 40 },
    });
    await expect(a.join('ROOM42', 'Anna')).rejects.toMatchObject({ code: 'join-timeout' });
    expect(a.state).toBe('closed');
  });
});
