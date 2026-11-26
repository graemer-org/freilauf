/**
 * Freilauf Rumble on the wire (docs/adr/0008-rumble-items.md). Two kinds of events, each aimed
 * at one peer, idempotent (an id), answered with an ack that carries the receiver's verdict,
 * retried until acknowledged on the unreliable mesh channel, and decided exactly once:
 *
 * - **Attacks** (the water bottle on the rider directly ahead, the hornets on the leader):
 *   `rumble-attack` `{ v: 2, type, id, to, kind, gapM, raceM, routeId? }` from the attacker to
 *   the target, answered by `rumble-ack` `{ v: 2, type, id, result }`. `gapM` is how far ahead
 *   of the attacker the attacker saw the target; `raceM` the attacker's own race position
 *   (route metres + offset on `routeId`, else ridden metres + offset), so the target can
 *   re-check "directly ahead" itself. The target applies the effect to itself.
 * - **Puddle claims** (the mud puddle is a world object, broadcast by whoever dropped it in
 *   their rider state): `puddle-claim` `{ v: 2, type, id, to, puddle, raceM, routeId? }` from a
 *   rider who rode through it to its dropper, answered by `puddle-ack` `{ v: 2, type, id,
 *   result }`. The dropper is the only judge of its own puddle: the first claim it accepts is
 *   `granted`, every later one `taken`; only a `granted` claimer applies the hit.
 *
 * Version 1 (`card-attack` / `card-ack`, the superseded format of ADR 0007) is not decoded:
 * an app that speaks it is an app without Freilauf Rumble.
 *
 * Rumble protocol v3 (docs/adr/0009-rumble-road-items.md) keeps these messages as they are
 * (`v: 2`): the dropped chain is one more attack `kind`, tacks are claimed with `puddle-claim`
 * like a mud puddle (their ids come from the dropper's `items.tacks`), and rough sections need
 * no message at all (`RoughLedger`, `roughSpan`). An app of v2 refuses an unknown kind.
 *
 * Pure and clock-free (every method takes the local time), like `RemoteRiders`.
 */
import { RUMBLE_ID_PATTERN, RUMBLE_KIND_PATTERN, gapAlongRoute } from './riderState';
import type { RiderItems, WirePuddle, WireRough } from './types';

export const RUMBLE_MESSAGE_VERSION = 2;
export const MAX_RUMBLE_MESSAGE_LENGTH = 512;

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

/**
 * What the dropper made of a puddle claim: `granted` (this claimer is the one rider it hits),
 * `taken` (someone else's claim came first), `gone` (unknown, expired or already used up
 * before), `refused` (an implausible claim).
 */
export type ClaimVerdict = 'granted' | 'taken' | 'gone' | 'refused';
const CLAIM_VERDICTS: readonly ClaimVerdict[] = ['granted', 'taken', 'gone', 'refused'];

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
  v: typeof RUMBLE_MESSAGE_VERSION;
  type: 'rumble-attack';
  id: string;
  to: string;
}

export interface AttackAckMessage {
  v: typeof RUMBLE_MESSAGE_VERSION;
  type: 'rumble-ack';
  id: string;
  result: AttackVerdict;
}

export interface ClaimPayload {
  /** The puddle's id, as its dropper broadcasts it. */
  puddle: string;
  /** The claimer's race position, in the puddle's coordinates (see the module comment). */
  raceM: number;
  /** The route `raceM` is measured on (the puddle's route), when it lies on one. */
  routeId?: string;
}

export interface ClaimMessage extends ClaimPayload {
  v: typeof RUMBLE_MESSAGE_VERSION;
  type: 'puddle-claim';
  id: string;
  to: string;
}

export interface ClaimAckMessage {
  v: typeof RUMBLE_MESSAGE_VERSION;
  type: 'puddle-ack';
  id: string;
  result: ClaimVerdict;
}

