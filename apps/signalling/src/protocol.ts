/**
 * Wire protocol of the Freilauf signalling server (JSON text frames over WebSocket).
 *
 * This file is the single source of truth. `packages/p2p/src/signalling/protocol.ts` keeps a
 * structurally identical copy (the server must not depend on the client package and vice versa
 * at runtime); `packages/p2p/src/signalling/protocol.test.ts` fails the type check and the tests
 * if the two drift apart.
 *
 * Keep this file free of imports and non-erasable syntax: it runs under Node type stripping.
 */

export const PROTOCOL_VERSION = 1;

/** Room codes accepted by the server. Clients use a stricter 6-char subset (see p2p roomCode). */
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,16}$/;
/** Peer ids are chosen by the client (random); the server only checks the shape. */
export const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
export const MAX_NAME_LENGTH = 24;
export const MAX_PEERS_PER_ROOM = 8;
export const MAX_MESSAGE_BYTES = 64 * 1024;

export interface PeerInfo {
  peerId: string;
  name: string;
}

// ---- client -> server ----------------------------------------------------------------------

export interface JoinMessage {
  type: 'join';
  room: string;
  peerId: string;
  name: string;
}

export interface LeaveMessage {
  type: 'leave';
}

/** `data` is opaque to the server (SDP / ICE payloads). */
export interface SignalMessage {
  type: 'signal';
  to: string;
  data: unknown;
}

export type ClientMessage = JoinMessage | LeaveMessage | SignalMessage;

// ---- server -> client ----------------------------------------------------------------------

/** Reply to `join`: the other peers already in the room (excluding the joiner). */
export interface JoinedMessage {
  type: 'joined';
  room: string;
  peerId: string;
  peers: PeerInfo[];
}

export interface PeerJoinedMessage {
  type: 'peer-joined';
  peer: PeerInfo;
}

export interface PeerLeftMessage {
  type: 'peer-left';
  peerId: string;
}

export interface RelayedSignalMessage {
  type: 'signal';
  from: string;
  data: unknown;
}

export type ErrorCode =
  | 'invalid-message'
  | 'invalid-room'
  | 'invalid-peer-id'
  | 'invalid-name'
  | 'room-full'
  | 'already-joined'
  | 'not-joined'
  | 'unknown-peer'
  | 'message-too-large'
  | 'rate-limited';

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  JoinedMessage | PeerJoinedMessage | PeerLeftMessage | RelayedSignalMessage | ErrorMessage;

/** Close code the server uses when a newer connection with the same peerId takes over. */
export const CLOSE_REPLACED = 4000;

export type ParseResult =
  { ok: true; message: ClientMessage } | { ok: false; code: ErrorCode; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates a raw text frame from a client. Never throws. */
export function parseClientMessage(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'invalid-message', message: 'Message is not valid JSON.' };
  }
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return {
      ok: false,
      code: 'invalid-message',
      message: 'Message must be an object with a type.',
    };
  }
  switch (value['type']) {
    case 'join': {
      const { room, peerId, name } = value;
      if (typeof room !== 'string' || !ROOM_CODE_PATTERN.test(room)) {
        return {
          ok: false,
          code: 'invalid-room',
          message: 'Room code must be 4-16 characters A-Z / 0-9.',
        };
      }
      if (typeof peerId !== 'string' || !PEER_ID_PATTERN.test(peerId)) {
        return {
          ok: false,
          code: 'invalid-peer-id',
          message: 'Peer id must be 4-64 characters A-Z, a-z, 0-9, _ or -.',
        };
      }
      if (typeof name !== 'string' || name.trim() === '' || [...name].length > MAX_NAME_LENGTH) {
        return {
          ok: false,
          code: 'invalid-name',
          message: `Name must be 1-${MAX_NAME_LENGTH} characters.`,
        };
      }
      return { ok: true, message: { type: 'join', room, peerId, name: name.trim() } };
    }
    case 'leave':
      return { ok: true, message: { type: 'leave' } };
    case 'signal': {
      const { to, data } = value;
      if (typeof to !== 'string' || !PEER_ID_PATTERN.test(to)) {
        return { ok: false, code: 'invalid-peer-id', message: 'Signal target is not a peer id.' };
      }
      if (data === undefined) {
        return { ok: false, code: 'invalid-message', message: 'Signal needs a data payload.' };
      }
      return { ok: true, message: { type: 'signal', to, data } };
    }
    default:
      return { ok: false, code: 'invalid-message', message: 'Unknown message type.' };
  }
}
