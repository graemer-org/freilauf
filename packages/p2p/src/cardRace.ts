/**
 * Card Race attacks on the wire (docs/adr/0007-card-race.md): an attack is an *event* aimed at
 * one peer, not state. It is idempotent (an id), answered with an ack that carries the target's
 * verdict, retried until acknowledged on the unreliable mesh channel, and applied exactly once by
 * the target, who then shows the effect in its own rider state.
 *
 * - `card-attack` `{ v: 1, type, id, to, kind, gapM, raceM, routeId? }`: `to` is the target's
 *   peer id; `gapM` how far ahead of the attacker the attacker saw the target; `raceM` the
 *   attacker's own race position (route metres + offset on `routeId`, else ridden metres +
 *   offset), so the target can re-check "directly ahead" itself.
 * - `card-ack` `{ v: 1, type, id, result }`: the verdict, re-sent for every duplicate.
 *
 * Pure and clock-free (every method takes the local time), like `RemoteRiders`.
 */
import { CARD_KIND_PATTERN } from './riderState';

export const CARD_MESSAGE_VERSION = 1;
export const MAX_CARD_MESSAGE_LENGTH = 512;

/** `<epoch>.<seq>`: a random word per GroupRide and a counter. */
const ATTACK_ID = /^([a-z0-9]{4,12})\.([1-9][0-9]{0,8})$/;
const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PEER_ID = /^[\x21-\x7e]{1,128}$/;

/** What the target made of an attack (ack `result`). */
export type AttackVerdict = 'hit' | 'blocked' | 'protected' | 'unavailable' | 'refused';
const VERDICTS: readonly AttackVerdict[] = [
  'hit',
  'blocked',
  'protected',
  'unavailable',
  'refused',
];

export interface AttackPayload {
  kind: string;
  /** Metres the target was ahead of the attacker, as the attacker saw it (≥ 0). */
  gapM: number;
  /** The attacker's race position (see the module comment). */
  raceM: number;
  /** The route `raceM` is measured on, when riding one. */
  routeId?: string;
}

export interface AttackMessage extends AttackPayload {
  v: typeof CARD_MESSAGE_VERSION;
  type: 'card-attack';
  id: string;
  to: string;
}

export interface AttackAckMessage {
  v: typeof CARD_MESSAGE_VERSION;
  type: 'card-ack';
  id: string;
  result: AttackVerdict;
}

/** An attack that reached this rider, after the transport-level checks. */
export interface IncomingAttack extends AttackPayload {
  id: string;
  /** Who sent it (the transport's peer id, never a field of the message). */
  from: string;
  fromName: string;
}

/** What became of an attack this rider sent. */
export interface AttackOutcomeEvent {
  id: string;
  to: string;
  kind: string;
  result: AttackVerdict | 'timeout';
}

function finite(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

export function encodeAttack(msg: Omit<AttackMessage, 'v' | 'type'>): string {
  const out: AttackMessage = {
    v: CARD_MESSAGE_VERSION,
    type: 'card-attack',
    id: msg.id,
    to: msg.to,
    kind: msg.kind,
    gapM: Math.round(msg.gapM * 10) / 10,
    raceM: Math.round(msg.raceM * 10) / 10,
    ...(msg.routeId ? { routeId: msg.routeId } : {}),
  };
  return JSON.stringify(out);
}

export function encodeAck(id: string, result: AttackVerdict): string {
  const out: AttackAckMessage = { v: CARD_MESSAGE_VERSION, type: 'card-ack', id, result };
  return JSON.stringify(out);
}

/**
 * Parses a raw data-channel message. Never throws; null for anything that is not a well-formed
 * card message (unknown fields are ignored, wrong types or ranges drop the message).
 */
export function decodeCardMessage(raw: unknown): AttackMessage | AttackAckMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_CARD_MESSAGE_LENGTH) return null;
  if (!raw.includes('"card-')) return null; // cheap pre-filter: most messages are states
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  if (m['v'] !== CARD_MESSAGE_VERSION) return null;
  const id = m['id'];
  if (typeof id !== 'string' || !ATTACK_ID.test(id)) return null;
  if (m['type'] === 'card-ack') {
    const result = m['result'];
    if (typeof result !== 'string' || !VERDICTS.includes(result as AttackVerdict)) return null;
    return { v: CARD_MESSAGE_VERSION, type: 'card-ack', id, result: result as AttackVerdict };
  }
  if (m['type'] !== 'card-attack') return null;
  const { to, kind, gapM, raceM, routeId } = m;
  if (typeof to !== 'string' || !PEER_ID.test(to)) return null;
  if (typeof kind !== 'string' || !CARD_KIND_PATTERN.test(kind)) return null;
  if (!finite(gapM, -1_000, 1_000_000) || !finite(raceM, -100_000, 11_000_000)) return null;
  if (routeId !== undefined && (typeof routeId !== 'string' || !ROUTE_ID.test(routeId))) {
    return null;
  }
  return {
    v: CARD_MESSAGE_VERSION,
    type: 'card-attack',
    id,
    to,
    kind,
    gapM,
    raceM,
    ...(routeId !== undefined ? { routeId } : {}),
  };
}

