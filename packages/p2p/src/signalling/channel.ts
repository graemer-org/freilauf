import type { Unsubscribe } from '../runtime';
import type { PeerInfo } from './protocol';
import { GroupError, sanitizeName } from '../transport';

export type SignallingState = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'closed';

export interface SignallingEvents {
  /** The other peers in the room, sent after every (re)join. Authoritative presence list. */
  peers: PeerInfo[];
  'peer-joined': PeerInfo;
  'peer-left': { peerId: string };
  /** Opaque payload relayed from another peer (SDP / ICE in practice). */
  signal: { from: string; data: unknown };
  /** `fatal` errors are followed by `closed`; others (e.g. rate-limited) are informational. */
  error: { code: string; message: string; fatal: boolean };
  state: SignallingState;
  /** The channel is permanently closed (leave() or a fatal error). Not emitted on reconnects. */
  closed: { reason: string };
}

/**
 * The pluggable signalling abstraction. Anything that can relay small JSON-able payloads between
 * the members of a room can implement it (WebSocket server, in-memory hub for tests, ...).
 */
export interface SignallingChannel {
  readonly peerId: string;
  readonly state: SignallingState;
  /**
   * Joins a room. Resolves with the peers already present; rejects with a `SignallingError`
   * (e.g. code `room-full`) if the room cannot be joined. Call at most once per channel.
   */
  join(room: string, name: string): Promise<PeerInfo[]>;
  /** Leaves the room and closes the channel for good. Idempotent. */
  leave(): void;
  /** Sends `data` to one peer in the room. Returns false if it could not be sent right now. */
  sendSignal(to: string, data: unknown): boolean;
  on<K extends keyof SignallingEvents>(
    event: K,
    listener: (value: SignallingEvents[K]) => void,
  ): Unsubscribe;
}

/** A `GroupError` raised by a signalling channel (self-hosted path). */
export class SignallingError extends GroupError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'SignallingError';
  }
}

/** Error codes after which a channel gives up instead of reconnecting. */
export const FATAL_SIGNALLING_ERRORS: ReadonlySet<string> = new Set([
  'invalid-room',
  'invalid-peer-id',
  'invalid-name',
  'room-full',
  'already-joined',
  'replaced',
  'join-timeout',
]);

// Moved to ../transport.ts (shared by both transports); re-exported for existing imports.
export { sanitizeName };
