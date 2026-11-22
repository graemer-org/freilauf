import { Events, randomBytes, reportError, type Timers, type Unsubscribe } from './runtime';

/**
 * Shared documents over the unreliable, unordered state channel (see docs/p2p.md, "Shared
 * documents"). Each rider can offer one opaque text document per `kind` (e.g. a workout encoded
 * by `encodeWorkout`); others fetch it by content hash with retries, in chunks small enough to
 * survive packet loss. A separate "start" message lets everyone begin a document at the same
 * instant without comparing wall clocks.
 */

export const DOC_MESSAGE_VERSION = 1;
/** Kind token: lower-case letters, digits and `-`, 1–32 chars, not starting with `-`. */
export const DOCUMENT_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Content hash as sent on the wire: 16 lower-case hex digits. */
export const DOCUMENT_ID_PATTERN = /^[0-9a-f]{16}$/;
/** Session ids and announce ids. */
const TOKEN_PATTERN = /^[a-z0-9]{4,16}$/;

/** Largest document text, in UTF-8 bytes. */
export const MAX_DOCUMENT_BYTES = 16 * 1024;
/** Documents (kinds) one rider may share at once; also what we keep per remote rider. */
export const MAX_DOCUMENTS_PER_PEER = 4;
/** Total document bytes one rider may share / we keep per remote rider. */
export const MAX_DOCUMENT_BYTES_PER_PEER = 32 * 1024;
export const MAX_CHUNKS_PER_DOCUMENT = 128;
/** Concurrent incoming transfers (all peers together); further ones wait for a slot. */
export const MAX_PENDING_TRANSFERS = 16;
/**
 * Default upper bound for one outgoing document message (UTF-8 bytes). Chosen to fit a single
 * SCTP packet: with `maxRetransmits: 0` a message spread over several packets is lost when any
 * of them is, so small chunks are much more robust under loss than one 16 KiB message.
 */
export const DEFAULT_DOC_MESSAGE_MAX_BYTES = 1_100;
export const MIN_DOC_MESSAGE_MAX_BYTES = 200;
/** Incoming document messages longer than this (UTF-16 code units) are dropped. */
export const MAX_INCOMING_DOC_MESSAGE_LENGTH = 16 * 1024;
/** How often the list of shared documents is re-broadcast (also sent at once on change). */
export const DOC_LIST_INTERVAL_MS = 1_000;
/** Internal housekeeping tick (requests, resends). */
export const DOC_TICK_MS = 50;
/** Request retry: wait `initial` after the last request / received chunk, doubling to `max`. */
export const DOC_REQUEST_BACKOFF_MS = { initial: 300, max: 1_200 } as const;
/** Per requesting peer token bucket for answering requests (bytes). */
export const DOC_SERVE_BUDGET = { burstBytes: 48 * 1024, bytesPerSecond: 24 * 1024 } as const;
/** Start announcements are re-sent this often, at most this many times, while still ahead. */
export const START_RESEND_INTERVAL_MS = 250;
export const START_RESENDS = 8;
export const MAX_START_DELAY_MS = 10 * 60_000;
/** A re-sent start whose estimate differs more than this from the first one is ignored. */
export const MAX_START_DISAGREEMENT_MS = 2_000;
export const MAX_STARTS_PER_PEER = 8;
/** Received start announcements are remembered (for de-duplication) this long after the start. */
export const START_KEEP_AFTER_MS = 10_000;

// ---- public types ------------------------------------------------------------------------------

/** A complete, verified document received from another rider. */
export interface SharedDocument {
  peerId: string;
  peerName: string;
  kind: string;
  /** Content hash (16 hex digits) of `text`. */
  id: string;
  text: string;
  /** Local clock (ms) when the last chunk arrived. */
  receivedAt: number;
}

/** A document the local rider shares. */
export interface LocalDocument {
  kind: string;
  id: string;
  text: string;
}

export type DocumentEvent =
  | { type: 'available'; document: SharedDocument }
  | {
      type: 'removed';
      peerId: string;
      kind: string;
      id: string;
      /** `replaced`: the sharer now offers a different document of this kind (it follows). */
      reason: 'withdrawn' | 'replaced' | 'peer-left';
    };

export interface StartAnnouncement {
  announceId: string;
  peerId: string;
  peerName: string;
  kind: string;
  id: string;
  /** Delay from now (local clock) until the start; ≥ 0. */
  startsInMs: number;
  /** Local clock instant of the start (`now + startsInMs`). */
  startsAt: number;
}

