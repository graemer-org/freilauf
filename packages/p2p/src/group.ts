import {
  SharedDocuments,
  type DocumentEvent,
  type LocalDocument,
  type SharedDocument,
  type ShareResult,
  type StartAnnouncement,
  type StartResult,
} from './documents';
import { PeerMesh, type MeshPeer } from './mesh';
import {
  decodeStateMessage,
  encodeStateMessage,
  extrapolateDistance,
  RemoteRiders,
  sanitizeRiderState,
} from './riderState';
import { buildJoinLink, generateRoomCode, parseRoomCode } from './roomCode';
import { defaultTimers, Events, type Timers, type Unsubscribe } from './runtime';
import {
  sanitizeName,
  SignallingError,
  type SignallingChannel,
  type SignallingState,
} from './signalling/channel';
import { WebSocketSignalling, type WebSocketFactory } from './signalling/websocket';
import type { GroupRider, RiderState } from './types';
import type { IceServerConfig, PeerConnectionFactory } from './webrtc';

/** A peer that just entered the room (see `GroupRide.onPeerJoined`). */
export interface PeerJoined {
  peerId: string;
  /** Display name from signalling (sanitised; may be 'Rider' until known). */
  name: string;
}

/** What the app feeds in; name and timestamp are added by GroupRide. */
export type LocalRiderState = Omit<RiderState, 'name' | 'sentAt'>;

export const BROADCAST_INTERVAL_MS = 250; // 4 Hz

export interface GroupRideDeps {
  /** ws(s):// URL of the signalling server. Required unless `signalling` is given. */
  signallingUrl?: string;
  /** Custom signalling channel (overrides `signallingUrl`). Must not have joined yet. */
  signalling?: SignallingChannel;
  /** WebSocket constructor for the default signalling (default: global WebSocket). */
  createWebSocket?: WebSocketFactory;
  /** RTCPeerConnection factory (default: global RTCPeerConnection). */
  createPeerConnection?: PeerConnectionFactory;
  /** ICE servers (default: public STUN). */
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

/**
 * A group ride: joins a room, keeps a full WebRTC mesh to the other riders, broadcasts the local
 * rider's state at 4 Hz and exposes the remote riders extrapolated to "now".
 */
export class GroupRide {
  readonly roomCode: string;
  readonly name: string;
  #signalling: SignallingChannel;
  #mesh: PeerMesh;
  #riders = new RemoteRiders();
  #docs: SharedDocuments;
  #events = new Events<{ change: undefined; 'peer-joined': PeerJoined }>();
  #now: () => number;
  #timers: Timers;
  #interval: unknown;
  #signallingUrl: string | undefined;
  #local: { state: LocalRiderState; at: number } | null = null;
  #left = false;
  #unsubscribe: Unsubscribe[] = [];

  /** Creates a new room with a random code and joins it. */
  static create(name: string, deps: GroupRideDeps): Promise<GroupRide> {
    return GroupRide.join(generateRoomCode(), name, deps);
  }

  /**
   * Joins the room `roomCode` (user input is normalised). Rejects with a `SignallingError`
   * (`code` e.g. `room-full`, `join-timeout`) or an Error for an invalid code / missing URL.
   */
  static async join(roomCode: string, name: string, deps: GroupRideDeps): Promise<GroupRide> {
    const code = parseRoomCode(roomCode);
    if (!code) throw new SignallingError('invalid-room', `Invalid room code: ${roomCode}`);
    const ride = new GroupRide(code, name, deps);
    try {
      await ride.#signalling.join(code, ride.name);
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
    this.#signallingUrl = deps.signallingUrl;
    let signalling = deps.signalling;
    if (!signalling) {
      if (!deps.signallingUrl) throw new Error('GroupRide needs signallingUrl or signalling.');
      signalling = new WebSocketSignalling({
        url: deps.signallingUrl,
        createWebSocket: deps.createWebSocket,
        timers: this.#timers,
      });
    }
    this.#signalling = signalling;
    this.#mesh = new PeerMesh({
      signalling,
      createPeerConnection: deps.createPeerConnection,
      iceServers: deps.iceServers,
      timers: this.#timers,
    });
    const mesh = this.#mesh;
    this.#docs = new SharedDocuments({
      send: (peerId, data) => mesh.send(peerId, data),
      broadcast: (data) => mesh.broadcast(data),
      peerName: (peerId) => this.#peerName(peerId),
      now: this.#now,
      timers: this.#timers,
      maxMessageBytes: deps.documentMessageMaxBytes,
    });
    const changed = () => this.#events.emit('change', undefined);
    this.#unsubscribe = [
      // Synchronous, and strictly before the data channel to that peer can exist (see
      // onPeerJoined): the mesh emits this when it first learns of the peer.
      this.#mesh.on('peer-joined', ({ peerId, name }) => {
        this.#events.emit('peer-joined', { peerId, name: sanitizeName(name) || 'Rider' });
      }),
      this.#mesh.on('message', ({ peerId, data }) => {
        const state = decodeStateMessage(data);
        if (state) {
          if (this.#riders.ingest(peerId, state, this.#now())) changed();
          return;
        }
        this.#docs.handleMessage(peerId, data); // ignores anything that is not a doc message
      }),
      this.#mesh.on('peer-left', ({ peerId }) => {
        this.#riders.remove(peerId);
        this.#docs.removePeer(peerId);
        changed();
      }),
      this.#mesh.on('status', ({ peerId, status }) => {
        if (status === 'connected') {
          this.#sendTo(peerId);
          this.#docs.peerConnected(peerId);
        }
        changed();
      }),
      signalling.on('state', changed),
    ];
    this.#interval = this.#timers.setInterval(
      () => this.#broadcast(),
      deps.broadcastIntervalMs ?? BROADCAST_INTERVAL_MS,
    );
  }

  get localPeerId(): string {
    return this.#signalling.peerId;
  }

  get signallingState(): SignallingState {
    return this.#signalling.state;
  }

  get hasLeft(): boolean {
    return this.#left;
  }

  /** `freilauf://join/<CODE>?s=<url>` for sharing (without `s` when a custom channel is used). */
  get joinLink(): string {
    return buildJoinLink(this.roomCode, this.#signallingUrl);
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

  /** Connection status of every peer in the room (including ones that sent no state yet). */
  getPeers(): MeshPeer[] {
    return this.#mesh.getPeers();
  }

  /** Called when riders, connections or the signalling state change. */
  onChange(listener: () => void): Unsubscribe {
    return this.#events.on('change', listener);
  }

  /**
   * Called **synchronously** when a peer enters the room (or is first heard of), before any
   * data-channel message can be exchanged with it: the channel needs further signalling
   * round-trips, and this fires from the same event that creates the mesh's record of the peer.
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
    this.#mesh.close();
    this.#signalling.leave();
    this.#riders.clear();
    this.#events.emit('change', undefined);
    this.#events.clear();
  }

  #peerName(peerId: string): string {
    const fromMesh = this.#mesh.getPeers().find((p) => p.peerId === peerId)?.name;
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
    if (msg) this.#mesh.broadcast(msg);
  }

  #sendTo(peerId: string): void {
    const msg = this.#message();
    if (msg) this.#mesh.send(peerId, msg);
  }
}