export type RumbleMessage = AttackMessage | AttackAckMessage | ClaimMessage | ClaimAckMessage;

/** An attack that reached this rider, after the transport-level checks. */
export interface IncomingAttack extends AttackPayload {
  id: string;
  /** Who sent it (the transport's peer id, never a field of the message). */
  from: string;
  fromName: string;
}

/** A claim on one of this rider's puddles, after the transport-level checks. */
export interface IncomingClaim extends ClaimPayload {
  id: string;
  /** Who rode through it (the transport's peer id). */
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

/** What became of a puddle claim this rider sent. */
export interface ClaimOutcomeEvent {
  id: string;
  /** The dropper. */
  to: string;
  puddle: string;
  result: ClaimVerdict | 'timeout';
}

function finite(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function encodeAttack(msg: Omit<AttackMessage, 'v' | 'type'>): string {
  const out: AttackMessage = {
    v: RUMBLE_MESSAGE_VERSION,
    type: 'rumble-attack',
    id: msg.id,
    to: msg.to,
    kind: msg.kind,
    gapM: round1(msg.gapM),
    raceM: round1(msg.raceM),
    ...(msg.routeId ? { routeId: msg.routeId } : {}),
  };
  return JSON.stringify(out);
}

export function encodeAck(id: string, result: AttackVerdict): string {
  const out: AttackAckMessage = { v: RUMBLE_MESSAGE_VERSION, type: 'rumble-ack', id, result };
  return JSON.stringify(out);
}

export function encodeClaim(msg: Omit<ClaimMessage, 'v' | 'type'>): string {
  const out: ClaimMessage = {
    v: RUMBLE_MESSAGE_VERSION,
    type: 'puddle-claim',
    id: msg.id,
    to: msg.to,
    puddle: msg.puddle,
    raceM: round1(msg.raceM),
    ...(msg.routeId ? { routeId: msg.routeId } : {}),
  };
  return JSON.stringify(out);
}

export function encodeClaimAck(id: string, result: ClaimVerdict): string {
  const out: ClaimAckMessage = { v: RUMBLE_MESSAGE_VERSION, type: 'puddle-ack', id, result };
  return JSON.stringify(out);
}

/**
 * Parses a raw data-channel message. Never throws; null for anything that is not a well-formed
 * Rumble message of this version (unknown fields are ignored, wrong types or ranges drop it).
 */
export function decodeRumbleMessage(raw: unknown): RumbleMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_RUMBLE_MESSAGE_LENGTH) return null;
  // Cheap pre-filter: most messages are states.
  if (!raw.includes('"rumble-') && !raw.includes('"puddle-')) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  if (m['v'] !== RUMBLE_MESSAGE_VERSION) return null;
  const id = m['id'];
  if (typeof id !== 'string' || !RUMBLE_ID_PATTERN.test(id)) return null;
  const v = RUMBLE_MESSAGE_VERSION;
  const type = m['type'];
  if (type === 'rumble-ack' || type === 'puddle-ack') {
    const result = m['result'];
    if (type === 'rumble-ack') {
      if (typeof result !== 'string' || !VERDICTS.includes(result as AttackVerdict)) return null;
      return { v, type, id, result: result as AttackVerdict };
    }
    if (typeof result !== 'string' || !CLAIM_VERDICTS.includes(result as ClaimVerdict)) {
      return null;
    }
    return { v, type, id, result: result as ClaimVerdict };
  }
  if (type !== 'rumble-attack' && type !== 'puddle-claim') return null;
  const { to, raceM, routeId } = m;
  if (typeof to !== 'string' || !PEER_ID.test(to)) return null;
  if (!finite(raceM, -100_000, 11_000_000)) return null;
  if (routeId !== undefined && (typeof routeId !== 'string' || !ROUTE_ID.test(routeId))) {
    return null;
  }
  const route = routeId !== undefined ? { routeId } : {};
  if (type === 'puddle-claim') {
    const puddle = m['puddle'];
    if (typeof puddle !== 'string' || !RUMBLE_ID_PATTERN.test(puddle)) return null;
    return { v, type, id, to, puddle, raceM, ...route };
  }
  const { kind, gapM } = m;
  if (typeof kind !== 'string' || !RUMBLE_KIND_PATTERN.test(kind)) return null;
  if (!finite(gapM, -1_000, 1_000_000)) return null;
  return { v, type, id, to, kind, gapM, raceM, ...route };
}

