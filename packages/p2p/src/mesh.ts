import { defaultTimers, Events, reportError, type Timers, type Unsubscribe } from './runtime';
import type { SignallingChannel } from './signalling/channel';
import type { PeerInfo } from './signalling/protocol';
import type { MeshPeer, PeerStatus } from './transport';
import {
  DEFAULT_ICE_SERVERS,
  defaultPeerConnectionFactory,
  type DataChannelLike,
  type IceCandidateLike,
  type IceServerConfig,
  type PeerConnectionFactory,
  type PeerConnectionLike,
} from './webrtc';

// The peer types are shared with the relay transport (../transport.ts).
export type { MeshPeer, PeerStatus };

export interface PeerMeshEvents {
  'peer-joined': PeerInfo;
  'peer-left': { peerId: string };
  status: { peerId: string; status: PeerStatus };
  message: { peerId: string; data: string };
}

export interface PeerMeshOptions {
  signalling: SignallingChannel;
  createPeerConnection?: PeerConnectionFactory;
  /** Default: public STUN (see DEFAULT_ICE_SERVERS). Add TURN servers here. */
  iceServers?: IceServerConfig[];
  timers?: Timers;
  /** An attempt that has not opened the data channel by then counts as failed. Default 20 s. */
  connectTimeoutMs?: number;
  /** How long `disconnected` may last before the connection is torn down. Default 8 s. */
  disconnectTimeoutMs?: number;
  /** Retry backoff for the offering side: initial, doubling, capped. Default 1 s .. 30 s. */
  retryDelayMs?: { initial: number; max: number };
  /** Larger incoming data-channel messages are dropped. Default 16 KiB. */
  maxMessageLength?: number;
}

/** Wire format of the opaque `data` the mesh sends through the signalling channel. */
export type MeshSignal =
  | { kind: 'offer'; gen: number; sdp: string }
  | { kind: 'answer'; gen: number; sdp: string }
  | { kind: 'candidate'; gen: number; candidate: IceCandidateLike }
  | { kind: 'restart'; gen: number };

/** The single data channel: unreliable + unordered, pre-negotiated on id 0 by both sides. */
export const STATE_CHANNEL_LABEL = 'freilauf-state';
export const STATE_CHANNEL_INIT = {
  negotiated: true,
  id: 0,
  ordered: false,
  maxRetransmits: 0,
} as const;

interface PeerRecord {
  peerId: string;
  name: string;
  isOfferer: boolean;
  status: PeerStatus;
  removed: boolean;
  pc: PeerConnectionLike | null;
  channel: DataChannelLike | null;
  /** Negotiation generation; bumped by the offerer for every attempt. Stale signals are dropped. */
  gen: number;
  attempts: number;
  /** Remote candidates waiting for the remote description. */
  remoteCandidates: IceCandidateLike[];
  /** Local candidates waiting until our offer/answer has been sent; null once it has. */
  localCandidates: IceCandidateLike[] | null;
  queue: Promise<void>;
  connectTimer: unknown;
  disconnectTimer: unknown;
  retryTimer: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSignal(data: unknown): MeshSignal | null {
  if (!isRecord(data)) return null;
  const gen = data['gen'];
  if (typeof gen !== 'number' || !Number.isSafeInteger(gen) || gen < 0) return null;
  switch (data['kind']) {
    case 'offer':
    case 'answer': {
      const sdp = data['sdp'];
      return typeof sdp === 'string' ? { kind: data['kind'], gen, sdp } : null;
    }
    case 'candidate': {
      const c = data['candidate'];
      if (!isRecord(c) || typeof c['candidate'] !== 'string') return null;
      return { kind: 'candidate', gen, candidate: pickCandidate(c) };
    }
    case 'restart':
      return { kind: 'restart', gen };
    default:
      return null;
  }
}

function pickCandidate(c: Record<string, unknown> | IceCandidateLike): IceCandidateLike {
  const r = c as Record<string, unknown>;
  const out: IceCandidateLike = { candidate: String(r['candidate']) };
  if (typeof r['sdpMid'] === 'string') out.sdpMid = r['sdpMid'];
  if (typeof r['sdpMLineIndex'] === 'number') out.sdpMLineIndex = r['sdpMLineIndex'];
  if (typeof r['usernameFragment'] === 'string') out.usernameFragment = r['usernameFragment'];
  return out;
}

/**
 * Full mesh of WebRTC data channels between the members of a signalling room.
 *
 * Glare-free negotiation: for each pair, the peer with the lexicographically smaller id creates
 * the connection and sends the offer; the other one only answers. Failure handling is
 * "tear down and re-offer": when a connection fails (ICE `failed`, `disconnected` for too long,
 * the data channel closes, or no channel within `connectTimeoutMs`), it is closed and the
 * offerer starts a fresh connection (new generation) with exponential backoff. If the answering
 * side notices first, it asks the offerer via a `restart` signal. Retries continue for as long
 * as the peer is in the room.
 */
export class PeerMesh {
  #signalling: SignallingChannel;
  #createPc: PeerConnectionFactory;
  #iceServers: IceServerConfig[];
  #timers: Timers;
  #connectTimeoutMs: number;
  #disconnectTimeoutMs: number;
  #retryInitial: number;
  #retryMax: number;
  #maxMessageLength: number;
  #peers = new Map<string, PeerRecord>();
  #events = new Events<PeerMeshEvents>();
  #unsubscribe: Unsubscribe[];
  #closed = false;

