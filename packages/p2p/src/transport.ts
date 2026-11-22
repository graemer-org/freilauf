/**
 * What `GroupRide` needs from the network underneath it: a set of peers, their connection status,
 * small text messages to one or all of them, and a handful of events. Two implementations exist:
 *
 * - `RelayTransport` (`transports/relay.ts`, the default): peers find each other through public
 *   relay servers via Trystero, then talk over direct WebRTC data channels.
 * - `SignallingMeshTransport` (`transports/selfHosted.ts`, advanced fallback): our own signalling
 *   server (`apps/signalling`) plus `PeerMesh`.
 *
 * Everything above this interface — rider state, shared documents, the synchronised start and the
 * `onPeerJoined` ordering — is transport-independent (docs/p2p.md, "Transports").
 */
import type { Unsubscribe } from './runtime';

/** Most riders in one group, including the local one (both transports enforce it). */
export const MAX_RIDERS_PER_GROUP = 8;

/**
 * Per-peer connection status:
 * - `connecting`: negotiating (or waiting for the other side's offer)
 * - `connected`: messages can be exchanged
 * - `disconnected`: ICE lost connectivity; may recover on its own, otherwise becomes `failed`
 * - `failed`: torn down; a new attempt is scheduled (the offering side drives it)
 */
export type PeerStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface MeshPeer {
  peerId: string;
  /** Display name; '' until the peer has told us (relay transport: its `hello` message). */
  name: string;
  status: PeerStatus;
  /** Self-hosted mesh: true if this side sends the offers for this pair. Relay transport: false. */
  isOfferer: boolean;
  /** Connection attempts since the last successful connection. */
  attempts: number;
}

/**
 * How far the local rider is in getting into the group:
 * `connecting` (no relay / signalling server reached yet), `joined` (discoverable: others can
 * find us), `reconnecting` (lost it, retrying; existing peer connections keep working),
 * `closed` (left, or failed for good).
 */
export type TransportState = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'closed';

/** Something worth telling the rider about while in the group (not fatal). */
export type TransportProblemCode =
  /** A peer with the same room but another secret tried to connect (wrong / missing secret). */
  | 'secret-mismatch'
  /** A direct connection to a peer could not be established (restrictive network, no TURN). */
  | 'peer-unreachable'
  /** The group is full; another rider was turned away, or we were. */
  | 'room-full';

export interface TransportProblem {
  code: TransportProblemCode;
  /** The (remote) peer involved, if known. */
  peerId?: string;
  /** Local clock, epoch ms. */
  at: number;
}

/** Fatal: the transport gave up (it is closed afterwards). */
export interface TransportFailure {
  /** E.g. `no-relay` (no relay server reachable), `room-full`. */
  code: string;
  message: string;
}

/** One line for the diagnostic log (never contains secrets). */
export interface TransportLog {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, string | number | boolean | null | string[]>;
}

export interface TransportEvents {
  /** Fired synchronously, before any message from or to that peer passes this transport. */
  'peer-joined': { peerId: string; name: string };
  'peer-left': { peerId: string };
  /** The peer's name (or something else about it) changed. */
  'peer-updated': { peerId: string };
  status: { peerId: string; status: PeerStatus };
  message: { peerId: string; data: string };
  state: TransportState;
  problem: TransportProblem;
  failed: TransportFailure;
  log: TransportLog;
}

export interface GroupTransport {
  /** 'relays' (default) or 'self-hosted' (own signalling server). */
  readonly kind: 'relays' | 'self-hosted';
  /** Valid once `start()` resolved. */
  readonly localPeerId: string;
  readonly state: TransportState;
  /**
   * Enters the room. Resolves once the room is entered as far as this transport can tell without
   * other peers; rejects with a `GroupError` (`code`) otherwise. Call once.
   */
  start(room: string, name: string): Promise<void>;
  getPeers(): MeshPeer[];
  /** Sends to one connected peer. Returns false if it could not be handed over right now. */
  send(peerId: string, data: string): boolean;
  /** Sends to every connected peer; returns how many it was handed to. */
  broadcast(data: string): number;
  on<K extends keyof TransportEvents>(
    event: K,
    listener: (value: TransportEvents[K]) => void,
  ): Unsubscribe;
  /** Leaves the room and closes all connections. Idempotent. */
  close(): void;
}

/** An error with a machine-readable `code` (e.g. `invalid-room`, `room-full`, `no-relay`). */
export class GroupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GroupError';
    this.code = code;
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

/** Trims, strips control / bidi characters and cuts to `max` code points. */
export function sanitizeName(name: string, max = 24): string {
  return [...name.replace(CONTROL_CHARS, '').trim()].slice(0, max).join('').trim();
}
