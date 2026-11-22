/**
 * The default transport: peers find each other through public Nostr relays using Trystero
 * (npm `trystero`), then talk over direct WebRTC data channels. No Freilauf server is involved.
 *
 * What we rely on from Trystero 0.27 (read in node_modules/@trystero-p2p/core/dist, see
 * docs/adr/0003-signalling-via-public-relays.md for the details):
 * - `joinRoom({ appId, password, … }, roomId)`; the relays only see a hash of app id + room id
 *   and handshakes encrypted with AES-GCM under a key derived from `password` (PBKDF2-SHA256,
 *   600 000 iterations). Peers with another password cannot decrypt (`decrypt-failed`).
 * - One data channel per peer, created with the browser defaults: reliable and ordered. Actions
 *   up to 16 KiB are sent as one frame; Trystero queues behind `bufferedAmount` (backpressure).
 * - `onPeerJoin` fires when a peer's channel is open and its handshake verified; messages from
 *   a peer are only delivered once it is active.
 * - `onError`: `relay-failed` (every relay failed its first connection attempt),
 *   `decrypt-failed`, `peer-connect-failed` (no direct path; we ship no TURN), `room-full`, ….
 *
 * Trystero is reached only through the small `TrysteroModuleLike` interface below, injected or
 * loaded with a dynamic `import('trystero')` on first use — so this package's tests run in Node
 * with a fake (`testing/fakeTrystero.ts`) and nothing evaluates Trystero at import time.
 */
import { utf8Length } from '../documents';
import { DEFAULT_ICE_SERVERS, type IceServerConfig } from '../ice';
import { Events, type Timers, type Unsubscribe } from '../runtime';
import {
  GroupError,
  MAX_RIDERS_PER_GROUP,
  sanitizeName,
  type GroupTransport,
  type MeshPeer,
  type TransportEvents,
  type TransportLog,
  type TransportState,
} from '../transport';

// ─────────────────────────── the Trystero surface we use ───────────────────────────

export interface TrysteroActionLike {
  send(data: string, options?: { target?: string | string[] | null }): Promise<void>;
  onMessage(handler: (data: unknown, context: { peerId: string }) => unknown): Unsubscribe;
  /** Gate for incoming messages (by size, before they are reassembled). */
  onReceive?(handler: (context: { peerId: string; byteLength: number }) => boolean): Unsubscribe;
}

export interface TrysteroRoomError {
  code: string;
  message: string;
  peerId?: string;
  stage?: string;
  turnConfigured?: boolean;
}

export interface TrysteroRoomLike {
  makeAction(namespace: string): TrysteroActionLike;
  onPeerJoin(handler: (context: { peerId: string }) => unknown): Unsubscribe;
  onPeerLeave(handler: (context: { peerId: string }) => unknown): Unsubscribe;
  onError(handler: (error: TrysteroRoomError) => unknown): Unsubscribe;
  getSelf(): Promise<{ peerId: string }>;
  leave(): Promise<void>;
}

export interface TrysteroRoomConfig {
  appId: string;
  password: string;
  /** Throwaway keys per room: no IndexedDB, nothing that links one ride to the next. */
  identity: 'none';
  maxUsers: number;
  maxReceiveBytes: number;
  relayConfig: { urls: string[]; redundancy: number };
  rtcConfig: { iceServers: IceServerConfig[] };
}

export interface TrysteroModuleLike {
  joinRoom(config: TrysteroRoomConfig, roomId: string): TrysteroRoomLike;
  /** Relay URL → WebSocket (readyState 1 = open). Used to tell "no relay reachable". */
  getRelaySockets?(): Record<string, { readyState: number }>;
}

/** Loads the real library (browser / Electron renderer). Separate chunk, loaded on first use. */
export async function loadTrystero(): Promise<TrysteroModuleLike> {
  const mod: unknown = await import('trystero');
  return mod as TrysteroModuleLike;
}

// ─────────────────────────── constants ───────────────────────────

