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

// ─────────────────────────── invite secrets ───────────────────────────
//
// A relay ride (the default) is identified by the room code and protected by a secret: the
// secret is the Trystero room password, from which the key that encrypts the WebRTC handshake
// on the public relays is derived (PBKDF2, see docs/adr/0003-signalling-via-public-relays.md).
// The relays see a hash of the app id and the room code — a 6-character code can be guessed
// from it — but never the secret, so they cannot read or join the handshake.
//
// The secret is 11 random symbols of the room-code alphabet (≈ 54 bits) plus one check symbol
// over code and secret, so a mistyped or misheard invite is caught locally ("typo") instead of
// silently opening a different room. Written out in full, an invite reads
// `ABC-DEF-GHJK-MNPQ-RSTU` (18 symbols); as a link, `freilauf://join/ABCDEF#GHJKMNPQRSTU`.

export const INVITE_SECRET_LENGTH = 12;
const SECRET_RANDOM_LENGTH = INVITE_SECRET_LENGTH - 1;
const FULL_INVITE_LENGTH = ROOM_CODE_LENGTH + INVITE_SECRET_LENGTH;

function symbolValue(ch: string): number {
  return ROOM_CODE_ALPHABET.indexOf(ch);
}

/**
 * Check symbol over `symbols` (code + random part): Σ (i + 1) · value(sᵢ) mod 31. 31 is prime and
 * the weights 1..17 are distinct and non-zero mod 31, so every single wrong symbol and every swap
 * of two neighbours changes it.
 */
function checkSymbol(symbols: string): string {
  let sum = 0;
  for (let i = 0; i < symbols.length; i++) sum += (i + 1) * symbolValue(symbols[i]!);
  return ROOM_CODE_ALPHABET[sum % ROOM_CODE_ALPHABET.length]!;
}

function randomSymbols(count: number, random: (n: number) => Uint8Array): string {
  const limit = 256 - (256 % ROOM_CODE_ALPHABET.length);
  let out = '';
  while (out.length < count) {
    for (const b of random(count * 2)) {
      if (b >= limit) continue;
      out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
      if (out.length === count) break;
    }
  }
  return out;
}

/** A new secret for the room `roomCode` (crypto random by default). */
export function generateInviteSecret(
  roomCode: string,
  random: (n: number) => Uint8Array = randomBytes,
): string {
  const code = parseRoomCode(roomCode);
  if (!code) throw new Error(`Invalid room code: ${roomCode}`);
  const body = randomSymbols(SECRET_RANDOM_LENGTH, random);
  return body + checkSymbol(code + body);
}

/** True when `secret` (normalised) is a well-formed secret for `roomCode`, check symbol included. */
export function isValidInviteSecret(roomCode: string, secret: string): boolean {
  const code = parseRoomCode(roomCode);
  const s = normaliseRoomCode(secret);
  if (!code || s.length !== INVITE_SECRET_LENGTH || !isAlphabet(s)) return false;
  return checkSymbol(code + s.slice(0, SECRET_RANDOM_LENGTH)) === s[SECRET_RANDOM_LENGTH];
}

function isAlphabet(s: string): boolean {
  for (const ch of s) if (symbolValue(ch) < 0) return false;
  return true;
}

/** `ABC-DEF-GHJK-MNPQ-RSTU`: the whole invite, for reading out or typing. */
export function formatInviteCode(roomCode: string, secret: string): string {
  const all = normaliseRoomCode(roomCode) + normaliseRoomCode(secret);
  return [all.slice(0, 3), all.slice(3, 6), all.slice(6, 10), all.slice(10, 14), all.slice(14)]
    .filter((g) => g !== '')
    .join('-');
}

/** `freilauf://join/<CODE>#<SECRET>`: the invite link of a relay ride. */
export function buildInviteLink(roomCode: string, secret: string): string {
  const code = parseRoomCode(roomCode);
  if (!code) throw new Error(`Invalid room code: ${roomCode}`);
  if (!isValidInviteSecret(code, secret)) throw new Error('Invalid invite secret.');
  return `${JOIN_LINK_PREFIX}${code}#${normaliseRoomCode(secret)}`;
}

// ─────────────────────────── parsing ───────────────────────────