/** Limits for incoming events, per sender. */
export interface InboxLimits {
  /** At most this many new events per sender within `windowMs`. */
  perWindow: number;
  windowMs: number;
  /** And at least this long between two new events from the same sender. */
  minGapMs: number;
  /** Verdicts kept per sender (duplicates within them are re-acknowledged). */
  remember: number;
}

/** Attacks: at most 3 per sender per 30 s, 1 s apart. */
export const ATTACK_INBOX_LIMITS: Readonly<InboxLimits> = {
  perWindow: 3,
  windowMs: 30_000,
  minGapMs: 1_000,
  remember: 64,
};

/**
 * Puddle claims: a rider crosses a puddle now and then, never many at once; at most 6 claims
 * per sender per 30 s (and no minimum gap: two puddles can lie close together).
 */
export const CLAIM_INBOX_LIMITS: Readonly<InboxLimits> = {
  perWindow: 6,
  windowMs: 30_000,
  minGapMs: 0,
  remember: 64,
};

interface SenderBook<V> {
  /** id → verdict, oldest first. */
  seen: Map<string, V>;
  /** Per epoch: every seq at or below this was forgotten; replays of it are refused. */
  floor: Map<string, number>;
  /** Local times of accepted new events (for the rate limit). */
  times: number[];
}

/** The inbox's decision about one incoming event. */
export type InboxDecision<V extends string = AttackVerdict> =
  /** New and acceptable: ask the game, then `record()` its verdict and ack it. */
  | { action: 'decide' }
  /** Seen before: ack this verdict again, do not apply anything. */
  | { action: 'repeat'; result: V }
  /** Refused here (and acked as 'refused'): wrong receiver, replay, too many. */
  | { action: 'refuse'; reason: 'not-for-us' | 'not-a-member' | 'replay' | 'rate-limited' };

/**
 * Exactly-once on the receiver: duplicates and retries of an id get the same verdict back
 * without being applied again; old ids beyond what is remembered are refused as replays; a
 * sender gets at most a few new events per half minute.
 */
export class EventInbox<V extends string> {
  #books = new Map<string, SenderBook<V>>();
  readonly #limits: InboxLimits;

  constructor(defaults: Readonly<InboxLimits>, limits: Partial<InboxLimits> = {}) {
    this.#limits = { ...defaults, ...limits };
  }

  /** `member`: the sender is a rider of this room (connected, and has sent its state). */
  check(
    from: string,
    msg: { id: string; to: string },
    localPeerId: string,
    member: boolean,
    now: number,
  ): InboxDecision<V> {
    const book = this.#book(from);
    const known = book.seen.get(msg.id);
    if (known !== undefined) return { action: 'repeat', result: known };
    if (msg.to !== localPeerId) return { action: 'refuse', reason: 'not-for-us' };
    if (!member) return { action: 'refuse', reason: 'not-a-member' };
    const [, epoch = '', seqText = '0'] = RUMBLE_ID_PATTERN.exec(msg.id) ?? [];
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
   * duplicates get the same answer). `counted`: it was a new event (rate limit).
   */
  record(from: string, id: string, result: V, now: number, counted: boolean): void {
    const book = this.#book(from);
    book.seen.set(id, result);
    if (counted) book.times.push(now);
    while (book.seen.size > this.#limits.remember) {
      const oldest = book.seen.keys().next().value as string;
      book.seen.delete(oldest);
      const [, epoch = '', seqText = '0'] = RUMBLE_ID_PATTERN.exec(oldest) ?? [];
      book.floor.set(epoch, Math.max(book.floor.get(epoch) ?? 0, Number(seqText)));
    }
  }

