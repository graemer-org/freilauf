/**
 * Pure parts of the diagnostic log, shared by the Electron main process (the
 * log file), the renderers (the logger that batches to main) and the browser
 * build (an in-memory log). No Electron, no DOM, no fs: unit-tested in
 * logFormat.test.ts.
 *
 * Line format (one event per line, see docs/diagnostics.md):
 *
 *   2026-11-22T08:00:00.123Z INFO  ble      trainer connected {"ms":812}
 *   └ ISO time, UTC, ms     └ level └ source └ message └ optional JSON context
 */
import type { LogContext, LogLevel } from '../../shared/contract';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);
}

/** Longest message kept; the rest is cut with an ellipsis. */
export const MAX_MESSAGE_CHARS = 2000;
/** Longest JSON context kept. */
export const MAX_CONTEXT_CHARS = 6000;
/** Longest string inside a context. Stacks are allowed to be longer. */
const MAX_STRING_CHARS = 1000;
const MAX_STACK_CHARS = 4000;
const MAX_DEPTH = 5;
const MAX_KEYS = 50;
const MAX_ARRAY = 50;

const SOURCE_RE = /^[a-z][a-z0-9-]{0,15}$/;

/** Sources are short lowercase tags; anything else is replaced so a line stays parseable. */
export function normaliseSource(source: unknown): string {
  if (typeof source !== 'string') return 'unknown';
  const s = source.trim().toLowerCase();
  return SOURCE_RE.test(s) ? s : 'unknown';
}

export interface LogEntry {
  /** Epoch ms. */
  time: number;
  level: LogLevel;
  source: string;
  message: string;
  context?: LogContext;
}

function oneLine(text: string): string {
  return text
    .replace(/\r\n|[\r\n\u2028\u2029]/g, ' ⏎ ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function hex(bytes: Uint8Array | readonly number[]): string {
  let out = '';
  for (const b of bytes) out += (out ? ' ' : '') + (b & 0xff).toString(16).padStart(2, '0');
  return out;
}

/** Plain-object form of an error: name, message, code (if any), stack and cause. */
export function describeError(err: unknown, depth = 0): Record<string, unknown> {
  if (err instanceof Error || (typeof err === 'object' && err !== null && 'message' in err)) {
    const e = err as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    const out: Record<string, unknown> = {
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : String(e.message),
    };
    if (typeof e.code === 'string' || typeof e.code === 'number') out.code = e.code;
    for (const extra of ['result', 'requestOpCode'] as const) {
      const v = (err as Record<string, unknown>)[extra];
      if (typeof v === 'string' || typeof v === 'number') out[extra] = v;
    }
    if (typeof e.stack === 'string') out.stack = e.stack;
    if (e.cause !== undefined && depth < 2) out.cause = describeError(e.cause, depth + 1);
    return out;
  }
  return { name: typeof err, message: String(err) };
}

/**
 * Makes any value JSON-safe and bounded: Errors become {name, message, stack},
 * byte arrays become hex, cycles, functions and symbols are dropped, deep or
 * wide structures are cut.
 */
export function toJsonSafe(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return cut(value, MAX_STRING_CHARS);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value instanceof Uint8Array) return hex(value.subarray(0, 512));
  if (value instanceof DataView) {
    return hex(new Uint8Array(value.buffer, value.byteOffset, Math.min(value.byteLength, 512)));
  }
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[…]';
  seen.add(obj);
  try {
    if (value instanceof Error) {
      const d = describeError(value);
      if (typeof d.stack === 'string') d.stack = cut(d.stack, MAX_STACK_CHARS);
      return toJsonSafe(d, depth, new WeakSet());
    }
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ARRAY).map((v) => toJsonSafe(v, depth + 1, seen) ?? null);
      if (value.length > MAX_ARRAY) out.push(`… ${value.length - MAX_ARRAY} more`);
      return out;
    }
    if (value instanceof Set) return toJsonSafe([...value], depth, seen);
    if (value instanceof Map) return toJsonSafe(Object.fromEntries(value), depth, seen);
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= MAX_KEYS) {
        out['…'] = 'more keys';
        break;
      }
      const safe =
        k === 'stack' && typeof v === 'string'
          ? cut(v, MAX_STACK_CHARS)
          : toJsonSafe(v, depth + 1, seen);
      if (safe !== undefined) out[k] = safe;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

export function formatTime(epochMs: number): string {
  const d = new Date(Number.isFinite(epochMs) ? epochMs : 0);
  return d.toISOString();
}

