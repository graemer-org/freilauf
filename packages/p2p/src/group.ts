import {
  SharedDocuments,
  type DocumentEvent,
  type LocalDocument,
  type SharedDocument,
  type ShareResult,
  type StartAnnouncement,
  type StartResult,
} from './documents';
import {
  decodeStateMessage,
  encodeStateMessage,
  extrapolateDistance,
  RemoteRiders,
  sanitizeRiderState,
} from './riderState';
import type { IceServerConfig } from './ice';
import {
  buildInviteLink,
  buildJoinLink,
  formatInviteCode,
  formatRoomCode,
  generateInviteSecret,
  generateRoomCode,
  isValidInviteSecret,
  normaliseRoomCode,
  parseRoomCode,
} from './roomCode';
import { defaultTimers, Events, type Timers, type Unsubscribe } from './runtime';
import type { SignallingChannel } from './signalling/channel';
import type { WebSocketFactory } from './signalling/websocket';
import {
  GroupError,
  sanitizeName,
  type GroupTransport,
  type MeshPeer,
  type TransportFailure,
  type TransportLog,
  type TransportProblem,
  type TransportState,
} from './transport';
import { RelayTransport, type TrysteroModuleLike } from './transports/relay';
import { SignallingMeshTransport } from './transports/selfHosted';
import type { GroupRider, RiderState } from './types';
import type { PeerConnectionFactory } from './webrtc';

/** A peer that just entered the room (see `GroupRide.onPeerJoined`). */
export interface PeerJoined {
  peerId: string;
  /**
   * Display name, sanitised. Self-hosted: from the signalling join. Relays: not known yet when
   * this fires (the name follows in the peer's first message), so it is 'Rider'; `getPeers()`
   * and `onChange` carry the real name once it arrives.
   */
  name: string;
}

/** Options for the default transport (public relays, see transports/relay.ts). */
export interface RelayDeps {
  /** The invite secret. `GroupRide.create` generates one when omitted; `join` requires it. */
  secret?: string;
  /** The Trystero module or a loader for it (default: dynamic `import('trystero')`). */
  trystero?: TrysteroModuleLike | (() => Promise<TrysteroModuleLike>);
  /** Relay URLs (default `DEFAULT_RELAY_URLS`). */
  relayUrls?: readonly string[];
  /** No relay reachable after this long → the ride fails with `no-relay`. Default 15 s. */
  relayTimeoutMs?: number;
}

/** What the app feeds in; name and timestamp are added by GroupRide. */
export type LocalRiderState = Omit<RiderState, 'name' | 'sentAt'>;

export const BROADCAST_INTERVAL_MS = 250; // 4 Hz

export interface GroupRideDeps {
  /**
   * Default transport: public relays (Trystero). Takes precedence over the self-hosted options
   * below. Exactly one of `relay`, `signalling`, `signallingUrl` is needed.
   */
  relay?: RelayDeps;
  /** Self-hosted: ws(s):// URL of the signalling server. */
  signallingUrl?: string;
  /** Custom signalling channel (overrides `signallingUrl`). Must not have joined yet. */
  signalling?: SignallingChannel;
  /** WebSocket constructor for the default signalling (default: global WebSocket). */
  createWebSocket?: WebSocketFactory;
  /** RTCPeerConnection factory (default: global RTCPeerConnection). */
  createPeerConnection?: PeerConnectionFactory;
  /** ICE servers (default: public STUN), for both transports. TURN servers go here too. */
  iceServers?: IceServerConfig[];
  /** Local clock, epoch ms. Default Date.now. Used for `sentAt` and receive times. */
  now?: () => number;
  timers?: Timers;
  /** Default 250 ms (4 Hz). */
  broadcastIntervalMs?: number;
  /**
   * Upper bound (UTF-8 bytes) for one outgoing shared-document message; larger documents are
   * chunked. Default 1100 (one SCTP packet), minimum 200. Mainly for tests.
   */
  documentMessageMaxBytes?: number;
}

interface GroupRideEvents {
  change: undefined;
  'peer-joined': PeerJoined;
  failure: TransportFailure;
  problem: TransportProblem;
  log: TransportLog;
}

/** Problems are kept this long for `getProblems()`. */
const PROBLEM_KEEP_MS = 60_000;