  removePeer(peerId: string): void {
    this.#books.delete(peerId);
  }

  #book(from: string): SenderBook<V> {
    let book = this.#books.get(from);
    if (!book) {
      book = { seen: new Map(), floor: new Map(), times: [] };
      this.#books.set(from, book);
    }
    return book;
  }
}

/** The target's inbox for attacks (ATTACK_INBOX_LIMITS unless overridden). */
export class AttackInbox extends EventInbox<AttackVerdict> {
  constructor(limits: Partial<InboxLimits> = {}) {
    super(ATTACK_INBOX_LIMITS, limits);
  }
}

/** The dropper's inbox for claims on its puddles (CLAIM_INBOX_LIMITS unless overridden). */
export class ClaimInbox extends EventInbox<ClaimVerdict> {
  constructor(limits: Partial<InboxLimits> = {}) {
    super(CLAIM_INBOX_LIMITS, limits);
  }
}

/** How the sender retries (ADR 0008; the same for attacks and claims). */
export const ATTACK_OUTBOX_TIMING = {
  /** Unreliable channel: re-send an unanswered event this often. */
  retryMs: 400,
  /** Give up (result 'timeout') after this long without an answer. */
  timeoutMs: 5_000,
} as const;

interface Pending<P> {
  id: string;
  to: string;
  /** What the outcome reports (the attack kind, the puddle id). Fixed at the first send. */
  tag: string;
  /** The latest positions: re-sends carry fresh ones (same id, so still applied once). */
  payload: () => P | null;
  firstAt: number;
  lastAt: number;
}

/**
 * The sender's side: sends each event, re-sends it until the receiver answers (unreliable
 * channel) and reports exactly one outcome per event — the receiver's first ack, or 'timeout'.
 */
export class EventOutbox<P, V extends string> {
  #pending = new Map<string, Pending<P>>();
  #seq = 0;
  readonly #epoch: string;
  readonly #retry: boolean;
  readonly #send: (to: string, raw: string) => boolean;
  readonly #encode: (id: string, to: string, payload: P) => string;
  readonly #tag: (payload: P) => string;
  readonly #done: (outcome: { id: string; to: string; tag: string; result: V | 'timeout' }) => void;

