import { defaultTimers, Events, randomPeerId, type Timers, type Unsubscribe } from '../runtime';
import {
  FATAL_SIGNALLING_ERRORS,
  SignallingError,
  sanitizeName,
  type SignallingChannel,
  type SignallingEvents,
  type SignallingState,
} from './channel';
import {
  CLOSE_REPLACED,
  MAX_NAME_LENGTH,
  parseServerMessage,
  type ClientMessage,
  type PeerInfo,
} from './protocol';

/** The subset of the WHATWG `WebSocket` API used here (browser WebSocket and `ws` both fit). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const OPEN = 1;

/** Uses the host's global `WebSocket` (browser / Electron renderer / Node ≥ 22). */
export const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike })
    .WebSocket;
  if (!Ctor) throw new Error('No global WebSocket available; pass createWebSocket.');
  return new Ctor(url);
};

export interface ReconnectOptions {
  /** First retry delay. Default 500 ms; doubles per attempt (with ±25 % jitter). */
  initialDelayMs?: number;
  /** Upper bound for the delay. Default 10 s. */
  maxDelayMs?: number;
}

export interface WebSocketSignallingOptions {
  /** ws:// or wss:// URL of the signalling server. */
  url: string;
  /** Own peer id. Default: random. */
  peerId?: string;
  createWebSocket?: WebSocketFactory;
  timers?: Timers;
  /** 0..1, used for backoff jitter. Default Math.random. */
  random?: () => number;
  reconnect?: ReconnectOptions;
  /** `join()` rejects if the first join is not confirmed in time. Default 10 s. */
  joinTimeoutMs?: number;
}

/**
 * `SignallingChannel` over the Freilauf WebSocket signalling server. Reconnects with exponential
 * backoff and re-joins the room with the same peer id; the server then sends a fresh peer list
 * (emitted as `peers`). Signals sent while disconnected are dropped (`sendSignal` returns false);
 * the mesh recovers by re-offering.
 */
export class WebSocketSignalling implements SignallingChannel {
  readonly peerId: string;
  readonly url: string;
  #state: SignallingState = 'idle';
  #events = new Events<SignallingEvents>();
  #createWebSocket: WebSocketFactory;
  #timers: Timers;
  #random: () => number;
  #initialDelay: number;
  #maxDelay: number;
  #joinTimeoutMs: number;
  #socket: WebSocketLike | null = null;
  #room = '';
  #name = '';
  #attempt = 0;
  #reconnectTimer: unknown = null;
  #joinTimer: unknown = null;
  #pendingJoin: {
    resolve: (peers: PeerInfo[]) => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor(options: WebSocketSignallingOptions) {
    this.url = options.url;
    this.peerId = options.peerId ?? randomPeerId();
    this.#createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
    this.#timers = options.timers ?? defaultTimers;
    this.#random = options.random ?? Math.random;
    this.#initialDelay = options.reconnect?.initialDelayMs ?? 500;
    this.#maxDelay = options.reconnect?.maxDelayMs ?? 10_000;
    this.#joinTimeoutMs = options.joinTimeoutMs ?? 10_000;
  }

  get state(): SignallingState {
    return this.#state;
  }

  on<K extends keyof SignallingEvents>(
    event: K,
    listener: (value: SignallingEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  join(room: string, name: string): Promise<PeerInfo[]> {
    if (this.#state !== 'idle') {
      return Promise.reject(
        new SignallingError('already-joined', 'join() may only be called once.'),
      );
    }
    this.#room = room;
    this.#name = sanitizeName(name, MAX_NAME_LENGTH) || 'Rider';
    const promise = new Promise<PeerInfo[]>((resolve, reject) => {
      this.#pendingJoin = { resolve, reject };
    });
    this.#joinTimer = this.#timers.setTimeout(() => {
      this.#joinTimer = null;
      this.#fail('join-timeout', 'Could not reach the signalling server.');
    }, this.#joinTimeoutMs);
    this.#connect();
    return promise;
  }

  leave(): void {
    if (this.#state === 'closed') return;
    this.#send({ type: 'leave' });
    this.#shutdown('left', new SignallingError('left', 'Left before the room was joined.'));
  }

  sendSignal(to: string, data: unknown): boolean {
    if (this.#state !== 'joined') return false;
    return this.#send({ type: 'signal', to, data });
  }

  // ---- internals -----------------------------------------------------------------------------

  #setState(state: SignallingState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#events.emit('state', state);
  }

  #send(msg: ClientMessage): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  #connect(): void {
    this.#setState(this.#attempt === 0 ? 'connecting' : 'reconnecting');
    let socket: WebSocketLike;
    try {
      socket = this.#createWebSocket(this.url);
    } catch (err) {
      this.#events.emit('error', {
        code: 'connect-failed',
        message: err instanceof Error ? err.message : String(err),
        fatal: false,
      });
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#send({ type: 'join', room: this.#room, peerId: this.peerId, name: this.#name });
    };
    socket.onmessage = (event) => {
      if (this.#socket === socket) this.#handleMessage(event.data);
    };
    socket.onerror = () => {
      // A close event always follows.
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (event.code === CLOSE_REPLACED) {
        this.#fail('replaced', 'Another connection joined with the same peer id.');
        return;
      }
      if (this.#state !== 'closed') this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    if (this.#state === 'closed') return;
    this.#setState('reconnecting');
    const base = Math.min(this.#maxDelay, this.#initialDelay * 2 ** this.#attempt);
    const delay = base * (0.75 + this.#random() * 0.5);
    this.#attempt++;
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#state !== 'closed') this.#connect();
    }, delay);
  }

  #handleMessage(raw: unknown): void {
    const msg = parseServerMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case 'joined': {
        this.#attempt = 0;
        if (this.#joinTimer !== null) {
          this.#timers.clearTimeout(this.#joinTimer);
          this.#joinTimer = null;
        }
        const peers = msg.peers.filter((p) => p.peerId !== this.peerId);
        this.#setState('joined');
        const pending = this.#pendingJoin;
        this.#pendingJoin = null;
        pending?.resolve(peers);
        this.#events.emit('peers', peers);
        return;
      }
      case 'peer-joined':
        if (msg.peer.peerId !== this.peerId) this.#events.emit('peer-joined', msg.peer);
        return;
      case 'peer-left':
        this.#events.emit('peer-left', { peerId: msg.peerId });
        return;
      case 'signal':
        this.#events.emit('signal', { from: msg.from, data: msg.data });
        return;
      case 'error':
        if (FATAL_SIGNALLING_ERRORS.has(msg.code)) {
          this.#fail(msg.code, msg.message);
        } else {
          this.#events.emit('error', { code: msg.code, message: msg.message, fatal: false });
        }
        return;
    }
  }

  #fail(code: string, message: string): void {
    if (this.#state === 'closed') return;
    this.#events.emit('error', { code, message, fatal: true });
    this.#shutdown(code, new SignallingError(code, message));
  }

  #shutdown(reason: string, joinError: Error): void {
    this.#setState('closed');
    if (this.#reconnectTimer !== null) this.#timers.clearTimeout(this.#reconnectTimer);
    if (this.#joinTimer !== null) this.#timers.clearTimeout(this.#joinTimer);
    this.#reconnectTimer = null;
    this.#joinTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000, reason);
      } catch {
        // ignore
      }
    }
    const pending = this.#pendingJoin;
    this.#pendingJoin = null;
    pending?.reject(joinError);
    this.#events.emit('closed', { reason });
  }
}
