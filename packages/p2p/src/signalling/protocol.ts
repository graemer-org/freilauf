/**
 * Client-side copy of the signalling wire protocol.
 *
 * The source of truth is `apps/signalling/src/protocol.ts`. The types below must stay structurally
 * identical; `protocol.test.ts` asserts that at type level and the integration tests round-trip
 * against the real server. (The client package cannot import the server at runtime: it runs in a
 * browser renderer, the server under Node.)
 */

export const PROTOCOL_VERSION = 1;
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,16}$/;
export const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
export const MAX_NAME_LENGTH = 24;
export const MAX_PEERS_PER_ROOM = 8;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const CLOSE_REPLACED = 4000;

export interface PeerInfo {
  peerId: string;
  name: string;
}

export interface JoinMessage {
  type: 'join';
  room: string;
  peerId: string;
  name: string;
}

export interface LeaveMessage {
  type: 'leave';
}

export interface SignalMessage {
  type: 'signal';
  to: string;
  data: unknown;
}

export type ClientMessage = JoinMessage | LeaveMessage | SignalMessage;

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

// ---- client-only helpers ---------------------------------------------------------------------

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'invalid-message',
  'invalid-room',
  'invalid-peer-id',
  'invalid-name',
  'room-full',
  'already-joined',
  'not-joined',
  'unknown-peer',
  'message-too-large',
  'rate-limited',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parsePeerInfo(v: unknown): PeerInfo | null {
  if (!isRecord(v) || typeof v['peerId'] !== 'string' || typeof v['name'] !== 'string') return null;
  return { peerId: v['peerId'], name: v['name'] };
}

/** Defensive parse of a frame from the server. Returns null for anything unexpected. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  switch (v['type']) {
    case 'joined': {
      const peers = v['peers'];
      if (typeof v['room'] !== 'string' || typeof v['peerId'] !== 'string') return null;
      if (!Array.isArray(peers)) return null;
      const list: PeerInfo[] = [];
      for (const p of peers) {
        const info = parsePeerInfo(p);
        if (info) list.push(info);
      }
      return { type: 'joined', room: v['room'], peerId: v['peerId'], peers: list };
    }
    case 'peer-joined': {
      const peer = parsePeerInfo(v['peer']);
      return peer ? { type: 'peer-joined', peer } : null;
    }
    case 'peer-left':
      return typeof v['peerId'] === 'string' ? { type: 'peer-left', peerId: v['peerId'] } : null;
    case 'signal':
      return typeof v['from'] === 'string' && v['data'] !== undefined
        ? { type: 'signal', from: v['from'], data: v['data'] }
        : null;
    case 'error': {
      const code = v['code'];
      if (typeof code !== 'string' || !ERROR_CODES.has(code)) return null;
      const message = typeof v['message'] === 'string' ? v['message'] : code;
      return { type: 'error', code: code as ErrorCode, message };
    }
    default:
      return null;
  }
}
