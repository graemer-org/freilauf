import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  CLOSE_REPLACED,
  MAX_MESSAGE_BYTES,
  MAX_PEERS_PER_ROOM,
  parseClientMessage,
  type ErrorCode,
  type PeerInfo,
  type ServerMessage,
} from './protocol.ts';

export * from './protocol.ts';

export interface SignallingServerOptions {
  /** TCP port; 0 picks a free one (see `port` on the result). Default 8787. */
  port?: number;
  /** Interface to bind. Default: all interfaces. */
  host?: string;
  maxPeersPerRoom?: number;
  /** Larger messages get a `message-too-large` error; > 2x this closes the socket. */
  maxMessageBytes?: number;
  /** Ping interval; a socket that did not answer the previous ping is dropped. Default 30 s. */
  heartbeatIntervalMs?: number;
  /** Token bucket per socket. Default: burst 200 messages, refill 50 per second. */
  rateLimit?: { burst: number; perSecond: number };
  /** Log sink for one-line events. Default: silent. */
  log?: (line: string) => void;
}

export interface SignallingServer {
  /** The port actually bound (useful with `port: 0`). */
  readonly port: number;
  /** Number of rooms currently open (for tests / monitoring). */
  roomCount(): number;
  close(): Promise<void>;
}

interface Client {
  socket: WebSocket;
  alive: boolean;
  room: string | null;
  peerId: string | null;
  name: string;
  tokens: number;
  lastRefill: number;
  lastRateLimitError: number;
}

/** Starts a relay-only signalling server. Resolves once it is listening. */
export function createSignallingServer(
  options: SignallingServerOptions = {},
): Promise<SignallingServer> {
  const maxPeers = options.maxPeersPerRoom ?? MAX_PEERS_PER_ROOM;
  const maxBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;
  const burst = options.rateLimit?.burst ?? 200;
  const perSecond = options.rateLimit?.perSecond ?? 50;
  const log = options.log ?? (() => {});

  /** room code -> (peerId -> client) */
  const rooms = new Map<string, Map<string, Client>>();
  const clients = new Set<Client>();

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }
    res
      .writeHead(426, { 'content-type': 'text/plain' })
      .end('Freilauf signalling server: connect via WebSocket.\n');
  });
  const wss = new WebSocketServer({ server: http, maxPayload: maxBytes * 2 });

  function send(client: Client, msg: ServerMessage): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(msg));
  }

  function sendError(client: Client, code: ErrorCode, message: string): void {
    send(client, { type: 'error', code, message });
  }

  function leaveRoom(client: Client): void {
    const { room, peerId } = client;
    client.room = null;
    client.peerId = null;
    if (room === null || peerId === null) return;
    const members = rooms.get(room);
    if (!members || members.get(peerId) !== client) return;
    members.delete(peerId);
    for (const other of members.values()) send(other, { type: 'peer-left', peerId });
    if (members.size === 0) {
      rooms.delete(room);
      log(`room ${room} closed`);
    }
  }

  function takeToken(client: Client): boolean {
    const now = Date.now();
    client.tokens = Math.min(burst, client.tokens + ((now - client.lastRefill) / 1000) * perSecond);
    client.lastRefill = now;
    if (client.tokens >= 1) {
      client.tokens -= 1;
      return true;
    }
    if (now - client.lastRateLimitError > 1000) {
      client.lastRateLimitError = now;
      sendError(client, 'rate-limited', 'Too many messages; some were dropped.');
    }
    return false;
  }

  function handleMessage(client: Client, raw: string): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      sendError(client, parsed.code, parsed.message);
      return;
    }
    const msg = parsed.message;
    switch (msg.type) {
      case 'join': {
        if (client.room !== null) {
          sendError(client, 'already-joined', `Already in room ${client.room}; leave first.`);
          return;
        }
        let members = rooms.get(msg.room);
        const previous = members?.get(msg.peerId);
        if (members && !previous && members.size >= maxPeers) {
          sendError(client, 'room-full', `Room ${msg.room} is full (max ${maxPeers} riders).`);
          return;
        }
        if (!members) {
          members = new Map();
          rooms.set(msg.room, members);
          log(`room ${msg.room} opened`);
        }
        const peers: PeerInfo[] = [...members.values()]
          .filter((c) => c !== previous)
          .map((c) => ({ peerId: c.peerId ?? '', name: c.name }));
        client.room = msg.room;
        client.peerId = msg.peerId;
        client.name = msg.name;
        members.set(msg.peerId, client);
        if (previous) {
          // Same peer reconnected (e.g. after a network blip): the new socket takes over silently.
          previous.room = null;
          previous.peerId = null;
          previous.socket.close(CLOSE_REPLACED, 'replaced by a newer connection');
        } else {
          for (const other of members.values()) {
            if (other !== client) {
              send(other, { type: 'peer-joined', peer: { peerId: msg.peerId, name: msg.name } });
            }
          }
        }
        send(client, { type: 'joined', room: msg.room, peerId: msg.peerId, peers });
        return;
      }
      case 'leave':
        leaveRoom(client);
        return;
      case 'signal': {
        if (client.room === null || client.peerId === null) {
          sendError(client, 'not-joined', 'Join a room before sending signals.');
          return;
        }
        const target = rooms.get(client.room)?.get(msg.to);
        if (!target || target === client) {
          sendError(client, 'unknown-peer', `Peer ${msg.to} is not in this room.`);
          return;
        }
        send(target, { type: 'signal', from: client.peerId, data: msg.data });
        return;
      }
    }
  }

  wss.on('connection', (socket: WebSocket) => {
    const client: Client = {
      socket,
      alive: true,
      room: null,
      peerId: null,
      name: '',
      tokens: burst,
      lastRefill: Date.now(),
      lastRateLimitError: 0,
    };
    clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      client.alive = true;
      if (!takeToken(client)) return;
      if (isBinary) {
        sendError(client, 'invalid-message', 'Only text frames are accepted.');
        return;
      }
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      if (buf.byteLength > maxBytes) {
        sendError(client, 'message-too-large', `Messages are limited to ${maxBytes} bytes.`);
        return;
      }
      handleMessage(client, buf.toString('utf8'));
    });
    socket.on('close', () => {
      leaveRoom(client);
      clients.delete(client);
    });
    socket.on('error', () => {
      // 'close' follows; nothing else to do.
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 8787, options.host, () => {
      http.off('error', reject);
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
      resolve({
        port,
        roomCount: () => rooms.size,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const client of clients) client.socket.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}