  constructor(options: PeerMeshOptions) {
    this.#signalling = options.signalling;
    this.#createPc = options.createPeerConnection ?? defaultPeerConnectionFactory;
    this.#iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.#timers = options.timers ?? defaultTimers;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    this.#disconnectTimeoutMs = options.disconnectTimeoutMs ?? 8_000;
    this.#retryInitial = options.retryDelayMs?.initial ?? 1_000;
    this.#retryMax = options.retryDelayMs?.max ?? 30_000;
    this.#maxMessageLength = options.maxMessageLength ?? 16 * 1024;
    const s = this.#signalling;
    this.#unsubscribe = [
      s.on('peers', (peers) => this.#reconcile(peers)),
      s.on('peer-joined', (peer) => this.#ensurePeer(peer.peerId, peer.name)),
      s.on('peer-left', ({ peerId }) => this.#removePeer(peerId)),
      s.on('signal', ({ from, data }) => this.#onSignal(from, data)),
    ];
  }

  get localPeerId(): string {
    return this.#signalling.peerId;
  }

  on<K extends keyof PeerMeshEvents>(
    event: K,
    listener: (value: PeerMeshEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  getPeers(): MeshPeer[] {
    return [...this.#peers.values()].map((r) => ({
      peerId: r.peerId,
      name: r.name,
      status: r.status,
      isOfferer: r.isOfferer,
      attempts: r.attempts,
    }));
  }

  getStatus(peerId: string): PeerStatus | null {
    return this.#peers.get(peerId)?.status ?? null;
  }

  /** Sends to one peer if its channel is open. Unreliable: delivery is not guaranteed. */
  send(peerId: string, data: string): boolean {
    const channel = this.#peers.get(peerId)?.channel;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  /** Sends to every connected peer; returns how many it was handed to. */
  broadcast(data: string): number {
    let n = 0;
    for (const peerId of this.#peers.keys()) if (this.send(peerId, data)) n++;
    return n;
  }

  /** Closes all connections. Does not leave the signalling room (the owner does that). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#unsubscribe) off();
    for (const rec of this.#peers.values()) {
      rec.removed = true;
      this.#clearTimers(rec);
      this.#teardown(rec);
    }
    this.#peers.clear();
    this.#events.clear();
  }

  // ---- membership ----------------------------------------------------------------------------

  #reconcile(peers: PeerInfo[]): void {
    const present = new Set(peers.map((p) => p.peerId));
    for (const peerId of [...this.#peers.keys()]) {
      if (!present.has(peerId)) this.#removePeer(peerId);
    }
    for (const p of peers) this.#ensurePeer(p.peerId, p.name);
  }

  #ensurePeer(peerId: string, name: string): PeerRecord | null {
    if (this.#closed || peerId === this.localPeerId) return null;
    const existing = this.#peers.get(peerId);
    if (existing) {
      if (name) existing.name = name;
      return existing;
    }
    const rec: PeerRecord = {
      peerId,
      name,
      isOfferer: this.localPeerId < peerId,
      status: 'connecting',
      removed: false,
      pc: null,
      channel: null,
      gen: 0,
      attempts: 0,
      remoteCandidates: [],
      localCandidates: null,
      queue: Promise.resolve(),
      connectTimer: null,
      disconnectTimer: null,
      retryTimer: null,
    };
    this.#peers.set(peerId, rec);
    this.#events.emit('peer-joined', { peerId, name });
    this.#events.emit('status', { peerId, status: 'connecting' });
    if (rec.isOfferer) this.#startAttempt(rec);
    return rec;
  }

  #removePeer(peerId: string): void {
    const rec = this.#peers.get(peerId);
    if (!rec) return;
    rec.removed = true;
    this.#clearTimers(rec);
    this.#teardown(rec);
    this.#peers.delete(peerId);
    this.#events.emit('peer-left', { peerId });
  }

  // ---- connection lifecycle ------------------------------------------------------------------

  #setStatus(rec: PeerRecord, status: PeerStatus): void {
    if (rec.status === status || rec.removed) return;
    rec.status = status;
    this.#events.emit('status', { peerId: rec.peerId, status });
  }

  #clearTimers(rec: PeerRecord): void {
    for (const t of [rec.connectTimer, rec.disconnectTimer, rec.retryTimer]) {
      if (t !== null) this.#timers.clearTimeout(t);
    }
    rec.connectTimer = rec.disconnectTimer = rec.retryTimer = null;
  }

  #teardown(rec: PeerRecord): void {
    const { pc, channel } = rec;
    rec.pc = null;
    rec.channel = null;
    rec.remoteCandidates = [];
    rec.localCandidates = null;
    if (channel) {
      channel.onopen = channel.onclose = channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // ignore
      }
    }
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
  }

  #sendSignal(rec: PeerRecord, signal: MeshSignal): void {
    this.#signalling.sendSignal(rec.peerId, signal);
  }

  /** Creates a fresh connection + pre-negotiated data channel for `rec` (closing any old one). */
  #newConnection(rec: PeerRecord): PeerConnectionLike {
    this.#teardown(rec);
    const pc = this.#createPc({ iceServers: this.#iceServers });
    const channel = pc.createDataChannel(STATE_CHANNEL_LABEL, { ...STATE_CHANNEL_INIT });
    rec.pc = pc;
    rec.channel = channel;
    rec.remoteCandidates = [];
    rec.localCandidates = [];

    pc.onicecandidate = (event) => {
      if (rec.pc !== pc || !event.candidate || !event.candidate.candidate) return;
      const candidate = pickCandidate(event.candidate);
      if (rec.localCandidates) rec.localCandidates.push(candidate);
      else this.#sendSignal(rec, { kind: 'candidate', gen: rec.gen, candidate });
    };
    pc.onconnectionstatechange = () => {
      if (rec.pc !== pc) return;
      switch (pc.connectionState) {
        case 'failed':
          this.#failed(rec, pc);
          return;
        case 'disconnected':
          if (rec.status === 'connected') this.#setStatus(rec, 'disconnected');
          if (rec.disconnectTimer === null) {
            rec.disconnectTimer = this.#timers.setTimeout(() => {
              rec.disconnectTimer = null;
              if (rec.pc === pc && pc.connectionState !== 'connected') this.#failed(rec, pc);
            }, this.#disconnectTimeoutMs);
          }
          return;
        case 'connected':
          if (rec.disconnectTimer !== null) {
            this.#timers.clearTimeout(rec.disconnectTimer);
            rec.disconnectTimer = null;
          }
          if (channel.readyState === 'open') this.#setStatus(rec, 'connected');
          return;
        default:
          return;
      }
    };
    channel.onopen = () => {
      if (rec.channel !== channel) return;
      if (rec.connectTimer !== null) {
        this.#timers.clearTimeout(rec.connectTimer);
        rec.connectTimer = null;
      }
      rec.attempts = 0;
      this.#setStatus(rec, 'connected');
    };
    channel.onclose = () => {
      if (rec.channel === channel) this.#failed(rec, pc);
    };
    channel.onmessage = (event) => {
      if (rec.channel !== channel) return;
      const data = event.data;
      if (typeof data !== 'string' || data.length > this.#maxMessageLength) return;
      this.#events.emit('message', { peerId: rec.peerId, data });
    };
    return pc;
  }

  #flushLocalCandidates(rec: PeerRecord): void {
    const queued = rec.localCandidates ?? [];
    rec.localCandidates = null;
    for (const candidate of queued) {
      this.#sendSignal(rec, { kind: 'candidate', gen: rec.gen, candidate });
    }
  }

  async #flushRemoteCandidates(rec: PeerRecord, pc: PeerConnectionLike): Promise<void> {
    const queued = rec.remoteCandidates;
    rec.remoteCandidates = [];
    for (const c of queued) {
      if (rec.pc !== pc) return;
      await pc.addIceCandidate(c).catch(() => {});
    }
  }

  /** Runs `task` after all earlier signalling work for this peer (keeps SDP/ICE in order). */
  #enqueue(rec: PeerRecord, task: () => Promise<void>): void {
    rec.queue = rec.queue
      .then(() => (rec.removed ? undefined : task()))
      .catch((err: unknown) => {
        reportError(`negotiation with ${rec.peerId} failed`, err);
        if (rec.pc) this.#failed(rec, rec.pc);
      });
  }

  /** Offerer only: start a new connection attempt (new generation). */
  #startAttempt(rec: PeerRecord): void {
    if (rec.removed || this.#closed) return;
    this.#clearTimers(rec);
    rec.gen += 1;
    rec.attempts += 1;
    const gen = rec.gen;
    const pc = this.#newConnection(rec);
    this.#setStatus(rec, 'connecting');
    rec.connectTimer = this.#timers.setTimeout(() => {
      rec.connectTimer = null;
      if (rec.pc === pc && rec.status !== 'connected') this.#failed(rec, pc);
    }, this.#connectTimeoutMs);
    this.#enqueue(rec, async () => {
      const offer = await pc.createOffer();
      if (rec.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (rec.pc !== pc) return;
      this.#sendSignal(rec, { kind: 'offer', gen, sdp: offer.sdp ?? '' });
      this.#flushLocalCandidates(rec);
    });
  }

