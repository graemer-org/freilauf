// Node-only helpers for the integration tests (not exported from ./index).
import WebSocket from 'ws';
import { createSignallingServer, type SignallingServer } from '@freilauf/signalling';
import type { WebSocketFactory, WebSocketLike } from '../signalling/websocket';

export async function startServer(
  options: Parameters<typeof createSignallingServer>[0] = {},
): Promise<{ server: SignallingServer; url: string }> {
  const server = await createSignallingServer({ port: 0, host: '127.0.0.1', ...options });
  return { server, url: `ws://127.0.0.1:${server.port}` };
}

/** A `ws`-backed WebSocket factory that remembers the sockets it created. */
export function wsFactory(): WebSocketFactory & { sockets: WebSocket[] } {
  const sockets: WebSocket[] = [];
  const factory = (url: string): WebSocketLike => {
    const socket = new WebSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocketLike;
  };
  return Object.assign(factory, { sockets });
}