export type ShareRejection =
  | 'closed'
  | 'invalid-kind'
  | 'invalid-text'
  | 'empty'
  | 'too-large'
  | 'too-many-documents'
  | 'too-many-bytes'
  | 'too-many-chunks';

export type ShareResult = { ok: true; id: string } | { ok: false; reason: ShareRejection };

export type StartResult =
  | { ok: true; announceId: string; startsAt: number }
  | { ok: false; reason: 'closed' | 'invalid-kind' | 'invalid-id' | 'invalid-delay' };

// ---- wire format -------------------------------------------------------------------------------

export interface DocListEntry {
  /** kind */
  k: string;
  /** content hash */
  id: string;
  /** UTF-8 bytes of the text */
  n: number;
  /** chunk count */
  c: number;
}

export type DocMessage =
  | { v: 1; type: 'doc-list'; sid: string; rev: number; docs: DocListEntry[] }
  | { v: 1; type: 'doc-req'; k: string; id: string; m?: number[] }
  | { v: 1; type: 'doc-chunk'; k: string; id: string; n: number; c: number; i: number; d: string }
  | { v: 1; type: 'doc-start'; a: string; k: string; id: string; in: number };

/** Most list entries a message may carry (more than we keep, for forward compatibility). */
const MAX_LIST_ENTRIES = 16;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}

function isKind(v: unknown): v is string {
  return typeof v === 'string' && DOCUMENT_KIND_PATTERN.test(v);
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && DOCUMENT_ID_PATTERN.test(v);
}

function isToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_PATTERN.test(v);
}

function parseEntry(v: unknown): DocListEntry | null {
  if (!isRecord(v)) return null;
  const { k, id, n, c } = v;
  if (!isKind(k) || !isId(id) || !isInt(n, 1, MAX_DOCUMENT_BYTES)) return null;
  if (!isInt(c, 1, Math.min(MAX_CHUNKS_PER_DOCUMENT, n))) return null;
  return { k, id, n, c };
}

/**
 * Parses a raw data-channel message into a document message. Never throws; null for anything
 * malformed, oversized, of another version or of an unknown type (e.g. `state`).
 */
export function decodeDocMessage(raw: unknown): DocMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_INCOMING_DOC_MESSAGE_LENGTH) return null;
  if (!raw.includes('"doc-')) return null; // cheap pre-filter: not one of ours
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(msg) || msg['v'] !== DOC_MESSAGE_VERSION) return null;
  switch (msg['type']) {
    case 'doc-list': {
      const { sid, rev, docs } = msg;
      if (!isToken(sid) || !isInt(rev, 1, Number.MAX_SAFE_INTEGER)) return null;
      if (!Array.isArray(docs) || docs.length > MAX_LIST_ENTRIES) return null;
      const entries: DocListEntry[] = [];
      const kinds = new Set<string>();
      for (const d of docs) {
        const e = parseEntry(d);
        if (!e || kinds.has(e.k)) return null; // inconsistent list: ignore it entirely
        kinds.add(e.k);
        entries.push(e);
      }
      return { v: 1, type: 'doc-list', sid, rev, docs: entries };
    }
    case 'doc-req': {
      const { k, id, m } = msg;
      if (!isKind(k) || !isId(id)) return null;
      if (m === undefined) return { v: 1, type: 'doc-req', k, id };
      if (!Array.isArray(m) || m.length === 0 || m.length > MAX_CHUNKS_PER_DOCUMENT) return null;
      if (!m.every((i) => isInt(i, 0, MAX_CHUNKS_PER_DOCUMENT - 1))) return null;
      return { v: 1, type: 'doc-req', k, id, m: m as number[] };
    }
    case 'doc-chunk': {
      const { k, id, n, c, i, d } = msg;
      if (!isKind(k) || !isId(id) || !isInt(n, 1, MAX_DOCUMENT_BYTES)) return null;
      if (!isInt(c, 1, Math.min(MAX_CHUNKS_PER_DOCUMENT, n)) || !isInt(i, 0, c - 1)) return null;
      if (typeof d !== 'string' || d.length === 0 || d.length > n) return null;
      return { v: 1, type: 'doc-chunk', k, id, n, c, i, d };
    }
    case 'doc-start': {
      const { a, k, id } = msg;
      const delay = msg['in'];
      if (!isToken(a) || !isKind(k) || !isId(id) || !isInt(delay, 0, MAX_START_DELAY_MS)) {
        return null;
      }
      return { v: 1, type: 'doc-start', a, k, id, in: delay };
    }
    default:
      return null; // unknown (future) type
  }
}