/** Namespace of all Freilauf rooms on the relays. Changing it splits old and new versions. */
export const FREILAUF_APP_ID = 'freilauf/group-ride/v1';

/**
 * The relays every Freilauf uses by default — pinned here rather than left to Trystero's own
 * selection (which shuffles its built-in list by app id), so that two Freilauf versions built
 * against different Trystero releases still meet on the same relays. All eight are taken from
 * the list Trystero 0.27.0 ships (`defaultRelayUrls`; a test checks that); they are
 * general-purpose public relays of different operators. Peers must share at least one relay.
 * The choice is unverified from this project's side (relays cannot be reached from CI).
 */
export const DEFAULT_RELAY_URLS: readonly string[] = [
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.net',
  'wss://relay.ditto.pub',
  'wss://nostr.data.haus',
  'wss://yabu.me',
  'wss://relay.nostrhub.fr',
];

/** No relay open after this long → `no-relay` (covers silently dropped connections). */
export const RELAY_CONNECT_TIMEOUT_MS = 15_000;
const RELAY_CHECK_INTERVAL_MS = 250;
/** Largest message we send or accept (the mesh's limit; Trystero sends ≤ 16 KiB in one frame). */
export const MAX_RELAY_MESSAGE_BYTES = 16 * 1024;
/** Sends to one peer still queued inside Trystero; beyond this, `send` reports false (drop). */
export const MAX_PENDING_SENDS = 64;
const HELLO_ACTION = 'fl-hello';
const MESSAGE_ACTION = 'fl-msg';

/** Relay URL → host, for logs. */
export function relayHost(url: string): string {
  return /^wss?:\/\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? url;
}

// ─────────────────────────── the transport ───────────────────────────

export interface RelayTransportOptions {
  /** The invite secret (Trystero room password). */
  secret: string;
  /** The library, or how to load it. Default: `loadTrystero` (dynamic import). */
  trystero?: TrysteroModuleLike | (() => Promise<TrysteroModuleLike>);
  /** Default `DEFAULT_RELAY_URLS`. All riders need at least one relay in common. */
  relayUrls?: readonly string[];
  /** Default: our public STUN servers (`DEFAULT_ICE_SERVERS`). Add TURN servers here. */
  iceServers?: IceServerConfig[];
  /** Default `RELAY_CONNECT_TIMEOUT_MS`. */
  relayTimeoutMs?: number;
  timers: Timers;
  now: () => number;
}

interface PeerRecord {
  peerId: string;
  name: string;
  status: 'connecting' | 'connected';
  pending: number;
}

export class RelayTransport implements GroupTransport {
  readonly kind = 'relays' as const;
  readonly relayUrls: readonly string[];
  #opts: RelayTransportOptions;
  #events = new Events<TransportEvents>();
  #room: TrysteroRoomLike | null = null;
  #module: TrysteroModuleLike | null = null;
  #hello: TrysteroActionLike | null = null;
  #msg: TrysteroActionLike | null = null;
  #peers = new Map<string, PeerRecord>();
  #state: TransportState = 'idle';
  #localPeerId = '';
  #name = '';
  #closed = false;
  #off: Unsubscribe[] = [];
  #checkTimer: unknown = null;
  #deadline: unknown = null;
  #lastOpen = -1;
  #failure: { code: string; message: string } | null = null;

  constructor(options: RelayTransportOptions) {
    this.#opts = options;
    const urls = (options.relayUrls ?? DEFAULT_RELAY_URLS).filter((u) => /^wss?:\/\/\S+$/i.test(u));
    this.relayUrls = urls.length > 0 ? urls : DEFAULT_RELAY_URLS;
  }

  get localPeerId(): string {
    return this.#localPeerId;
  }

  get state(): TransportState {
    return this.#state;
  }