/** One log line, without the trailing newline. Never throws. */
export function formatLogLine(entry: LogEntry): string {
  const level = (isLogLevel(entry.level) ? entry.level : 'info').toUpperCase().padEnd(5);
  const source = normaliseSource(entry.source).padEnd(8);
  const message = cut(oneLine(String(entry.message)), MAX_MESSAGE_CHARS);
  let line = `${formatTime(entry.time)} ${level} ${source} ${message}`;
  if (entry.context !== undefined) {
    let json: string | undefined;
    try {
      const safe = toJsonSafe(entry.context);
      if (safe && typeof safe === 'object' && Object.keys(safe).length > 0)
        json = JSON.stringify(safe);
    } catch {
      json = '{"contextError":"not serialisable"}';
    }
    if (json) line += ` ${cut(oneLine(json), MAX_CONTEXT_CHARS)}`;
  }
  return line;
}

// ───────────────────────── redaction ─────────────────────────

/** Strings that must never appear in a shared log, e.g. the rider's name or the current room code. */
export interface Secrets {
  riderName?: string | null;
  /** Room codes (and other short secrets) to mask wherever they appear. */
  codes?: readonly string[];
  /** The user's home directory (it contains the account name): replaced by `~`. */
  homeDir?: string | null;
}

/** First two characters, the rest replaced: "ABCDEF" → "AB****". */
export function maskCode(code: string): string {
  const c = code.trim();
  if (c.length <= 2) return '*'.repeat(c.length);
  return c.slice(0, 2) + '*'.repeat(Math.min(c.length - 2, 8));
}

/** ws://host:port only: no credentials, path or query (they may carry tokens or room codes). */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== '/' ? '/…' : ''}`;
  } catch {
    return '[invalid url]';
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * The single redaction pass every line goes through before it is stored
 * (main log file and browser log alike):
 *
 * - the rider's name (case-insensitive, if at least 2 characters) → `[rider]`;
 * - credentials in URLs (`ws://user:pass@host`) → `ws://***@host`;
 * - query strings and fragments of URLs → `?…` (tokens, `s=` signalling URLs);
 * - `freilauf://join/CODE` links and `room CODE`/`room=CODE`/`roomCode":"CODE` → first two
 *   characters of the code kept;
 * - any explicitly given code (the current room code) wherever it appears;
 * - the home directory in paths (it contains the account name) → `~`.
 */
