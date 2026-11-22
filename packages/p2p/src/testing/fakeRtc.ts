import type {
  DataChannelInitLike,
  DataChannelLike,
  DataChannelState,
  IceCandidateLike,
  PeerConnectionConfig,
  PeerConnectionLike,
  PeerConnectionState,
  SessionDescriptionLike,
} from '../webrtc';
import type { Timers } from '../runtime';

const later = (fn: () => void): void => {
  void Promise.resolve().then(fn);
};

/**
 * Simulated data-channel link quality, applied per message (not to signalling). Defaults: a
 * perfect, in-order link.
 */
export interface FakeLinkConditions {
  /** Probability (0..1) that a message is dropped. */
  lossRate?: number;
  /** Probability (0..1) that a delivered message is delivered a second time. */
  duplicateRate?: number;
  /**
   * Each delivery is delayed by a uniform random 0..maxDelayMs (via `timers`), which reorders
   * messages. Requires `timers` in the network options; ignored without.
   */
  maxDelayMs?: number;
}

export interface FakeRtcNetworkOptions {
  /** Seed for the deterministic PRNG behind `conditions` (default 1). */
  seed?: number;
  /** Timers used for delayed delivery (pass a FakeClock's timers). */
  timers?: Timers;
  conditions?: FakeLinkConditions;
}

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * In-memory stand-in for WebRTC: every `FakePeerConnection` created from the same network can
 * "connect" to another one by exchanging the fake SDP/ICE it produces, exactly like real
 * connections do through signalling. Supports only pre-negotiated data channels (`negotiated:
 * true` + `id`), which is what PeerMesh uses. All events are delivered asynchronously
 * (microtasks), so it works with real and fake timers alike.
 */
export class FakeRtcNetwork {
  readonly connections: FakePeerConnection[] = [];
  #byId = new Map<string, FakePeerConnection>();
  #next = 1;
  /** When set, connections created from now on never complete ICE (to test timeouts). */
  blockConnectivity = false;
  /** Link quality for data-channel messages; may be changed at any time. */
  conditions: FakeLinkConditions;
  /** Data-channel messages dropped by `conditions.lossRate` so far. */
  dropped = 0;
  #random: () => number;
  #timers: Timers | undefined;

  constructor(options: FakeRtcNetworkOptions = {}) {
    this.#random = mulberry32(options.seed ?? 1);
    this.#timers = options.timers;
    this.conditions = { ...options.conditions };
  }

  /** Pass this as `createPeerConnection`. */
  readonly createPeerConnection = (config: PeerConnectionConfig): FakePeerConnection => {
    const pc = new FakePeerConnection(this, `pc${this.#next++}`, config);
    this.connections.push(pc);
    this.#byId.set(pc.id, pc);
    return pc;
  };

  lookup(id: string): FakePeerConnection | undefined {
    return this.#byId.get(id);
  }

  /** Simulates an ICE failure on `pc` and its counterpart (both go to `failed`). */
  fail(pc: FakePeerConnection): void {
    const remote = pc.remote;
    pc.simulateFailure();
    remote?.simulateFailure();
  }

  /** @internal Delivers one data-channel message according to `conditions`. */
  deliver(fn: () => void): void {
    const { lossRate = 0, duplicateRate = 0, maxDelayMs = 0 } = this.conditions;
    if (lossRate > 0 && this.#random() < lossRate) {
      this.dropped++;
      return;
    }
    const copies = duplicateRate > 0 && this.#random() < duplicateRate ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const timers = this.#timers;
      if (timers && maxDelayMs > 0) {
        const delay = Math.floor(this.#random() * (maxDelayMs + 1));
        timers.setTimeout(fn, delay);
      } else {
        later(fn);
      }
    }
  }

  /** Connections that are not closed. */
  get open(): FakePeerConnection[] {
    return this.connections.filter((c) => c.connectionState !== 'closed');
  }
}

export class FakeDataChannel implements DataChannelLike {
  readonly label: string;
  readonly id: number;
  readyState: DataChannelState = 'connecting';
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  peer: FakeDataChannel | null = null;
  readonly sent: string[] = [];

  #network: FakeRtcNetwork | null;

  constructor(label: string, id: number, network: FakeRtcNetwork | null = null) {
    this.label = label;
    this.id = id;
    this.#network = network;
  }

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open');
    this.sent.push(data);
    const peer = this.peer;
    const deliver = () => {
      if (peer && peer.readyState === 'open') peer.onmessage?.({ data });
    };
    if (this.#network) this.#network.deliver(deliver);
    else later(deliver);
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    const peer = this.peer;
    this.peer = null;
    if (peer) peer.remoteClosed();
  }

  /** @internal */
  open(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    later(() => this.onopen?.({}));
  }

  /** @internal */
  remoteClosed(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.peer = null;
    later(() => this.onclose?.({}));
  }
}