/**
 * A group ride: joins a room, keeps a direct WebRTC connection to every other rider (through the
 * relay transport by default, or the self-hosted mesh), broadcasts the local rider's state at
 * 4 Hz and exposes the remote riders extrapolated to "now".
 */
export class GroupRide {
  readonly roomCode: string;
  readonly name: string;
  /** Relay rides: the invite secret (Trystero room password). '' for self-hosted rides. */
  readonly secret: string;
  #transport: GroupTransport;
  #riders = new RemoteRiders();
  #docs: SharedDocuments;
  #events = new Events<GroupRideEvents>();
  #now: () => number;
  #timers: Timers;
  #interval: unknown;
  #signallingUrl: string | undefined;
  #local: { state: LocalRiderState; at: number } | null = null;
  #problems: TransportProblem[] = [];
  #failure: TransportFailure | null = null;
  #left = false;
  #unsubscribe: Unsubscribe[] = [];

  /** Creates a new room with a random code (and, for relay rides, a new secret) and joins it. */
  static create(name: string, deps: GroupRideDeps): Promise<GroupRide> {
    const code = generateRoomCode();
    if (deps.relay && !deps.relay.secret) {
      return GroupRide.join(code, name, {
        ...deps,
        relay: { ...deps.relay, secret: generateInviteSecret(code) },
      });
    }
    return GroupRide.join(code, name, deps);
  }

  /**
   * Joins the room `roomCode` (user input is normalised). Rejects with a `GroupError` (`code`
   * e.g. `invalid-room`, `invalid-secret`, `room-full`, `join-timeout`, `relay-unavailable`).
   * Relay rides resolve as soon as the room exists locally — finding a relay and other riders
   * happens afterwards (`signallingState`, `onFailure` with `no-relay`).
   */
  static async join(roomCode: string, name: string, deps: GroupRideDeps): Promise<GroupRide> {
    const code = parseRoomCode(roomCode);
    if (!code) throw new GroupError('invalid-room', `Invalid room code: ${roomCode}`);
    if (deps.relay && !isValidInviteSecret(code, deps.relay.secret ?? '')) {
      throw new GroupError('invalid-secret', 'The invite secret is missing or not valid.');
    }
    const ride = new GroupRide(code, name, deps);
    try {
      await ride.#transport.start(code, ride.name);
    } catch (err) {
      ride.leave();
      throw err;
    }
    return ride;
  }