export function redact(text: string, secrets: Secrets = {}): string {
  let out = text;
  // Credentials in URLs.
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, '$1***@');
  // Join links: the code and the optional `s=` parameter.
  out = out.replace(
    /freilauf:\/\/join\/([A-Za-z0-9-]{1,12})(\?[^\s"'<>]*)?/gi,
    (_m, code: string, q?: string) => `freilauf://join/${maskCode(code)}${q ? '?…' : ''}`,
  );
  // Query strings / fragments of other URLs.
  out = out.replace(/\b((?:wss?|https?):\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1?…');
  // "room ABCDEF", "room code: ABC-DEF", "roomCode":"ABCDEF", room=ABCDEF
  const code = `[${ROOM_ALPHABET}]{3}-?[${ROOM_ALPHABET}]{3}`;
  out = out.replace(
    new RegExp(
      `((?:room|Room|ROOM)(?:[ _-]?(?:code|Code|CODE))?"?\\s*[:= ]\\s*"?)(${code})\\b`,
      'g',
    ),
    (_m, prefix: string, c: string) => prefix + maskCode(c),
  );
  const home = secrets.homeDir?.replace(/[\\/]+$/, '');
  if (home && home.length >= 3) {
    for (const variant of new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])) {
      out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
    }
  }
  for (const c of secrets.codes ?? []) {
    if (c.length < 3) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(c)}\\b`, 'g'), maskCode(c));
  }
  const name = secrets.riderName?.trim();
  // The default name "Rider" is not personal and would hit every "rider." settings path.
  if (name && name.length >= 2 && name.toLowerCase() !== 'rider') {
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'),
      '[rider]',
    );
  }
  return out;
}

/** Redacts the message and every string inside the context (after making it JSON-safe). */
export function redactEntry(entry: LogEntry, secrets: Secrets): LogEntry {
  const r = (s: string) => redact(s, secrets);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return r(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  const out: LogEntry = { ...entry, message: r(String(entry.message)) };
  if (entry.context !== undefined) out.context = walk(toJsonSafe(entry.context)) as LogContext;
  return out;
}

// ───────────────────────── rate limiting ─────────────────────────

export interface RateDecision {
  allowed: boolean;
  /** How many events of this key were suppressed since the last allowed one. */
  suppressed: number;
}

/**
 * At most `limit` events per key in any `windowMs` (fixed windows). Suppressed
 * events are counted and reported with the next allowed one, so a log line
 * can say "(+37 similar suppressed)".
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #keys = new Map<string, { windowStart: number; count: number; suppressed: number }>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = Math.max(1, limit);
    this.#windowMs = Math.max(1, windowMs);
    this.#now = now;
  }

  take(key: string): RateDecision {
    const now = this.#now();
    let k = this.#keys.get(key);
    if (!k || now - k.windowStart >= this.#windowMs) {
      const suppressed = k?.suppressed ?? 0;
      k = { windowStart: now, count: 0, suppressed: 0 };
      this.#keys.set(key, k);
      k.count = 1;
      return { allowed: true, suppressed };
    }
    if (k.count < this.#limit) {
      k.count++;
      const suppressed = k.suppressed;
      k.suppressed = 0;
      return { allowed: true, suppressed };
    }
    k.suppressed++;
    return { allowed: false, suppressed: k.suppressed };
  }

  /** Keys with suppressed events that have not been reported yet (and resets them). */
  drainSuppressed(): { key: string; suppressed: number }[] {
    const out: { key: string; suppressed: number }[] = [];
    for (const [key, k] of this.#keys) {
      if (k.suppressed > 0) {
        out.push({ key, suppressed: k.suppressed });
        k.suppressed = 0;
      }
    }
    return out;
  }
}

// ───────────────────────── rotation ─────────────────────────

/** True when appending `incomingBytes` would push a non-empty file over `maxBytes`. */
export function shouldRotate(
  currentBytes: number,
  incomingBytes: number,
  maxBytes: number,
): boolean {
  return currentBytes > 0 && currentBytes + incomingBytes > maxBytes;
}

/** `freilauf.log`, index 2 → `freilauf.2.log`; index 0 is the current file. */
export function rotatedName(baseName: string, index: number): string {
  if (index === 0) return baseName;
  const dot = baseName.lastIndexOf('.');
  return dot > 0
    ? `${baseName.slice(0, dot)}.${index}${baseName.slice(dot)}`
    : `${baseName}.${index}`;
}

/**
 * File operations for one rotation, in order: delete the oldest, shift the
 * others up by one, move the current file to `.1`. `keep` = rotated files kept.
 */
export function rotationPlan(
  baseName: string,
  keep: number,
): ({ op: 'delete'; name: string } | { op: 'rename'; from: string; to: string })[] {
  if (keep <= 0) return [{ op: 'delete', name: baseName }];
  const plan: ({ op: 'delete'; name: string } | { op: 'rename'; from: string; to: string })[] = [
    { op: 'delete', name: rotatedName(baseName, keep) },
  ];
  for (let i = keep - 1; i >= 0; i--) {
    plan.push({ op: 'rename', from: rotatedName(baseName, i), to: rotatedName(baseName, i + 1) });
  }
  return plan;
}

/** All file names of a log set, current first, then `.1` (newest rotated) … `.keep`. */
export function logFileNames(baseName: string, keep: number): string[] {
  return Array.from({ length: keep + 1 }, (_, i) => rotatedName(baseName, i));
}

/** Cuts `text` to its last `maxBytes` (UTF-8, approximately), starting at a line boundary. */
export function tailText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  // Characters ≈ bytes for log text (mostly ASCII); good enough for a viewer.
  if (text.length <= maxBytes) return text;
  const slice = text.slice(text.length - maxBytes);
  const nl = slice.indexOf('\n');
  return nl >= 0 && nl < slice.length - 1 ? slice.slice(nl + 1) : slice;
}

// ───────────────────────── session header ─────────────────────────

export interface SessionInfo {
  sessionId: string;
  app: string;
  version: string;
  facts: Record<string, unknown>;
}

/** Lines that start a session in the log (each a normal log entry, source "session"). */
export function sessionHeaderEntries(info: SessionInfo, time: number): LogEntry[] {
  const entries: LogEntry[] = [
    {
      time,
      level: 'info',
      source: 'session',
      message: `===== ${info.app} ${info.version} session ${info.sessionId} started =====`,
    },
  ];
  for (const [key, value] of Object.entries(info.facts)) {
    entries.push({
      time,
      level: 'info',
      source: 'session',
      message: key,
      context:
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as LogContext)
          : { value },
    });
  }
  return entries;
}

/** 8 hex characters; enough to tell launches apart in a combined export. */
export function randomSessionId(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += Math.floor(random() * 16).toString(16);
  return s;
}
