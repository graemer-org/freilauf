import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  createSignallingServer,
  type SignallingServer,
  type SignallingServerOptions,
} from './server.ts';
import type { ServerMessage } from './protocol.ts';

let server: SignallingServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
});

async function start(options: SignallingServerOptions = {}): Promise<SignallingServer> {
  server = await createSignallingServer({ port: 0, host: '127.0.0.1', ...options });
  return server;
}

interface TestClient {
  socket: WebSocket;
  send(msg: unknown): void;
  next(): Promise<ServerMessage>;
  closed: Promise<number>;
}

async function connect(port: number, path = ''): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  sockets.push(socket);
  const inbox: ServerMessage[] = [];
  const waiters: Array<(m: ServerMessage) => void> = [];
  socket.on('message', (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage;
    const w = waiters.shift();
    if (w) w(msg);
    else inbox.push(msg);
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    send: (msg) => socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next: () => {
      const m = inbox.shift();
      return m ? Promise.resolve(m) : new Promise((resolve) => waiters.push(resolve));
    },
    closed,
  };
}

async function joined(port: number, room: string, peerId: string, name = peerId) {
  const c = await connect(port);
  c.send({ type: 'join', room, peerId, name });
  const reply = await c.next();
  expect(reply.type).toBe('joined');
  return { client: c, reply };
}