  on<K extends keyof TransportEvents>(
    event: K,
    listener: (value: TransportEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  async start(room: string, name: string): Promise<void> {
    if (this.#state !== 'idle') throw new GroupError('already-joined', 'Already started.');
    this.#name = name;
    this.#setState('connecting');
    const hosts = this.relayUrls.map(relayHost);
    this.#log('info', 'joining via public relays', { relays: hosts });
    let mod: TrysteroModuleLike;
    try {
      const source = this.#opts.trystero ?? loadTrystero;
      mod = typeof source === 'function' ? await source() : source;
    } catch (err) {
      this.#log('error', 'could not load the relay library', { error: String(err) });
      this.#shutdown();
      throw new GroupError('relay-unavailable', 'The relay library could not be loaded.');
    }
    if (this.#closed) throw this.#closedError();
    this.#module = mod;
    let joined: TrysteroRoomLike;
    try {
      joined = mod.joinRoom(
        {
          appId: FREILAUF_APP_ID,
          password: this.#opts.secret,
          identity: 'none',
          maxUsers: MAX_RIDERS_PER_GROUP,
          maxReceiveBytes: 4 * MAX_RELAY_MESSAGE_BYTES,
          // `redundancy` caps how many of `urls` are used (Trystero's default is 5): use all.
          relayConfig: { urls: [...this.relayUrls], redundancy: this.relayUrls.length },
          rtcConfig: { iceServers: this.#opts.iceServers ?? DEFAULT_ICE_SERVERS },
        },
        room,
      );
    } catch (err) {
      this.#log('error', 'could not join the room on the relays', { error: String(err) });
      this.#shutdown();
      throw new GroupError('relay-join-failed', 'The room could not be joined.');
    }
    this.#room = joined;
    this.#wire(joined);
    try {
      const self = await joined.getSelf();
      this.#localPeerId = self.peerId;
    } catch (err) {
      this.#log('error', 'could not create a peer identity', { error: String(err) });
      this.close();
      throw new GroupError('identity-failed', 'Could not create a peer identity.');
    }
    if (this.#closed) throw this.#closedError();
    this.#watchRelays();
  }

  getPeers(): MeshPeer[] {
    return [...this.#peers.values()].map((p) => ({
      peerId: p.peerId,
      name: p.name,
      status: p.status,
      isOfferer: false,
      attempts: 0,
    }));
  }

  send(peerId: string, data: string): boolean {
    const rec = this.#peers.get(peerId);
    const action = this.#msg;
    if (!rec || rec.status !== 'connected' || !action || this.#closed) return false;
    if (rec.pending >= MAX_PENDING_SENDS) return false; // congested: the caller retries / resends
    if (utf8Length(data) > MAX_RELAY_MESSAGE_BYTES) return false;
    rec.pending += 1;
    const settle = () => {
      rec.pending -= 1;
    };
    try {
      action.send(data, { target: peerId }).then(settle, settle);
    } catch {
      settle();
      return false;
    }
    return true;
  }

  broadcast(data: string): number {
    let n = 0;
    for (const peerId of this.#peers.keys()) if (this.send(peerId, data)) n++;
    return n;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#shutdown();
    this.#events.clear();
  }

  // ---- internals -----------------------------------------------------------------------------

  #shutdown(): void {
    this.#closed = true;
    this.#stopWatching();
    for (const off of this.#off) off();
    this.#off = [];
    this.#peers.clear();
    const room = this.#room;
    this.#room = null;
    if (room) room.leave().catch(() => {});
    this.#setState('closed');
  }

  #wire(room: TrysteroRoomLike): void {
    const hello = room.makeAction(HELLO_ACTION);
    const msg = room.makeAction(MESSAGE_ACTION);
    this.#hello = hello;
    this.#msg = msg;
    const small = ({ byteLength }: { byteLength: number }) => byteLength <= MAX_RELAY_MESSAGE_BYTES;
    this.#off = [
      hello.onReceive?.(small) ?? (() => {}),
      msg.onReceive?.(small) ?? (() => {}),
      room.onPeerJoin(({ peerId }) => void this.#ensurePeer(peerId, true)),
      room.onPeerLeave(({ peerId }) => this.#removePeer(peerId)),
      hello.onMessage((data, { peerId }) => this.#onHello(peerId, data)),
      msg.onMessage((data, { peerId }) => {
        if (typeof data !== 'string' || data.length > MAX_RELAY_MESSAGE_BYTES) return;
        // A message is never delivered from a peer we have not announced (see 'peer-joined').
        if (!this.#ensurePeer(peerId)) return;
        this.#events.emit('message', { peerId, data });
      }),
      room.onError((err) => this.#onError(err)),
    ];
  }

  /**
   * Creates the record for a peer the first time we hear of it — from `onPeerJoin` or, should
   * Trystero ever deliver a message first, from that message — and emits `peer-joined`
   * synchronously before anything else passes for that peer (the documents engine and the
   * community no-leak rule depend on it, see docs/p2p.md "Peer-join ordering"). The status goes
   * `connecting` → `connected` within the same call: Trystero only reports open channels.
   * `sendHello` (from `onPeerJoin`): tell the peer our name.
   */
  #ensurePeer(peerId: string, sendHello = false): PeerRecord | null {
    if (this.#closed || !peerId || peerId === this.#localPeerId) return null;
    const existing = this.#peers.get(peerId);
    if (existing) {
      if (sendHello) this.#sendHello(peerId);
      return existing;
    }
    const rec: PeerRecord = { peerId, name: '', status: 'connecting', pending: 0 };
    this.#peers.set(peerId, rec);
    this.#events.emit('peer-joined', { peerId, name: '' });
    if (this.#closed || this.#peers.get(peerId) !== rec) return null;
    this.#events.emit('status', { peerId, status: 'connecting' });
    // Our name first, so it arrives before the state and document messages that follow.
    if (sendHello) this.#sendHello(peerId);
    rec.status = 'connected';
    this.#events.emit('status', { peerId, status: 'connected' });
    this.#log('info', 'peer connected', { peer: peerId.slice(0, 6), peers: this.#peers.size });
    return this.#peers.get(peerId) === rec ? rec : null;
  }

  #removePeer(peerId: string): void {
    if (!this.#peers.delete(peerId)) return;
    this.#log('info', 'peer left', { peer: peerId.slice(0, 6), peers: this.#peers.size });
    this.#events.emit('peer-left', { peerId });
  }

  #sendHello(peerId: string): void {
    const hello = this.#hello;
    if (!hello) return;
    const data = JSON.stringify({ v: 1, name: this.#name });
    try {
      hello.send(data, { target: peerId }).catch(() => {});
    } catch {
      // the peer went away; nothing to do
    }
  }

  #onHello(peerId: string, data: unknown): void {
    if (typeof data !== 'string' || data.length > 1024) return;
    let name: unknown;
    try {
      name = (JSON.parse(data) as { name?: unknown }).name;
    } catch {
      return;
    }
    if (typeof name !== 'string') return;
    const rec = this.#ensurePeer(peerId);
    const clean = sanitizeName(name);
    if (!rec || clean === '' || rec.name === clean) return;
    rec.name = clean;
    this.#events.emit('peer-updated', { peerId });
  }

  #onError(err: TrysteroRoomError): void {
    if (this.#closed) return;
    const peer = err.peerId ? err.peerId.slice(0, 6) : null;
    const at = this.#opts.now();
    switch (err.code) {
      case 'relay-failed':
        this.#fail('no-relay', 'None of the relay servers could be reached.', {
          cause: err.message,
        });
        return;
      case 'decrypt-failed':
        this.#log('warn', 'a peer used another secret (handshake could not be decrypted)', {
          peer,
          stage: err.stage ?? null,
        });
        this.#events.emit('problem', { code: 'secret-mismatch', peerId: err.peerId, at });
        return;
      case 'peer-connect-failed':
        this.#log('warn', 'no direct connection to a peer (restrictive network?)', {
          peer,
          turn: err.turnConfigured ?? false,
        });
        this.#events.emit('problem', { code: 'peer-unreachable', peerId: err.peerId, at });
        return;
      case 'room-full':
        if (this.#peers.size === 0) {
          this.#fail('room-full', `The group already has ${MAX_RIDERS_PER_GROUP} riders.`);
        } else {
          this.#log('warn', 'a rider was turned away: the group is full', { peer });
          this.#events.emit('problem', { code: 'room-full', peerId: err.peerId, at });
        }
        return;
      default:
        this.#log('warn', `relay room error: ${err.code}`, { peer, message: err.message });
    }
  }

  /** What `start()` rejects with when the room was closed while it was still starting. */
  #closedError(): GroupError {
    const f = this.#failure;
    return f ? new GroupError(f.code, f.message) : new GroupError('closed', 'Left before joining.');
  }

  #fail(code: string, message: string, data?: TransportLog['data']): void {
    if (this.#closed) return;
    this.#failure = { code, message };
    this.#log('error', `giving up: ${code}`, { ...data, ...this.#relaySummary() });
    this.#events.emit('failed', { code, message });
    this.close();
  }

  /** Polls the relay sockets: `joined` while one is open, `no-relay` if none opened in time. */
  #watchRelays(): void {
    const sockets = this.#module?.getRelaySockets;
    if (!sockets) {
      this.#setState('joined');
      return;
    }
    const timers = this.#opts.timers;
    const check = () => {
      if (this.#closed) return;
      const open = this.#openRelays().length;
      if (open === this.#lastOpen) return;
      const before = this.#lastOpen;
      this.#lastOpen = open;
      if (open > 0) {
        if (this.#deadline !== null) {
          timers.clearTimeout(this.#deadline);
          this.#deadline = null;
        }
        if (this.#state !== 'joined') {
          this.#log('info', 'relay connected', this.#relaySummary());
          this.#setState('joined');
        } else {
          this.#log('info', 'relay count changed', { open, before });
        }
      } else if (this.#state === 'joined') {
        this.#log('warn', 'lost every relay; retrying (connected riders are not affected)', {
          ...this.#relaySummary(),
        });
        this.#setState('reconnecting');
      }
    };
    this.#checkTimer = timers.setInterval(check, RELAY_CHECK_INTERVAL_MS);
    this.#deadline = timers.setTimeout(() => {
      this.#deadline = null;
      if (this.#openRelays().length === 0 && this.#state === 'connecting') {
        this.#fail('no-relay', 'No relay server answered in time.', {
          timeoutMs: this.#opts.relayTimeoutMs ?? RELAY_CONNECT_TIMEOUT_MS,
        });
      }
    }, this.#opts.relayTimeoutMs ?? RELAY_CONNECT_TIMEOUT_MS);
    check();
  }

  #stopWatching(): void {
    const timers = this.#opts.timers;
    if (this.#checkTimer !== null) timers.clearInterval(this.#checkTimer);
    if (this.#deadline !== null) timers.clearTimeout(this.#deadline);
    this.#checkTimer = this.#deadline = null;
  }

  #openRelays(): string[] {
    try {
      const sockets = this.#module?.getRelaySockets?.() ?? {};
      return Object.entries(sockets)
        .filter(([, s]) => s.readyState === 1)
        .map(([url]) => relayHost(url));
    } catch {
      return [];
    }
  }

  #relaySummary(): Record<string, string[]> {
    const open = new Set(this.#openRelays());
    const hosts = this.relayUrls.map(relayHost);
    return {
      relaysOpen: hosts.filter((h) => open.has(h)),
      relaysNotOpen: hosts.filter((h) => !open.has(h)),
    };
  }

  #setState(state: TransportState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#events.emit('state', state);
  }

  #log(level: TransportLog['level'], message: string, data?: TransportLog['data']): void {
    this.#events.emit('log', data ? { level, message, data } : { level, message });
  }
}