export interface JoinLink {
  roomCode: string;
  /** Relay rides: the secret (validated, normalised). Absent for bare codes and legacy links. */
  secret?: string;
  /** Legacy / self-hosted links: the signalling server URL (ws:// or wss://). */
  signallingUrl?: string;
}

export type InviteParseResult =
  | { ok: true; invite: JoinLink }
  /** `typo`: it looks like an invite, but a symbol is wrong, missing or extra (check failed). */
  | { ok: false; reason: 'not-an-invite' | 'typo' };

function isWebSocketUrl(url: string): boolean {
  return /^wss?:\/\/[^\s/?#]+/i.test(url);
}

/** `freilauf://join/<CODE>?s=<signalling url>` (legacy / self-hosted; `s` is optional). */
export function buildJoinLink(roomCode: string, signallingUrl?: string): string {
  const code = parseRoomCode(roomCode);
  if (!code) throw new Error(`Invalid room code: ${roomCode}`);
  if (signallingUrl === undefined) return JOIN_LINK_PREFIX + code;
  if (!isWebSocketUrl(signallingUrl)) {
    throw new Error(`Signalling URL must start with ws:// or wss://: ${signallingUrl}`);
  }
  return `${JOIN_LINK_PREFIX}${code}?s=${encodeURIComponent(signallingUrl)}`;
}

/** Code (+ secret) from normalised symbols: 6 = code only, 18 = code and secret. */
function splitSymbols(symbols: string): InviteParseResult {
  if (symbols.length === ROOM_CODE_LENGTH) {
    return isValidRoomCode(symbols)
      ? { ok: true, invite: { roomCode: symbols } }
      : { ok: false, reason: 'not-an-invite' };
  }
  if (!isAlphabet(symbols)) return { ok: false, reason: 'not-an-invite' };
  if (symbols.length === FULL_INVITE_LENGTH) {
    const roomCode = symbols.slice(0, ROOM_CODE_LENGTH);
    const secret = symbols.slice(ROOM_CODE_LENGTH);
    return isValidInviteSecret(roomCode, secret)
      ? { ok: true, invite: { roomCode, secret } }
      : { ok: false, reason: 'typo' };
  }
  // One or two symbols too many or too few: almost certainly a mistyped full invite.
  if (Math.abs(symbols.length - FULL_INVITE_LENGTH) <= 2) return { ok: false, reason: 'typo' };
  return { ok: false, reason: 'not-an-invite' };
}

/**
 * Parses what a rider pasted or typed: an invite link (`freilauf://join/CODE#SECRET`, also the
 * whole invite in the path), a legacy link with `?s=<server>`, the full invite code
 * (`ABC-DEF-GHJK-MNPQ-RSTU`) or a bare room code. Never throws.
 */
export function parseInvite(input: string): InviteParseResult {
  const text = input.trim();
  const match = /^freilauf:\/\/join\/([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(text);
  if (!match) return splitSymbols(normaliseRoomCode(text));
  let rawPath: string;
  let rawFragment: string;
  try {
    rawPath = decodeURIComponent(match[1] ?? '');
    rawFragment = decodeURIComponent(match[3] ?? '');
  } catch {
    return { ok: false, reason: 'not-an-invite' };
  }
  const path = normaliseRoomCode(rawPath.replace(/\/+$/, ''));
  if (path === '') return { ok: false, reason: 'not-an-invite' };
  const fragment = normaliseRoomCode(rawFragment);
  const parsed = splitSymbols(
    fragment && path.length === ROOM_CODE_LENGTH ? path + fragment : path,
  );
  if (!parsed.ok) {
    // A valid code with a damaged secret after it is a typo, not garbage.
    return fragment && isValidRoomCode(path) ? { ok: false, reason: 'typo' } : parsed;
  }
  const invite = parsed.invite;
  for (const pair of (match[2] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq) !== 's') continue;
    try {
      const url = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      if (isWebSocketUrl(url)) invite.signallingUrl = url;
    } catch {
      // malformed escape: ignore the parameter
    }
  }
  return { ok: true, invite };
}

/**
 * Like `parseInvite`, but returns null for anything that is not a usable invite (including
 * typos). An `s` parameter that is not a ws(s) URL is ignored.
 */
export function parseJoinLink(input: string): JoinLink | null {
  const result = parseInvite(input);
  return result.ok ? result.invite : null;
}