  private constructor(roomCode: string, name: string, deps: GroupRideDeps) {
    this.roomCode = roomCode;
    this.name = sanitizeName(name) || 'Rider';
    this.#now = deps.now ?? Date.now;
    this.#timers = deps.timers ?? defaultTimers;
    if (deps.relay) {
      this.secret = normaliseRoomCode(deps.relay.secret ?? '');
      this.#transport = new RelayTransport({
        secret: this.secret,
        trystero: deps.relay.trystero,
        relayUrls: deps.relay.relayUrls,
        relayTimeoutMs: deps.relay.relayTimeoutMs,
        iceServers: deps.iceServers,
        timers: this.#timers,
        now: this.#now,
      });
    } else {
      this.secret = '';
      this.#signallingUrl = deps.signallingUrl;
      this.#transport = new SignallingMeshTransport({
        signallingUrl: deps.signallingUrl,
        signalling: deps.signalling,
        createWebSocket: deps.createWebSocket,
        createPeerConnection: deps.createPeerConnection,
        iceServers: deps.iceServers,
        timers: this.#timers,
      });
    }
    const transport = this.#transport;
    this.#docs = new SharedDocuments({
      send: (peerId, data) => transport.send(peerId, data),
      broadcast: (data) => transport.broadcast(data),
      peerName: (peerId) => this.#peerName(peerId),
      now: this.#now,
      timers: this.#timers,
      maxMessageBytes: deps.documentMessageMaxBytes,
    });
    const changed = () => this.#events.emit('change', undefined);
    this.#unsubscribe = [
      // Synchronous, and strictly before any message from or to that peer passes the transport
      // (see onPeerJoined): both transports emit this when they first learn of the peer.
      transport.on('peer-joined', ({ peerId, name }) => {
        this.#events.emit('peer-joined', { peerId, name: sanitizeName(name) || 'Rider' });
      }),
      transport.on('message', ({ peerId, data }) => {
        const state = decodeStateMessage(data);
        if (state) {
          if (this.#riders.ingest(peerId, state, this.#now())) changed();
          return;
        }
        this.#docs.handleMessage(peerId, data); // ignores anything that is not a doc message
      }),
      transport.on('peer-left', ({ peerId }) => {
        this.#riders.remove(peerId);
        this.#docs.removePeer(peerId);
        changed();
      }),
      transport.on('status', ({ peerId, status }) => {
        if (status === 'connected') {
          this.#sendTo(peerId);
          this.#docs.peerConnected(peerId);
        }
        changed();
      }),
      transport.on('peer-updated', changed),
      transport.on('state', changed),
      transport.on('problem', (problem) => {
        const now = this.#now();
        this.#problems = [
          ...this.#problems.filter((p) => now - p.at < PROBLEM_KEEP_MS && p.code !== problem.code),
          problem,
        ];
        this.#events.emit('problem', problem);
        changed();
      }),
      transport.on('log', (line) => this.#events.emit('log', line)),
      transport.on('failed', (failure) => {
        this.#failure = failure;
        this.#events.emit('failure', failure);
        this.leave();
      }),
    ];
    this.#interval = this.#timers.setInterval(
      () => this.#broadcast(),
      deps.broadcastIntervalMs ?? BROADCAST_INTERVAL_MS,
    );
  }

  get localPeerId(): string {
    return this.#transport.localPeerId;
  }

  /** 'relays' (default) or 'self-hosted'. */
  get transport(): 'relays' | 'self-hosted' {
    return this.#transport.kind;
  }

  /**
   * Relays: `connecting` until a relay answers, then `joined` (others can find us). Self-hosted:
   * the signalling channel's state.
   */
  get signallingState(): TransportState {
    return this.#transport.state;
  }

  get hasLeft(): boolean {
    return this.#left;
  }

  /** Why the ride ended by itself (e.g. `no-relay`), or null. */
  get failure(): TransportFailure | null {
    return this.#failure;
  }

  /**
   * The invite to share. Relays: `freilauf://join/<CODE>#<SECRET>`. Self-hosted:
   * `freilauf://join/<CODE>?s=<url>` (without `s` when a custom channel is used).
   */
  get joinLink(): string {
    if (this.#transport.kind === 'relays') return buildInviteLink(this.roomCode, this.secret);
    return buildJoinLink(this.roomCode, this.#signallingUrl);
  }

  /** Relays: the whole invite to read out (`ABC-DEF-GHJK-MNPQ-RSTU`); self-hosted: `ABC-DEF`. */
  get inviteCode(): string {
    if (this.#transport.kind === 'relays') return formatInviteCode(this.roomCode, this.secret);
    return formatRoomCode(this.roomCode);
  }

  /**
   * Updates the local rider's state; it is broadcast with the next 4 Hz tick. Returns false (and
   * keeps the previous state) if the values are invalid (NaN, out of range).
   */
  setLocalState(state: LocalRiderState): boolean {
    const now = this.#now();
    const checked = sanitizeRiderState({ ...state, name: this.name, sentAt: Math.max(1, now) });
    if (!checked) return false;
    const { name: _n, sentAt: _s, ...local } = checked;
    this.#local = { state: local, at: now };
    return true;
  }

  /** Remote riders at local time `now` (default: the clock), leader first, `gapM` vs. local. */
  getRiders(now: number = this.#now()): GroupRider[] {
    return this.#riders.getRiders(now, this.#localDistance(now));
  }

  /**
   * Connection status of every peer in the room (including ones that sent no state yet). Relay
   * rides list only peers with an open connection; `name` is '' until the peer has sent it.
   */
  getPeers(): MeshPeer[] {
    return this.#transport.getPeers();
  }

  /** Called when riders, connections, names, problems or the signalling state change. */
  onChange(listener: () => void): Unsubscribe {
    return this.#events.on('change', listener);
  }

  /** The ride ended by itself (e.g. `no-relay`: no relay server reachable). Fired once. */
  onFailure(listener: (failure: TransportFailure) => void): Unsubscribe {
    return this.#events.on('failure', listener);
  }

  /**
   * Non-fatal trouble of the last minute, latest per code: `secret-mismatch` (someone with the
   * room code but another secret), `peer-unreachable` (no direct connection), `room-full`.
   */
  getProblems(): TransportProblem[] {
    const now = this.#now();
    return this.#problems.filter((p) => now - p.at < PROBLEM_KEEP_MS);
  }

  /** Diagnostic log lines from the transport (relay connections, peers, failures). */
  onLog(listener: (line: TransportLog) => void): Unsubscribe {
    return this.#events.on('log', listener);
  }

  /**
   * Called **synchronously** when a peer enters the room (or is first heard of), before any
   * message can be exchanged with it through this ride: self-hosted, the data channel needs
   * further signalling round-trips; relays, the transport announces the peer before it lets the
   * first message from or to it through. Either way this fires from the same event that creates
   * the transport's record of the peer.
   * Because a document request is only ever answered for the *current* document of a kind,
   * documents replaced or withdrawn inside this listener can never reach the newcomer. Use it
   * for anything that must change before a new peer is served (docs/p2p.md, "Peer-join
   * ordering"). Also followed by an `onChange` notification.
   */
  onPeerJoined(listener: (peer: PeerJoined) => void): Unsubscribe {
    return this.#events.on('peer-joined', listener);
  }

  // ---- shared documents (see docs/p2p.md, "Shared documents") ---------------------------------

  /**
   * Offers `text` (opaque, e.g. an encoded workout) to the group as the local rider's current
   * document of `kind` (`[a-z0-9-]`, ≤ 32 chars). Sharing the same kind again replaces it. At most
   * 16 KiB UTF-8 per document, 4 kinds and 32 KiB in total. `id` is the content hash.
   */
  shareDocument(kind: string, text: string): ShareResult {
    return this.#docs.share(kind, text);
  }

  /** Withdraws the local document of `kind`. Returns false if there was none. */
  unshareDocument(kind: string): boolean {
    return this.#docs.unshare(kind);
  }

  /** Documents the local rider currently shares. */
  getLocalDocuments(): LocalDocument[] {
    return this.#docs.getLocal();
  }

  /** Complete, hash-verified documents currently shared by the other riders. */
  getSharedDocuments(): SharedDocument[] {
    return this.#docs.getShared();
  }

  /** A remote document fully arrived (`available`) or is gone (`removed`). */
  onDocument(listener: (event: DocumentEvent) => void): Unsubscribe {
    return this.#docs.on('document', listener);
  }

  /**
   * Tells the others that document `id` of `kind` starts in `inMs` (0 .. 10 min) from now. The
   * remaining delay is re-sent a few times, so receivers need no synchronised clocks. Not
   * delivered to the local `onStart` listeners; use the returned `startsAt` (local clock).
   */
  announceStart(kind: string, id: string, inMs: number): StartResult {
    return this.#docs.announceStart(kind, id, inMs);
  }

  /** Another rider announced a start; fired once per announcement. */
  onStart(listener: (start: StartAnnouncement) => void): Unsubscribe {
    return this.#docs.on('start', listener);
  }

  /** Received start announcements (best estimate, refined by re-sends), until 10 s after. */
  getStartAnnouncements(): StartAnnouncement[] {
    return this.#docs.getStarts();
  }

  /** Leaves the room and closes all connections. Idempotent. */
  leave(): void {
    if (this.#left) return;
    this.#left = true;
    this.#timers.clearInterval(this.#interval);
    this.#docs.close();
    for (const off of this.#unsubscribe) off();
    this.#transport.close();
    this.#riders.clear();
    this.#events.emit('change', undefined);
    this.#events.clear();
  }

  #peerName(peerId: string): string {
    const fromMesh = this.#transport.getPeers().find((p) => p.peerId === peerId)?.name;
    const fromState = this.#riders.getRiders(this.#now(), 0).find((r) => r.peerId === peerId)?.name;
    return sanitizeName(fromMesh || fromState || '') || 'Rider';
  }

  #localDistance(now: number): number {
    if (!this.#local) return 0;
    const { state, at } = this.#local;
    return extrapolateDistance(state.distanceM, state.speedMps, now - at);
  }

  #message(): string | null {
    if (!this.#local) return null;
    const now = this.#now();
    return encodeStateMessage({
      ...this.#local.state,
      distanceM: this.#localDistance(now),
      name: this.name,
      sentAt: now,
    });
  }

  #broadcast(): void {
    const msg = this.#message();
    if (msg) this.#transport.broadcast(msg);
  }

  #sendTo(peerId: string): void {
    const msg = this.#message();
    if (msg) this.#transport.send(peerId, msg);
  }
}
