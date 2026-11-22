/**
 * "Test connection" for a group-ride signalling server: opens a WebSocket,
 * sends one message the server does not know, and expects the protocol's
 * error reply. That tells "nothing answers" from "something answers, but not a
 * signalling server" without joining a room. Browsers report every failed
 * WebSocket the same way, so when the address fails and does not end in
 * `/signal`, the same host is tried with `/signal` in parallel: the web/Docker
 * server only answers there, and forgetting the path is the common mistake.
 *
 * Pure apart from the injected WebSocket factory and timers (unit-tested in
 * signallingProbe.test.ts).
 */
import { parseServerMessage } from '@freilauf/p2p';
import type { WebSocketFactory, WebSocketLike } from '@freilauf/p2p';

export type ProbeResult =
  /** A Freilauf signalling server answered. */
  | { kind: 'ok'; ms: number }
  /** navigator.onLine is false. */
  | { kind: 'offline' }
  /** The address is not usable as a WebSocket URL (or the browser refused it). */
  | { kind: 'invalid'; message: string }
  /** No WebSocket connection could be opened. */
  | { kind: 'unreachable' }
  /** A WebSocket opened, but the other end does not speak the protocol. */
  | { kind: 'not-signalling' }
  /** Nothing at this address, but the same host answers at `suggestion`. */
  | { kind: 'wrong-path'; suggestion: string };

export interface ProbeOptions {
  createWebSocket?: WebSocketFactory;
  /** Per attempt. Default 6 s. */
  timeoutMs?: number;
  now?: () => number;
  /** navigator.onLine; return undefined when unknown. */
  online?: () => boolean | undefined;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const SIGNAL_PATH = '/signal';

const defaultFactory: WebSocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike })
    .WebSocket;
  if (!Ctor) throw new Error('No WebSocket available.');
  return new Ctor(url);
};

type Attempt = 'ok' | 'unreachable' | 'not-signalling' | { invalid: string };

function attempt(url: string, options: Required<Omit<ProbeOptions, 'online'>>): Promise<Attempt> {
  return new Promise((resolve) => {
    let socket: WebSocketLike;
    try {
      socket = options.createWebSocket(url);
    } catch (err) {
      resolve({ invalid: err instanceof Error ? err.message : String(err) });
      return;
    }
    let opened = false;
    let done = false;
    const finish = (result: Attempt): void => {
      if (done) return;
      done = true;
      options.clearTimeout(timer);
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000, 'probe');
      } catch {
        // already closed
      }
      resolve(result);
    };
    const timer = options.setTimeout(
      () => finish(opened ? 'not-signalling' : 'unreachable'),
      options.timeoutMs,
    );
    socket.onopen = () => {
      opened = true;
      try {
        // Not a protocol message: a signalling server answers with an `error` frame.
        socket.send(JSON.stringify({ type: 'probe' }));
      } catch {
        finish('not-signalling');
      }
    };
    socket.onmessage = (event) => finish(parseServerMessage(event.data) ? 'ok' : 'not-signalling');
    socket.onerror = () => {
      // A close event follows.
    };
    socket.onclose = () => finish(opened ? 'not-signalling' : 'unreachable');
  });
}

/** `wss://host/path` → `wss://host/signal` (null when the path already is /signal). */
export function withSignalPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.pathname.replace(/\/+$/, '') === SIGNAL_PATH) return null;
    u.pathname = SIGNAL_PATH;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export async function probeSignallingServer(
  url: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  if (options.online?.() === false) return { kind: 'offline' };
  const opts: Required<Omit<ProbeOptions, 'online'>> = {
    createWebSocket: options.createWebSocket ?? defaultFactory,
    timeoutMs: options.timeoutMs ?? 6_000,
    now: options.now ?? Date.now,
    setTimeout: options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
    clearTimeout:
      options.clearTimeout ??
      ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>)),
  };
  const started = opts.now();
  const alternative = withSignalPath(url);
  const [main, alt] = await Promise.all([
    attempt(url, opts),
    alternative ? attempt(alternative, opts) : Promise.resolve(null),
  ]);
  if (main === 'ok') return { kind: 'ok', ms: Math.max(0, opts.now() - started) };
  if (typeof main === 'object') return { kind: 'invalid', message: main.invalid };
  if (alt === 'ok' && alternative) return { kind: 'wrong-path', suggestion: alternative };
  return { kind: main };
}