  constructor(opts: {
    epoch: string;
    /** Re-send until acknowledged (the unreliable mesh). False on a reliable channel. */
    retry: boolean;
    send: (to: string, raw: string) => boolean;
    encode: (id: string, to: string, payload: P) => string;
    tag: (payload: P) => string;
    done: (outcome: { id: string; to: string; tag: string; result: V | 'timeout' }) => void;
  }) {
    this.#epoch = opts.epoch;
    this.#retry = opts.retry;
    this.#send = opts.send;
    this.#encode = opts.encode;
    this.#tag = opts.tag;
    this.#done = opts.done;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Sends an event; returns its id, or null when there is no payload. */
  send(to: string, payload: () => P | null, now: number): string | null {
    const first = payload();
    if (!first) return null;
    this.#seq += 1;
    const id = `${this.#epoch}.${this.#seq}`;
    const p: Pending<P> = { id, to, tag: this.#tag(first), payload, firstAt: now, lastAt: now };
    this.#pending.set(id, p);
    this.#send(to, this.#encode(id, to, first));
    return id;
  }

  /** An ack arrived from `from`. Only the receiver's first ack for a pending id counts. */
  ack(from: string, msg: { id: string; result: V }): boolean {
    const p = this.#pending.get(msg.id);
    if (!p || p.to !== from) return false;
    this.#pending.delete(msg.id);
    this.#done({ id: p.id, to: p.to, tag: p.tag, result: msg.result });
    return true;
  }

  /** Re-sends what is due and times out what waited too long. */
  pump(now: number): void {
    for (const p of [...this.#pending.values()]) {
      if (now - p.firstAt >= ATTACK_OUTBOX_TIMING.timeoutMs) {
        this.#pending.delete(p.id);
        this.#done({ id: p.id, to: p.to, tag: p.tag, result: 'timeout' });
        continue;
      }
      if (!this.#retry || now - p.lastAt < ATTACK_OUTBOX_TIMING.retryMs) continue;
      const payload = p.payload();
      if (!payload) continue;
      p.lastAt = now;
      this.#send(p.to, this.#encode(p.id, p.to, payload));
    }
  }

  /** The receiver left: its events end now ('timeout'). */
  removePeer(peerId: string): void {
    for (const p of [...this.#pending.values()]) {
      if (p.to !== peerId) continue;
      this.#pending.delete(p.id);
      this.#done({ id: p.id, to: p.to, tag: p.tag, result: 'timeout' });
    }
  }

  clear(): void {
    this.#pending.clear();
  }
}

/** The attacker's outbox: one outcome per attack, re-sends keep the kind of the first send. */
export class AttackOutbox extends EventOutbox<AttackPayload, AttackVerdict> {
  constructor(opts: {
    epoch: string;
    retry: boolean;
    send: (to: string, raw: string) => boolean;
    done: (outcome: AttackOutcomeEvent) => void;
  }) {
    super({
      epoch: opts.epoch,
      retry: opts.retry,
      send: opts.send,
      encode: (id, to, p) => encodeAttack({ id, to, ...p }),
      tag: (p) => p.kind,
      done: (o) => opts.done({ id: o.id, to: o.to, kind: o.tag, result: o.result }),
    });
  }
}

/** The claimer's outbox: one outcome per claim. */
export class ClaimOutbox extends EventOutbox<ClaimPayload, ClaimVerdict> {
  constructor(opts: {
    epoch: string;
    retry: boolean;
    send: (to: string, raw: string) => boolean;
    done: (outcome: ClaimOutcomeEvent) => void;
  }) {
    super({
      epoch: opts.epoch,
      retry: opts.retry,
      send: opts.send,
      encode: (id, to, p) => encodeClaim({ id, to, ...p }),
      tag: (p) => p.puddle,
      done: (o) => opts.done({ id: o.id, to: o.to, puddle: o.tag, result: o.result }),
    });
  }
}

// ───────────── mud puddles: a world object, decided by its dropper ─────────────

/** How long a puddle lies on the road, and how long a used one is still broadcast (as used). */
export const PUDDLE_TIMING = {
  lifeMs: 60_000,
  /** A used puddle stays in the broadcast this long (as `used`), so everyone sees it go. */
  keepUsedMs: 3_000,
  /** Claims that arrive this long after it dried up still count (they were sent in time). */
  graceMs: 1_000,
} as const;
/** Puddles one rider can have on the road at once. */
export const MAX_LIVE_PUDDLES = 2;
/**
 * Where a claimer may be (its own race position at the claim, relative to the puddle) for the
 * dropper to believe it rode through: at most `beforeM` short of it (both sides measure a
 * moving race a few hundred milliseconds apart) and at most `afterM` past it (re-sends carry
 * the claimer's latest position, for up to 5 s).
 */
export const PUDDLE_CLAIM_WINDOW = { beforeM: 30, afterM: 250 } as const;
/** A crossing is a step of at most this much between two looks (not a jump along the route). */
export const PUDDLE_MAX_STEP_M = 80;

/** Where a puddle lies (see `WirePuddle`). */
export interface PuddleAt {
  m: number;
  routeId?: string;
}

interface OwnPuddle {
  id: string;
  at: PuddleAt;
  expiresAt: number;
  /** Peer id of the one rider it hit (the first granted claim), or null. */
  hitBy: string | null;
  usedAt: number | null;
}

/** What `PuddleLedger.decide` made of a claim. */
export interface PuddleDecision {
  result: ClaimVerdict;
  /** True only for the claim that used the puddle up (the first granted one). */
  first: boolean;
}

/**
 * The dropper's book of its own puddles (docs/adr/0008-rumble-items.md). The dropper is the
 * only one who decides about its puddle, so a hit is decided without a server: claims are taken
 * in the order they arrive, the first plausible one is `granted` and uses the puddle up, every
 * later claim is `taken`; the same claimer asking again (a re-send under a new id) is
 * `granted` again, so it is still hit once. Pure and clock-free.
 */
export class PuddleLedger {
  #puddles = new Map<string, OwnPuddle>();
  #seq = 0;
  readonly #epoch: string;

  constructor(epoch: string = attackEpoch()) {
    this.#epoch = epoch;
  }

  /** Puddles on the road now (not used, not dried up). */
  live(now: number): number {
    let n = 0;
    for (const p of this.#puddles.values()) if (p.hitBy === null && now < p.expiresAt) n += 1;
    return n;
  }

  /** Drops a puddle at `at`; its id, or null when MAX_LIVE_PUDDLES already lie on the road. */
  drop(at: PuddleAt, now: number, lifeMs: number = PUDDLE_TIMING.lifeMs): string | null {
    this.#prune(now);
    if (this.live(now) >= MAX_LIVE_PUDDLES || !Number.isFinite(at.m)) return null;
    this.#seq += 1;
    const id = `${this.#epoch}.${this.#seq}`;
    this.#puddles.set(id, {
      id,
      at: { m: at.m, ...(at.routeId ? { routeId: at.routeId } : {}) },
      expiresAt: now + lifeMs,
      hitBy: null,
      usedAt: null,
    });
    return id;
  }

  /**
   * Decides a claim. `shape`: the route the puddle lies on (for the gap round a loop), when
   * known. Order: unknown or dried up → 'gone'; another route, or the claimer not plausibly at
   * the puddle → 'refused' (the puddle stays); hit already → 'granted' for the same claimer,
   * 'taken' for anyone else; otherwise the claimer is the one → 'granted' and it is used up.
   */
  decide(
    claim: { from: string; puddle: string; raceM: number; routeId?: string },
    now: number,
    shape: { lengthM: number; loop: boolean } | null = null,
  ): PuddleDecision {
    const p = this.#puddles.get(claim.puddle);
    if (!p) return { result: 'gone', first: false };
    if (p.hitBy !== null) {
      return { result: p.hitBy === claim.from ? 'granted' : 'taken', first: false };
    }
    if (now >= p.expiresAt + PUDDLE_TIMING.graceMs) return { result: 'gone', first: false };
    if ((claim.routeId ?? null) !== (p.at.routeId ?? null)) {
      return { result: 'refused', first: false };
    }
    const past =
      p.at.routeId && shape
        ? -gapAlongRoute(p.at.m, { id: p.at.routeId, m: claim.raceM, ...shape })
        : claim.raceM - p.at.m;
    if (!(past >= -PUDDLE_CLAIM_WINDOW.beforeM && past <= PUDDLE_CLAIM_WINDOW.afterM)) {
      return { result: 'refused', first: false };
    }
    p.hitBy = claim.from;
    p.usedAt = now;
    return { result: 'granted', first: true };
  }

  /** The puddles to broadcast (`RiderItems.puddles`): live ones, and used ones for a moment. */
  wire(now: number): WirePuddle[] {
    this.#prune(now);
    const out: WirePuddle[] = [];
    for (const p of this.#puddles.values()) {
      const base = {
        id: p.id,
        m: Math.round(p.at.m * 10) / 10,
        ...(p.at.routeId ? { routeId: p.at.routeId } : {}),
      };
      if (p.hitBy !== null) out.push({ ...base, s: 0, used: true });
      else if (now < p.expiresAt) {
        out.push({ ...base, s: Math.round(Math.min(600, (p.expiresAt - now) / 1000) * 10) / 10 });
      }
    }
    return out.slice(-4);
  }

  /** Whether `id` is one of this ledger's puddles (live, used or just dried up). */
  has(id: string): boolean {
    return this.#puddles.has(id);
  }

  /** Who the puddle `id` hit (peer id), if anyone. */
  hitBy(id: string): string | null {
    return this.#puddles.get(id)?.hitBy ?? null;
  }

  clear(): void {
    this.#puddles.clear();
  }

  #prune(now: number): void {
    for (const [id, p] of this.#puddles) {
      const usedGone = p.usedAt !== null && now - p.usedAt > PUDDLE_TIMING.keepUsedMs;
      // Dried-up puddles are kept a little longer than the grace, so a late claim is 'gone'
      // for the right reason, then forgotten (an unknown id is 'gone' as well).
      const dry = p.hitBy === null && now >= p.expiresAt + 10_000;
      if (usedGone || dry) this.#puddles.delete(id);
    }
  }
}

/**
 * The local rider's race position for puddles: ridden metres + race offset, and on a route its
 * base id, route metres + race offset and its shape (as `RemoteRiders.getRiders` places riders).
 */
export interface PuddleRacePosition {
  raceM: number;
  route: { id: string; m: number; lengthM: number; loop: boolean } | null;
}

/**
 * Metres from the local rider to a puddle (+ ahead, − behind), or null when it is not on this
 * rider's road (it lies on a route this rider does not ride). Without a route the puddle is a
 * ridden-distance race position, compared with the rider's own.
 */
export function puddleGap(p: PuddleAt, me: PuddleRacePosition): number | null {
  if (p.routeId) {
    if (!me.route || me.route.id !== p.routeId) return null;
    return gapAlongRoute(p.m, me.route);
  }
  return p.m - me.raceM;
}

/** The claimer's race position in the puddle's coordinates (for `ClaimPayload`). */
export function claimPosition(p: PuddleAt, me: PuddleRacePosition): ClaimPayload['raceM'] {
  return p.routeId && me.route ? me.route.m : me.raceM;
}

/** A remote rider's puddle near the local rider. */
export interface NearPuddle {
  dropper: string;
  dropperName: string;
  puddle: WirePuddle;
  /** + ahead, − behind. */
  gapM: number;
}

/**
 * The claimer's side: watches the others' puddles (from their broadcast) and reports the ones
 * the local rider just rode through — a gap that went from ahead (> 0) to reached (≤ 0) in one
 * step of at most PUDDLE_MAX_STEP_M. A puddle first seen behind the rider is never crossed;
 * the local rider's own puddles are not in the list it is given (they are not remote riders),
 * and `exclude` drops one more id for good measure. Pure.
 */
export class PuddleWatch {
  #last = new Map<string, number>();
  /** Which list of the riders' broadcast it watches: mud puddles, or (v3) tacks. */
  readonly field: 'puddles' | 'tacks';

  constructor(field: 'puddles' | 'tacks' = 'puddles') {
    this.field = field;
  }

  update(
    riders: readonly { peerId: string; name: string; stale?: boolean; items?: RiderItems }[],
    me: PuddleRacePosition,
    exclude: string | null = null,
  ): { crossed: NearPuddle[]; near: NearPuddle[] } {
    const crossed: NearPuddle[] = [];
    const near: NearPuddle[] = [];
    const seen = new Set<string>();
    for (const r of riders) {
      if (r.peerId === exclude) continue;
      for (const puddle of r.items?.[this.field] ?? []) {
        if (puddle.used || puddle.s <= 0) continue;
        const gapM = puddleGap(puddle, me);
        if (gapM === null || !Number.isFinite(gapM)) continue;
        const key = `${r.peerId}|${puddle.id}`;
        seen.add(key);
        const prev = this.#last.get(key);
        this.#last.set(key, gapM);
        const item = { dropper: r.peerId, dropperName: r.name, puddle, gapM };
        near.push(item);
        if (prev !== undefined && prev > 0 && gapM <= 0 && prev - gapM <= PUDDLE_MAX_STEP_M) {
          crossed.push(item);
        }
      }
    }
    for (const key of [...this.#last.keys()]) if (!seen.has(key)) this.#last.delete(key);
    return { crossed, near };
  }

  clear(): void {
    this.#last.clear();
  }
}

// ───────────── rough sections (v3): road, evaluated by every rider for itself ─────────────

/** A rough section's length and life, and how many one rider can have on the road at once. */
export const ROUGH_TIMING = { lengthM: 150, lifeMs: 60_000 } as const;
export const MAX_LIVE_ROUGH = 2;

interface OwnRough {
  id: string;
  at: PuddleAt;
  lenM: number;
  variant: string;
  expiresAt: number;
}

/**
 * The dropper's rough sections (ADR 0009). No claims and no judge: a section is not used up by
 * anyone, so the dropper only lays it and broadcasts it until it is gone; every other rider
 * finds out for itself whether it rides on one (`roughSpan`). Pure and clock-free.
 */
export class RoughLedger {
  #list: OwnRough[] = [];
  #seq = 0;
  readonly #epoch: string;

  constructor(epoch: string = attackEpoch()) {
    this.#epoch = epoch;
  }

  /** How many sections were laid so far (the next one's index). */
  get count(): number {
    return this.#seq;
  }

  live(now: number): number {
    this.#prune(now);
    return this.#list.length;
  }

  /** Lays a section ending at `at` (reaching `lenM` back); its id, or null when two are down. */
  drop(
    at: PuddleAt,
    variant: string,
    now: number,
    lenM: number = ROUGH_TIMING.lengthM,
    lifeMs: number = ROUGH_TIMING.lifeMs,
  ): string | null {
    this.#prune(now);
    if (this.#list.length >= MAX_LIVE_ROUGH || !Number.isFinite(at.m)) return null;
    this.#seq += 1;
    const id = `${this.#epoch}.${this.#seq}`;
    this.#list.push({
      id,
      at: { m: at.m, ...(at.routeId ? { routeId: at.routeId } : {}) },
      lenM,
      variant,
      expiresAt: now + lifeMs,
    });
    return id;
  }

  wire(now: number): WireRough[] {
    this.#prune(now);
    return this.#list.map((r) => ({
      id: r.id,
      m: Math.round(r.at.m * 10) / 10,
      ...(r.at.routeId ? { routeId: r.at.routeId } : {}),
      len: r.lenM,
      s: Math.round(Math.min(600, (r.expiresAt - now) / 1000) * 10) / 10,
      variant: r.variant,
    }));
  }

  clear(): void {
    this.#list = [];
  }

  #prune(now: number): void {
    this.#list = this.#list.filter((r) => now < r.expiresAt);
  }
}

/**
 * Where a rough section lies from the local rider: `fromM` … `toM` metres (+ ahead, − behind;
 * from < to), or null when it is not on this rider's road. The rider is on it when
 * `fromM ≤ 0 ≤ toM`.
 */
export function roughSpan(
  r: Pick<WireRough, 'm' | 'routeId' | 'len'>,
  me: PuddleRacePosition,
): { fromM: number; toM: number } | null {
  const end = puddleGap(r, me);
  if (end === null || !Number.isFinite(end)) return null;
  return { fromM: end - r.len, toM: end };
}

/** A random lowercase word for event ids (not a secret; only needs to differ per ride). */
export function attackEpoch(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 8; i++)
    s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)];
  return s;
}