/** Limits for incoming attacks, per sender. */
export interface AttackInboxLimits {
  /** At most this many new attacks per sender within `windowMs`. */
  perWindow: number;
  windowMs: number;
  /** And at least this long between two new attacks from the same sender. */
  minGapMs: number;
  /** Verdicts kept per sender (duplicates within them are re-acknowledged). */
  remember: number;
}

export const ATTACK_INBOX_LIMITS: Readonly<AttackInboxLimits> = {
  perWindow: 3,
  windowMs: 30_000,
  minGapMs: 1_000,
  remember: 64,
};

interface SenderBook {
  /** id → verdict, oldest first. */
  seen: Map<string, AttackVerdict>;
  /** Per epoch: every seq at or below this was forgotten; replays of it are refused. */
  floor: Map<string, number>;
  /** Local times of accepted new attacks (for the rate limit). */
  times: number[];
}

/** The inbox's decision about one incoming attack message. */
export type InboxDecision =
  /** New and acceptable: ask the game, then `record()` its verdict and ack it. */
  | { action: 'decide' }
  /** Seen before: ack this verdict again, do not apply anything. */
  | { action: 'repeat'; result: AttackVerdict }
  /** Refused here (and acked as 'refused'): wrong target, replay, too many. */
  | { action: 'refuse'; reason: 'not-for-us' | 'not-a-member' | 'replay' | 'rate-limited' };

/**
 * Exactly-once on the target: duplicates and retries of an id get the same verdict back
 * without being applied again; old ids beyond what is remembered are refused as replays; a
 * sender gets at most a few new attacks per half minute.
 */
export class AttackInbox {
  #books = new Map<string, SenderBook>();
  readonly #limits: AttackInboxLimits;

  constructor(limits: Partial<AttackInboxLimits> = {}) {
    this.#limits = { ...ATTACK_INBOX_LIMITS, ...limits };
  }

  /** `member`: the sender is a rider of this room (connected, and has sent its state). */
  check(
    from: string,
    msg: AttackMessage,
    localPeerId: string,
    member: boolean,
    now: number,
  ): InboxDecision {
    const book = this.#book(from);
    const known = book.seen.get(msg.id);
    if (known !== undefined) return { action: 'repeat', result: known };
    if (msg.to !== localPeerId) return { action: 'refuse', reason: 'not-for-us' };
    if (!member) return { action: 'refuse', reason: 'not-a-member' };
    const [, epoch = '', seqText = '0'] = ATTACK_ID.exec(msg.id) ?? [];
    if (Number(seqText) <= (book.floor.get(epoch) ?? 0))
      return { action: 'refuse', reason: 'replay' };
    const L = this.#limits;
    book.times = book.times.filter((t) => now - t < L.windowMs);
    const last = book.times.at(-1);
    if (book.times.length >= L.perWindow || (last !== undefined && now - last < L.minGapMs)) {
      return { action: 'refuse', reason: 'rate-limited' };
    }
    return { action: 'decide' };
  }