  #failed(rec: PeerRecord, pc: PeerConnectionLike): void {
    if (rec.pc !== pc || rec.removed) return;
    this.#clearTimers(rec);
    this.#teardown(rec);
    this.#setStatus(rec, 'failed');
    if (rec.isOfferer) this.#scheduleRetry(rec);
    else this.#sendSignal(rec, { kind: 'restart', gen: rec.gen });
  }

  #scheduleRetry(rec: PeerRecord): void {
    if (rec.retryTimer !== null || rec.removed) return;
    const delay = Math.min(this.#retryMax, this.#retryInitial * 2 ** Math.max(0, rec.attempts - 1));
    rec.retryTimer = this.#timers.setTimeout(() => {
      rec.retryTimer = null;
      this.#startAttempt(rec);
    }, delay);
  }

  // ---- incoming signals ----------------------------------------------------------------------

  #onSignal(from: string, data: unknown): void {
    const signal = parseSignal(data);
    if (!signal) return;
    // The server only relays within a room, so an unknown sender is a member we missed.
    const rec = this.#peers.get(from) ?? this.#ensurePeer(from, '');
    if (!rec) return;
    this.#enqueue(rec, () => this.#handleSignal(rec, signal));
  }

  async #handleSignal(rec: PeerRecord, signal: MeshSignal): Promise<void> {
    switch (signal.kind) {
      case 'offer': {
        if (rec.isOfferer || signal.gen < rec.gen) return;
        if (signal.gen === rec.gen && rec.pc?.remoteDescription) return; // duplicate
        if (signal.gen > rec.gen || !rec.pc) {
          rec.gen = signal.gen;
          this.#newConnection(rec);
          rec.attempts += 1;
          this.#setStatus(rec, 'connecting');
        }
        const pc = rec.pc;
        if (!pc) return;
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        if (rec.pc !== pc) return;
        await this.#flushRemoteCandidates(rec, pc);
        const answer = await pc.createAnswer();
        if (rec.pc !== pc) return;
        await pc.setLocalDescription(answer);
        if (rec.pc !== pc) return;
        this.#sendSignal(rec, { kind: 'answer', gen: signal.gen, sdp: answer.sdp ?? '' });
        this.#flushLocalCandidates(rec);
        return;
      }
      case 'answer': {
        const pc = rec.pc;
        if (!rec.isOfferer || !pc || signal.gen !== rec.gen) return;
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        if (rec.pc !== pc) return;
        await this.#flushRemoteCandidates(rec, pc);
        return;
      }
      case 'candidate': {
        const pc = rec.pc;
        if (!pc || signal.gen !== rec.gen) return;
        if (!pc.remoteDescription) {
          rec.remoteCandidates.push(signal.candidate);
          return;
        }
        await pc.addIceCandidate(signal.candidate).catch(() => {});
        return;
      }
      case 'restart': {
        if (!rec.isOfferer || signal.gen !== rec.gen) return;
        if (rec.pc) {
          this.#clearTimers(rec);
          this.#teardown(rec);
          this.#setStatus(rec, 'failed');
        }
        this.#scheduleRetry(rec);
        return;
      }
    }
  }
}