// ---- text helpers ------------------------------------------------------------------------------

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-8 length of `text` (a lone surrogate counts as 3 bytes, like U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (isHigh(c) && isLow(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** UTF-8 bytes one BMP code unit takes inside a JSON string literal (JSON.stringify escaping). */
function jsonUnitCost(c: number): number {
  if (c === 0x22 || c === 0x5c) return 2; // \" \\
  if (c < 0x20) return c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6;
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (isHigh(c) || isLow(c)) return 6; // lone surrogate -> \udxxx
  return 3;
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * Non-cryptographic 64-bit content hash (cyrb53-style, two 32-bit lanes over the UTF-16 code
 * units), as 16 hex digits. Detects corruption and mismatches, not tampering.
 */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return hex8(h2) + hex8(h1);
}

/**
 * Encodes `text` as `doc-chunk` messages of at most `maxBytes` UTF-8 bytes each (surrogate
 * pairs are never split). Null if it would need more than MAX_CHUNKS_PER_DOCUMENT chunks or
 * `maxBytes` is too small for the message overhead.
 */
export function encodeChunks(
  kind: string,
  id: string,
  text: string,
  maxBytes: number,
): string[] | null {
  const n = utf8Length(text);
  const placeholder = MAX_CHUNKS_PER_DOCUMENT * 10; // more digits than any real c / i
  const overhead = utf8Length(
    JSON.stringify({
      v: 1,
      type: 'doc-chunk',
      k: kind,
      id,
      n,
      c: placeholder,
      i: placeholder,
      d: '',
    }),
  );
  const budget = maxBytes - overhead;
  if (budget < 8) return null;
  const pieces: string[] = [];
  let start = 0;
  let cost = 0;
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i);
    const pair = isHigh(c) && isLow(text.charCodeAt(i + 1));
    const unitCost = pair ? 4 : jsonUnitCost(c);
    if (cost + unitCost > budget && i > start) {
      pieces.push(text.slice(start, i));
      if (pieces.length >= MAX_CHUNKS_PER_DOCUMENT) return null;
      start = i;
      cost = 0;
    }
    cost += unitCost;
    i += pair ? 2 : 1;
  }
  if (start < text.length) pieces.push(text.slice(start));
  const c = pieces.length;
  const messages = pieces.map((d, i) =>
    JSON.stringify({ v: 1, type: 'doc-chunk', k: kind, id, n, c, i, d }),
  );
  if (messages.some((m) => utf8Length(m) > maxBytes)) return null; // cannot happen; be safe
  return messages;
}

function randomToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (const b of randomBytes(10)) out += alphabet[b % alphabet.length];
  return out;
}

// ---- engine ------------------------------------------------------------------------------------

export interface SharedDocumentsOptions {
  /** Unreliable send to one peer; returns false if it could not be handed over. */
  send(peerId: string, data: string): boolean;
  /** Unreliable send to every connected peer. */
  broadcast(data: string): number;
  /** Display name of a peer (for events). */
  peerName(peerId: string): string;
  now: () => number;
  timers: Timers;
  /** Upper bound for one outgoing document message, UTF-8 bytes. Default 1100. */
  maxMessageBytes?: number;
}

interface OwnDocument {
  kind: string;
  id: string;
  text: string;
  bytes: number;
  chunks: string[];
  chunkBytes: number[];
}

interface OwnStart {
  announceId: string;
  kind: string;
  id: string;
  startsAt: number;
  sendsLeft: number;
  nextAt: number;
}

interface Transfer {
  kind: string;
  id: string;
  n: number;
  c: number;
  parts: Array<string | undefined>;
  have: number;
  bytes: number;
  /** Counts against MAX_PENDING_TRANSFERS once requests are being sent. */
  active: boolean;
  nextRequestAt: number;
  lastRequestAt: number;
  backoff: number;
}

interface StoredDocument {
  id: string;
  text: string;
  receivedAt: number;
}

interface RemotePeer {
  sid: string | null;
  rev: number;
  docs: Map<string, StoredDocument>;
  transfers: Map<string, Transfer>;
  /** Serving budget for this peer's requests. */
  tokens: number;
  tokensAt: number;
}