export class FakePeerConnection implements PeerConnectionLike {
  readonly id: string;
  readonly config: PeerConnectionConfig;
  connectionState: PeerConnectionState = 'new';
  signalingState = 'stable';
  localDescription: SessionDescriptionLike | null = null;
  remoteDescription: SessionDescriptionLike | null = null;
  onicecandidate: ((event: { candidate: IceCandidateLike | null }) => void) | null = null;
  onconnectionstatechange: ((event: unknown) => void) | null = null;
  readonly channels: FakeDataChannel[] = [];
  remote: FakePeerConnection | null = null;
  readonly addedCandidates: IceCandidateLike[] = [];
  #network: FakeRtcNetwork;
  #gotRemoteCandidate = false;
  #blocked: boolean;

  constructor(network: FakeRtcNetwork, id: string, config: PeerConnectionConfig) {
    this.#network = network;
    this.id = id;
    this.config = config;
    this.#blocked = network.blockConnectivity;
  }

  async createOffer(): Promise<SessionDescriptionLike> {
    this.#assertOpen();
    return { type: 'offer', sdp: `fake-sdp:${this.id}` };
  }

  async createAnswer(): Promise<SessionDescriptionLike> {
    this.#assertOpen();
    if (this.remoteDescription?.type !== 'offer') throw new Error('InvalidStateError: no offer');
    return { type: 'answer', sdp: `fake-sdp:${this.id}` };
  }

  async setLocalDescription(description: SessionDescriptionLike): Promise<void> {
    this.#assertOpen();
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    this.#setConnectionState('connecting');
    // Trickle one host candidate, then end-of-candidates.
    later(() => {
      if (this.connectionState === 'closed') return;
      this.onicecandidate?.({
        candidate: { candidate: `candidate:fake ${this.id}`, sdpMid: '0', sdpMLineIndex: 0 },
      });
      this.onicecandidate?.({ candidate: null });
    });
    this.#tryConnect();
  }

  async setRemoteDescription(description: SessionDescriptionLike): Promise<void> {
    this.#assertOpen();
    const id = /^fake-sdp:(\S+)$/.exec(description.sdp ?? '')?.[1];
    const remote = id ? this.#network.lookup(id) : undefined;
    if (!remote) throw new Error('OperationError: unknown fake SDP');
    if (description.type === 'offer' && this.signalingState !== 'stable') {
      throw new Error('InvalidStateError: offer in wrong state');
    }
    if (description.type === 'answer' && this.signalingState !== 'have-local-offer') {
      throw new Error('InvalidStateError: answer in wrong state');
    }
    this.remote = remote;
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.#tryConnect();
  }

  async addIceCandidate(candidate: IceCandidateLike): Promise<void> {
    this.#assertOpen();
    if (!this.remoteDescription) throw new Error('InvalidStateError: no remote description');
    this.addedCandidates.push(candidate);
    if (this.remote && candidate.candidate === `candidate:fake ${this.remote.id}`) {
      this.#gotRemoteCandidate = true;
      this.#tryConnect();
    }
  }

  createDataChannel(label: string, init: DataChannelInitLike): FakeDataChannel {
    this.#assertOpen();
    if (!init.negotiated || init.id === undefined) {
      throw new Error('FakePeerConnection only supports negotiated data channels');
    }
    const channel = new FakeDataChannel(label, init.id, this.#network);
    this.channels.push(channel);
    return channel;
  }

  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed'; // no event, as in browsers
    this.signalingState = 'closed';
    for (const c of this.channels) {
      c.readyState = 'closed';
      const peer = c.peer;
      c.peer = null;
      peer?.remoteClosed();
    }
    const remote = this.remote;
    if (remote && remote.remote === this && remote.connectionState === 'connected') {
      remote.#setConnectionState('disconnected');
    }
  }

  /** @internal */
  simulateFailure(): void {
    if (this.connectionState === 'closed') return;
    this.#setConnectionState('failed');
    for (const c of this.channels) c.remoteClosed();
  }

  #assertOpen(): void {
    if (this.connectionState === 'closed') throw new Error('InvalidStateError: closed');
  }

  #setConnectionState(state: PeerConnectionState): void {
    if (this.connectionState === state || this.connectionState === 'closed') return;
    this.connectionState = state;
    later(() => {
      if (this.connectionState === state) this.onconnectionstatechange?.({});
    });
  }

  #ready(): boolean {
    return (
      this.connectionState === 'connecting' &&
      this.signalingState === 'stable' &&
      this.localDescription !== null &&
      this.remoteDescription !== null &&
      this.#gotRemoteCandidate &&
      !this.#blocked
    );
  }

  #tryConnect(): void {
    const remote = this.remote;
    if (!remote || remote.remote !== this || !this.#ready() || !remote.#ready()) return;
    this.#setConnectionState('connected');
    remote.#setConnectionState('connected');
    for (const c of this.channels) {
      const peer = remote.channels.find((rc) => rc.id === c.id && rc.readyState === 'connecting');
      if (!peer || c.readyState !== 'connecting') continue;
      c.peer = peer;
      peer.peer = c;
      c.open();
      peer.open();
    }
  }
}