describe('signalling server', () => {
  it('replies with the peer list and notifies others', async () => {
    const { port } = await start();
    const a = await joined(port, 'ROOM42', 'peer-a', 'Anna');
    expect(a.reply).toEqual({ type: 'joined', room: 'ROOM42', peerId: 'peer-a', peers: [] });
    const b = await joined(port, 'ROOM42', 'peer-b', 'Ben');
    expect(b.reply).toMatchObject({ peers: [{ peerId: 'peer-a', name: 'Anna' }] });
    expect(await a.client.next()).toEqual({
      type: 'peer-joined',
      peer: { peerId: 'peer-b', name: 'Ben' },
    });
  });

  it('relays signals only to the target in the same room', async () => {
    const { port } = await start();
    const a = await joined(port, 'ROOM42', 'peer-a');
    const b = await joined(port, 'ROOM42', 'peer-b');
    await a.client.next(); // peer-joined
    a.client.send({ type: 'signal', to: 'peer-b', data: { sdp: 'x' } });
    expect(await b.client.next()).toEqual({ type: 'signal', from: 'peer-a', data: { sdp: 'x' } });

    const other = await joined(port, 'OTHER1', 'peer-c');
    other.client.send({ type: 'signal', to: 'peer-a', data: 1 });
    expect(await other.client.next()).toMatchObject({ type: 'error', code: 'unknown-peer' });
  });

  it('rejects a ninth peer with room-full', async () => {
    const { port } = await start();
    for (let i = 0; i < 8; i++) await joined(port, 'FULL01', `peer-${i}`);
    const c = await connect(port);
    c.send({ type: 'join', room: 'FULL01', peerId: 'peer-9', name: 'Nine' });
    const msg = await c.next();
    expect(msg).toMatchObject({ type: 'error', code: 'room-full' });
    expect(msg.type === 'error' && msg.message).toContain('full');
  });

  it('validates input', async () => {
    const { port } = await start();
    const c = await connect(port);
    c.send('not json');
    expect(await c.next()).toMatchObject({ code: 'invalid-message' });
    c.send({ type: 'nope' });
    expect(await c.next()).toMatchObject({ code: 'invalid-message' });
    c.send({ type: 'join', room: 'a b', peerId: 'peer-a', name: 'x' });
    expect(await c.next()).toMatchObject({ code: 'invalid-room' });
    c.send({ type: 'join', room: 'ROOM42', peerId: '!', name: 'x' });
    expect(await c.next()).toMatchObject({ code: 'invalid-peer-id' });
    c.send({ type: 'join', room: 'ROOM42', peerId: 'peer-a', name: 'x'.repeat(25) });
    expect(await c.next()).toMatchObject({ code: 'invalid-name' });
    c.send({ type: 'signal', to: 'peer-b', data: 1 });
    expect(await c.next()).toMatchObject({ code: 'not-joined' });
    c.send({ type: 'signal', to: 'peer-b', data: 'x'.repeat(70 * 1024) });
    expect(await c.next()).toMatchObject({ code: 'message-too-large' });
    // still usable afterwards
    c.send({ type: 'join', room: 'ROOM42', peerId: 'peer-a', name: 'Anna' });
    expect(await c.next()).toMatchObject({ type: 'joined' });
    c.send({ type: 'join', room: 'ROOM42', peerId: 'peer-a', name: 'Anna' });
    expect(await c.next()).toMatchObject({ code: 'already-joined' });
  });

  it('closes sockets far above the size limit', async () => {
    const { port } = await start({ maxMessageBytes: 1024 });
    const c = await connect(port);
    c.send('x'.repeat(4096));
    expect(await c.closed).toBe(1009);
  });

  it('announces leave and deletes empty rooms', async () => {
    const srv = await start();
    const a = await joined(srv.port, 'ROOM42', 'peer-a');
    const b = await joined(srv.port, 'ROOM42', 'peer-b');
    await a.client.next();
    expect(srv.roomCount()).toBe(1);
    b.client.send({ type: 'leave' });
    expect(await a.client.next()).toEqual({ type: 'peer-left', peerId: 'peer-b' });
    a.client.socket.close();
    await a.client.closed;
    await expect.poll(() => srv.roomCount()).toBe(0);
  });

  it('lets a reconnecting peer take over its id without notifying others', async () => {
    const { port } = await start();
    const a = await joined(port, 'ROOM42', 'peer-a');
    const b1 = await joined(port, 'ROOM42', 'peer-b');
    await a.client.next();
    const b2 = await joined(port, 'ROOM42', 'peer-b');
    expect(b2.reply).toMatchObject({ peers: [{ peerId: 'peer-a' }] });
    expect(await b1.client.closed).toBe(4000);
    a.client.send({ type: 'signal', to: 'peer-b', data: 'hi' });
    expect(await b2.client.next()).toEqual({ type: 'signal', from: 'peer-a', data: 'hi' });
  });

  it('rate-limits chatty sockets', async () => {
    const { port } = await start({ rateLimit: { burst: 5, perSecond: 1 } });
    const c = await connect(port);
    for (let i = 0; i < 10; i++) c.send({ type: 'leave' });
    expect(await c.next()).toMatchObject({ code: 'rate-limited' });
  });

  it('drops sockets that stop answering pings', async () => {
    const srv = await start({ heartbeatIntervalMs: 50 });
    const a = await joined(srv.port, 'ROOM42', 'peer-a');
    const b = await joined(srv.port, 'ROOM42', 'peer-b');
    await a.client.next();
    // Silence b's automatic pong replies.
    (b.client.socket as unknown as { pong: () => void }).pong = () => {};
    expect(await a.client.next()).toEqual({ type: 'peer-left', peerId: 'peer-b' });
  });

  it('answers health checks over plain HTTP', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  });

  it('attaches to an existing HTTP server on a path', async () => {
    const host = createServer((_req, res) => res.writeHead(200).end('static'));
    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
    try {
      server = await createSignallingServer({ server: host, path: '/signal' });
      const address = host.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      expect(server.port).toBe(port);

      // Plain HTTP still belongs to the host server.
      expect(await (await fetch(`http://127.0.0.1:${port}/signal`)).text()).toBe('static');

      const a = await connect(port, '/signal');
      a.send({ type: 'join', room: 'ROOM42', peerId: 'peer-a', name: 'A' });
      expect(await a.next()).toMatchObject({ type: 'joined', room: 'ROOM42', peers: [] });

      // Upgrades on other paths are refused.
      await expect(connect(port, '/other')).rejects.toThrow(/404/);

      // close() ends the signalling sockets but leaves the host server up.
      await server.close();
      server = null;
      expect(await a.closed).toBeTypeOf('number');
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => host.close(() => resolve()));
    }
  });
});