  /**
   * Remembers the verdict for `id` (call for every decided or refused message, so its
   * duplicates get the same answer). `counted`: it was a new attack (rate limit).
   */
  record(from: string, id: string, result: AttackVerdict, now: number, counted: boolean): void {
    const book = this.#book(from);
    book.seen.set(id, result);
    if (counted) book.times.push(now);
    while (book.seen.size > this.#limits.remember) {
      const oldest = book.seen.keys().next().value as string;
      book.seen.delete(oldest);
      const [, epoch = '', seqText = '0'] = ATTACK_ID.exec(oldest) ?? [];
      book.floor.set(epoch, Math.max(book.floor.get(epoch) ?? 0, Number(seqText)));
    }
  }

  removePeer(peerId: string): void {
    this.#books.delete(peerId);
  }

  #book(from: string): SenderBook {
    let book = this.#books.get(from);
    if (!book) {
      book = { seen: new Map(), floor: new Map(), times: [] };
      this.#books.set(from, book);
    }
    return book;
  }
}

/** How the attacker retries (ADR 0007). */
export const ATTACK_OUTBOX_TIMING = {
  /** Unreliable channel: re-send an unanswered attack this often. */
  retryMs: 400,
  /** Give up (result 'timeout') after this long without an answer. */
  timeoutMs: 5_000,
} as const;

interface Pending {
  id: string;
  to: string;
  kind: string;
  /** The latest positions: re-sends carry fresh ones (same id, so still applied once). */
  payload: () => AttackPayload | null;
  firstAt: number;
  lastAt: number;
}

/**
 * The attacker's side: sends each attack, re-sends it until the target answers (unreliable
 * channel) and reports exactly one outcome per attack — the first ack, or 'timeout'.
 */
export class AttackOutbox {
  #pending = new Map<string, Pending>();
  #seq = 0;
  readonly #epoch: string;
  readonly #retry: boolean;
  readonly #send: (to: string, raw: string) => boolean;
  readonly #done: (outcome: AttackOutcomeEvent) => void;

  constructor(opts: {
    epoch: string;
    /** Re-send until acknowledged (the unreliable mesh). False on a reliable channel. */
    retry: boolean;
    send: (to: string, raw: string) => boolean;
    done: (outcome: AttackOutcomeEvent) => void;
  }) {
    this.#epoch = opts.epoch;
    this.#retry = opts.retry;
    this.#send = opts.send;
    this.#done = opts.done;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Sends an attack; returns its id, or null when there is no payload. */
  send(to: string, payload: () => AttackPayload | null, now: number): string | null {
    const first = payload();
    if (!first) return null;
    this.#seq += 1;
    const id = `${this.#epoch}.${this.#seq}`;
    const p: Pending = { id, to, kind: first.kind, payload, firstAt: now, lastAt: now };
    this.#pending.set(id, p);
    this.#send(to, encodeAttack({ id, to, ...first }));
    return id;
  }

  /** An ack arrived from `from`. Only the target's first ack for a pending id counts. */
  ack(from: string, msg: AttackAckMessage): boolean {
    const p = this.#pending.get(msg.id);
    if (!p || p.to !== from) return false;
    this.#pending.delete(msg.id);
    this.#done({ id: p.id, to: p.to, kind: p.kind, result: msg.result });
    return true;
  }

  /** Re-sends what is due and times out what waited too long. */
  pump(now: number): void {
    for (const p of [...this.#pending.values()]) {
      if (now - p.firstAt >= ATTACK_OUTBOX_TIMING.timeoutMs) {
        this.#pending.delete(p.id);
        this.#done({ id: p.id, to: p.to, kind: p.kind, result: 'timeout' });
        continue;
      }
      if (!this.#retry || now - p.lastAt < ATTACK_OUTBOX_TIMING.retryMs) continue;
      const payload = p.payload();
      if (!payload) continue;
      p.lastAt = now;
      this.#send(p.to, encodeAttack({ id: p.id, to: p.to, ...payload, kind: p.kind }));
    }
  }

  /** The target left: its attacks end now ('timeout'). */
  removePeer(peerId: string): void {
    for (const p of [...this.#pending.values()]) {
      if (p.to !== peerId) continue;
      this.#pending.delete(p.id);
      this.#done({ id: p.id, to: p.to, kind: p.kind, result: 'timeout' });
    }
  }

  clear(): void {
    this.#pending.clear();
  }
}

/** A random lowercase word for attack ids (not a secret; only needs to differ per ride). */
export function attackEpoch(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 8; i++)
    s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)];
  return s;
}