interface ReceivedStart {
  announceId: string;
  peerId: string;
  kind: string;
  id: string;
  startsAt: number;
}

interface SharedDocumentsEvents {
  document: DocumentEvent;
  start: StartAnnouncement;
}

/**
 * The shared-document protocol engine. Transport-agnostic: `GroupRide` feeds it incoming
 * messages and membership changes, it sends through the given callbacks.
 */
export class SharedDocuments {
  #opts: SharedDocumentsOptions;
  #maxMessageBytes: number;
  #events = new Events<SharedDocumentsEvents>();
  #own = new Map<string, OwnDocument>();
  #ownStarts: OwnStart[] = [];
  #sid = randomToken();
  #rev = 0;
  #nextListAt = 0;
  #peers = new Map<string, RemotePeer>();
  #starts = new Map<string, ReceivedStart>();
  #interval: unknown;
  #closed = false;

  constructor(options: SharedDocumentsOptions) {
    this.#opts = options;
    this.#maxMessageBytes = Math.max(
      MIN_DOC_MESSAGE_MAX_BYTES,
      Math.floor(options.maxMessageBytes ?? DEFAULT_DOC_MESSAGE_MAX_BYTES),
    );
    this.#interval = options.timers.setInterval(
      () => this.#safely(() => this.#tick()),
      DOC_TICK_MS,
    );
  }

  on<K extends keyof SharedDocumentsEvents>(
    event: K,
    listener: (value: SharedDocumentsEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  // ---- local side ------------------------------------------------------------------------------

  share(kind: string, text: string): ShareResult {
    if (this.#closed) return { ok: false, reason: 'closed' };
    if (!isKind(kind)) return { ok: false, reason: 'invalid-kind' };
    if (typeof text !== 'string') return { ok: false, reason: 'invalid-text' };
    if (text.length === 0) return { ok: false, reason: 'empty' };
    if (text.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too-large' };
    const bytes = utf8Length(text);
    if (bytes > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too-large' };
    const id = contentHash(text);
    const existing = this.#own.get(kind);
    if (existing?.id === id && existing.text === text) return { ok: true, id };
    if (!existing && this.#own.size >= MAX_DOCUMENTS_PER_PEER) {
      return { ok: false, reason: 'too-many-documents' };
    }
    let total = bytes;
    for (const d of this.#own.values()) if (d.kind !== kind) total += d.bytes;
    if (total > MAX_DOCUMENT_BYTES_PER_PEER) return { ok: false, reason: 'too-many-bytes' };
    const chunks = encodeChunks(kind, id, text, this.#maxMessageBytes);
    if (!chunks) return { ok: false, reason: 'too-many-chunks' };
    this.#own.set(kind, { kind, id, text, bytes, chunks, chunkBytes: chunks.map(utf8Length) });
    this.#changed();
    return { ok: true, id };
  }

  unshare(kind: string): boolean {
    if (this.#closed || !this.#own.delete(kind)) return false;
    this.#changed();
    return true;
  }

  getLocal(): LocalDocument[] {
    return [...this.#own.values()].map(({ kind, id, text }) => ({ kind, id, text }));
  }

  announceStart(kind: string, id: string, inMs: number): StartResult {
    if (this.#closed) return { ok: false, reason: 'closed' };
    if (!isKind(kind)) return { ok: false, reason: 'invalid-kind' };
    if (!isId(id)) return { ok: false, reason: 'invalid-id' };
    if (
      typeof inMs !== 'number' ||
      !Number.isFinite(inMs) ||
      inMs < 0 ||
      inMs > MAX_START_DELAY_MS
    ) {
      return { ok: false, reason: 'invalid-delay' };
    }
    const now = this.#opts.now();
    const start: OwnStart = {
      announceId: randomToken(),
      kind,
      id,
      startsAt: now + Math.round(inMs),
      sendsLeft: START_RESENDS,
      nextAt: now,
    };
    this.#ownStarts.push(start);
    this.#sendStarts(now);
    return { ok: true, announceId: start.announceId, startsAt: start.startsAt };
  }

  // ---- remote side -----------------------------------------------------------------------------

  getShared(): SharedDocument[] {
    const out: SharedDocument[] = [];
    for (const [peerId, p] of this.#peers) {
      for (const [kind, d] of p.docs) out.push(this.#toShared(peerId, kind, d));
    }
    return out;
  }

  /** Received start announcements whose start is not yet more than 10 s ago (best estimates). */
  getStarts(): StartAnnouncement[] {
    const now = this.#opts.now();
    return [...this.#starts.values()].map((s) => this.#toAnnouncement(s, now));
  }

  /** Feeds one incoming data-channel message. Returns true if it was a document message. */
  handleMessage(peerId: string, raw: string): boolean {
    if (this.#closed) return false;
    const msg = decodeDocMessage(raw);
    if (!msg) return false;
    this.#safely(() => {
      const now = this.#opts.now();
      switch (msg.type) {
        case 'doc-list':
          this.#onList(peerId, msg, now);
          return;
        case 'doc-req':
          this.#onRequest(peerId, msg, now);
          return;
        case 'doc-chunk':
          this.#onChunk(peerId, msg, now);
          return;
        case 'doc-start':
          this.#onStart(peerId, msg, now);
          return;
      }
    });
    return true;
  }

  /** A data channel to `peerId` (re)opened: tell it what we share and what is about to start. */
  peerConnected(peerId: string): void {
    if (this.#closed) return;
    this.#safely(() => {
      const now = this.#opts.now();
      if (this.#rev > 0) this.#opts.send(peerId, this.#listMessage());
      for (const s of this.#ownStarts) {
        if (s.startsAt > now) this.#opts.send(peerId, this.#startMessage(s, now));
      }
      // Retry pending transfers from this peer right away.
      for (const t of this.#peers.get(peerId)?.transfers.values() ?? []) {
        if (t.active) t.nextRequestAt = now;
      }
      this.#pump(now);
    });
  }

  /** `peerId` left the room: drop everything it shared. */
  removePeer(peerId: string): void {
    const p = this.#peers.get(peerId);
    for (const key of [...this.#starts.keys()]) {
      if (this.#starts.get(key)?.peerId === peerId) this.#starts.delete(key);
    }
    if (!p) return;
    this.#peers.delete(peerId);
    for (const [kind, d] of p.docs) {
      this.#events.emit('document', {
        type: 'removed',
        peerId,
        kind,
        id: d.id,
        reason: 'peer-left',
      });
    }
    if (!this.#closed) this.#pump(this.#opts.now());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#opts.timers.clearInterval(this.#interval);
    this.#own.clear();
    this.#ownStarts = [];
    this.#peers.clear();
    this.#starts.clear();
    this.#events.clear();
  }

  // ---- internals -------------------------------------------------------------------------------

  #safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      reportError('shared documents', err);
    }
  }

  #toShared(peerId: string, kind: string, d: StoredDocument): SharedDocument {
    return {
      peerId,
      peerName: this.#opts.peerName(peerId),
      kind,
      id: d.id,
      text: d.text,
      receivedAt: d.receivedAt,
    };
  }

  #toAnnouncement(s: ReceivedStart, now: number): StartAnnouncement {
    return {
      announceId: s.announceId,
      peerId: s.peerId,
      peerName: this.#opts.peerName(s.peerId),
      kind: s.kind,
      id: s.id,
      startsInMs: Math.max(0, s.startsAt - now),
      startsAt: s.startsAt,
    };
  }

  #changed(): void {
    this.#rev += 1;
    this.#opts.broadcast(this.#listMessage());
    this.#nextListAt = this.#opts.now() + DOC_LIST_INTERVAL_MS;
  }

  #listMessage(): string {
    const docs: DocListEntry[] = [...this.#own.values()].map((d) => ({
      k: d.kind,
      id: d.id,
      n: d.bytes,
      c: d.chunks.length,
    }));
    return JSON.stringify({ v: 1, type: 'doc-list', sid: this.#sid, rev: this.#rev, docs });
  }

  #startMessage(s: OwnStart, now: number): string {
    const remaining = Math.max(0, s.startsAt - now);
    return JSON.stringify({
      v: 1,
      type: 'doc-start',
      a: s.announceId,
      k: s.kind,
      id: s.id,
      in: remaining,
    });
  }

  #tick(): void {
    if (this.#closed) return;
    const now = this.#opts.now();
    if (this.#rev > 0 && now >= this.#nextListAt) {
      this.#opts.broadcast(this.#listMessage());
      this.#nextListAt = now + DOC_LIST_INTERVAL_MS;
    }
    this.#sendStarts(now);
    for (const [key, s] of this.#starts) {
      if (now > s.startsAt + START_KEEP_AFTER_MS) this.#starts.delete(key);
    }
    this.#pump(now);
  }

  #sendStarts(now: number): void {
    for (const s of this.#ownStarts) {
      if (s.sendsLeft <= 0 || now < s.nextAt) continue;
      // The first send always goes out (also for inMs = 0); re-sends only while still ahead.
      if (s.sendsLeft < START_RESENDS && s.startsAt <= now) {
        s.sendsLeft = 0;
        continue;
      }
      this.#opts.broadcast(this.#startMessage(s, now));
      s.sendsLeft -= 1;
      s.nextAt = now + START_RESEND_INTERVAL_MS;
    }
    this.#ownStarts = this.#ownStarts.filter((s) => s.sendsLeft > 0 || s.startsAt > now);
  }

  #peer(peerId: string): RemotePeer {
    let p = this.#peers.get(peerId);
    if (!p) {
      p = {
        sid: null,
        rev: 0,
        docs: new Map(),
        transfers: new Map(),
        tokens: DOC_SERVE_BUDGET.burstBytes,
        tokensAt: this.#opts.now(),
      };
      this.#peers.set(peerId, p);
    }
    return p;
  }

  #onList(peerId: string, msg: Extract<DocMessage, { type: 'doc-list' }>, now: number): void {
    const p = this.#peer(peerId);
    if (p.sid === msg.sid && msg.rev <= p.rev) {
      // Same list again: the sharer is alive and still offers what we miss, so ask again now
      // rather than waiting out a long backoff (bounded by the 1 s list rate).
      if (msg.rev === p.rev) this.#listSeen(p, now);
      return;
    }
    p.sid = msg.sid;
    p.rev = msg.rev;
    // Keep within the per-peer caps, in list order.
    const accepted = new Map<string, DocListEntry>();
    let bytes = 0;
    for (const e of msg.docs) {
      if (accepted.size >= MAX_DOCUMENTS_PER_PEER) break;
      if (bytes + e.n > MAX_DOCUMENT_BYTES_PER_PEER) continue;
      accepted.set(e.k, e);
      bytes += e.n;
    }
    const removed: DocumentEvent[] = [];
    for (const [kind, d] of p.docs) {
      const e = accepted.get(kind);
      if (e && e.id === d.id) continue;
      p.docs.delete(kind);
      removed.push({
        type: 'removed',
        peerId,
        kind,
        id: d.id,
        reason: e ? 'replaced' : 'withdrawn',
      });
    }
    for (const [kind, t] of p.transfers) {
      const e = accepted.get(kind);
      if (!e || e.id !== t.id || e.n !== t.n || e.c !== t.c) p.transfers.delete(kind);
    }
    this.#listSeen(p, now);
    for (const e of accepted.values()) {
      if (p.docs.has(e.k) || p.transfers.has(e.k)) continue;
      p.transfers.set(e.k, {
        kind: e.k,
        id: e.id,
        n: e.n,
        c: e.c,
        parts: new Array<string | undefined>(e.c).fill(undefined),
        have: 0,
        bytes: 0,
        active: false,
        nextRequestAt: now,
        lastRequestAt: -Infinity,
        backoff: DOC_REQUEST_BACKOFF_MS.initial,
      });
    }
    for (const ev of removed) this.#events.emit('document', ev);
    this.#pump(now);
  }

  #listSeen(p: RemotePeer, now: number): void {
    for (const t of p.transfers.values()) {
      if (t.active && now - t.lastRequestAt >= DOC_REQUEST_BACKOFF_MS.initial) {
        t.nextRequestAt = Math.min(t.nextRequestAt, now);
      }
    }
    this.#pump(now);
  }

  /** Activates waiting transfers (up to the cap) and sends due requests. */
  #pump(now: number): void {
    let active = 0;
    for (const p of this.#peers.values())
      for (const t of p.transfers.values()) if (t.active) active++;
    for (const [peerId, p] of this.#peers) {
      for (const t of p.transfers.values()) {
        if (!t.active) {
          if (active >= MAX_PENDING_TRANSFERS) continue;
          t.active = true;
          t.nextRequestAt = now;
          active++;
        }
        if (now < t.nextRequestAt) continue;
        this.#opts.send(peerId, this.#requestMessage(t));
        t.lastRequestAt = now;
        t.nextRequestAt = now + t.backoff;
        t.backoff = Math.min(DOC_REQUEST_BACKOFF_MS.max, t.backoff * 2);
      }
    }
  }

  #requestMessage(t: Transfer): string {
    const msg: { v: 1; type: 'doc-req'; k: string; id: string; m?: number[] } = {
      v: 1,
      type: 'doc-req',
      k: t.kind,
      id: t.id,
    };
    if (t.have > 0) {
      const missing: number[] = [];
      t.parts.forEach((part, i) => {
        if (part === undefined) missing.push(i);
      });
      msg.m = missing;
    }
    return JSON.stringify(msg);
  }

  #onRequest(peerId: string, msg: Extract<DocMessage, { type: 'doc-req' }>, now: number): void {
    const doc = this.#own.get(msg.k);
    if (!doc || doc.id !== msg.id) return; // stale or unknown: the next list corrects the peer
    const p = this.#peer(peerId);
    const { burstBytes, bytesPerSecond } = DOC_SERVE_BUDGET;
    p.tokens = Math.min(burstBytes, p.tokens + ((now - p.tokensAt) * bytesPerSecond) / 1000);
    p.tokensAt = now;
    const indices = msg.m ? [...new Set(msg.m)] : doc.chunks.map((_, i) => i);
    for (const i of indices) {
      const chunk = doc.chunks[i];
      const cost = doc.chunkBytes[i];
      if (chunk === undefined || cost === undefined) continue; // index beyond this document
      if (p.tokens < cost) break; // rate-limited; the requester retries the rest
      p.tokens -= cost;
      this.#opts.send(peerId, chunk);
    }
  }

  #onChunk(peerId: string, msg: Extract<DocMessage, { type: 'doc-chunk' }>, now: number): void {
    const p = this.#peers.get(peerId);
    const t = p?.transfers.get(msg.k);
    if (!p || !t || t.id !== msg.id || t.n !== msg.n || t.c !== msg.c) return; // unsolicited
    if (t.parts[msg.i] !== undefined) return; // duplicate
    const bytes = utf8Length(msg.d);
    if (t.bytes + bytes > t.n) {
      this.#resetTransfer(t, now); // inconsistent pieces: start over
      return;
    }
    t.parts[msg.i] = msg.d;
    t.have += 1;
    t.bytes += bytes;
    t.backoff = DOC_REQUEST_BACKOFF_MS.initial;
    t.nextRequestAt = now + DOC_REQUEST_BACKOFF_MS.initial;
    if (t.have < t.c) return;
    const text = t.parts.join('');
    if (t.bytes !== t.n || contentHash(text) !== t.id) {
      this.#resetTransfer(t, now);
      return;
    }
    p.transfers.delete(msg.k);
    const stored: StoredDocument = { id: t.id, text, receivedAt: now };
    p.docs.set(msg.k, stored);
    this.#events.emit('document', {
      type: 'available',
      document: this.#toShared(peerId, msg.k, stored),
    });
    this.#pump(now);
  }

  #resetTransfer(t: Transfer, now: number): void {
    t.parts.fill(undefined);
    t.have = 0;
    t.bytes = 0;
    t.backoff = DOC_REQUEST_BACKOFF_MS.max;
    t.nextRequestAt = now + DOC_REQUEST_BACKOFF_MS.initial;
  }

  #onStart(peerId: string, msg: Extract<DocMessage, { type: 'doc-start' }>, now: number): void {
    const key = `${peerId} ${msg.a}`;
    const estimate = now + msg.in;
    const existing = this.#starts.get(key);
    if (existing) {
      if (existing.kind !== msg.k || existing.id !== msg.id) return;
      if (Math.abs(estimate - existing.startsAt) > MAX_START_DISAGREEMENT_MS) return;
      // Transit delay only ever makes an estimate late: keep the earliest.
      existing.startsAt = Math.min(existing.startsAt, estimate);
      return;
    }
    const fromPeer = [...this.#starts].filter(([, s]) => s.peerId === peerId);
    if (fromPeer.length >= MAX_STARTS_PER_PEER) {
      const oldest = fromPeer[0];
      if (oldest) this.#starts.delete(oldest[0]);
    }
    const start: ReceivedStart = {
      announceId: msg.a,
      peerId,
      kind: msg.k,
      id: msg.id,
      startsAt: estimate,
    };
    this.#starts.set(key, start);
    this.#events.emit('start', this.#toAnnouncement(start, now));
  }
}
