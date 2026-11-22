import { randomBytes } from './runtime';

/** Unambiguous alphabet: no 0/O, 1/I/L. 31 symbols -> 31^6 ≈ 887 million codes. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const JOIN_LINK_PREFIX = 'freilauf://join/';

const CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/**
 * Generates a random room code. `random` returns bytes (default: crypto); rejection sampling keeps
 * the distribution uniform.
 */
export function generateRoomCode(random: (n: number) => Uint8Array = randomBytes): string {
  const limit = 256 - (256 % ROOM_CODE_ALPHABET.length);
  let out = '';
  while (out.length < ROOM_CODE_LENGTH) {
    for (const b of random(ROOM_CODE_LENGTH * 2)) {
      if (b >= limit) continue;
      out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
      if (out.length === ROOM_CODE_LENGTH) break;
    }
  }
  return out;
}

/** Upper-cases and strips whitespace, dashes, underscores and dots. Does not validate. */
export function normaliseRoomCode(input: string): string {
  return input.toUpperCase().replace(/[\s\-_.]/g, '');
}

export function isValidRoomCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** Normalises user input and returns the code, or null if it is not a valid room code. */
export function parseRoomCode(input: string): string | null {
  const code = normaliseRoomCode(input);
  return isValidRoomCode(code) ? code : null;
}

/** Display form, e.g. `ABC-DEF`. */
export function formatRoomCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

export interface JoinLink {
  roomCode: string;
  /** Signalling server URL (ws:// or wss://) if the link carried one. */
  signallingUrl?: string;
}

function isWebSocketUrl(url: string): boolean {
  return /^wss?:\/\/[^\s/?#]+/i.test(url);
}

/** `freilauf://join/<CODE>?s=<signalling url>` (the `s` parameter is optional). */
export function buildJoinLink(roomCode: string, signallingUrl?: string): string {
  const code = parseRoomCode(roomCode);
  if (!code) throw new Error(`Invalid room code: ${roomCode}`);
  if (signallingUrl === undefined) return JOIN_LINK_PREFIX + code;
  if (!isWebSocketUrl(signallingUrl)) {
    throw new Error(`Signalling URL must start with ws:// or wss://: ${signallingUrl}`);
  }
  return `${JOIN_LINK_PREFIX}${code}?s=${encodeURIComponent(signallingUrl)}`;
}

/**
 * Parses a join link or a bare room code (as typed or pasted by a user). Returns null when no
 * valid room code can be found. An `s` parameter that is not a ws(s) URL is ignored.
 */
export function parseJoinLink(input: string): JoinLink | null {
  const text = input.trim();
  const match = /^freilauf:\/\/join\/([^?#]*)(?:\?([^#]*))?/i.exec(text);
  if (!match) {
    const code = parseRoomCode(text);
    return code ? { roomCode: code } : null;
  }
  let rawCode: string;
  try {
    rawCode = decodeURIComponent(match[1] ?? '');
  } catch {
    return null;
  }
  const code = parseRoomCode(rawCode.replace(/\/+$/, ''));
  if (!code) return null;
  const result: JoinLink = { roomCode: code };
  for (const pair of (match[2] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq) !== 's') continue;
    try {
      const url = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      if (isWebSocketUrl(url)) result.signallingUrl = url;
    } catch {
      // malformed escape: ignore the parameter
    }
  }
  return result;
}
