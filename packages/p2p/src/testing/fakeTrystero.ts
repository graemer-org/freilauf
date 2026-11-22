import { utf8Length } from '../documents';
import type { Timers, Unsubscribe } from '../runtime';
import type {
  TrysteroActionLike,
  TrysteroModuleLike,
  TrysteroRoomConfig,
  TrysteroRoomError,
  TrysteroRoomLike,
} from '../transports/relay';

const later = (fn: () => void): void => {
  void Promise.resolve().then(fn);
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FakeTrysteroConditions {
  /**
   * Each message is delayed by a uniform random 0..maxDelayMs (via `timers`), but — like a
   * reliable, ordered data channel — never overtakes an earlier message on the same link.
   */
  maxDelayMs?: number;
  /** Delay before two members of a room discover each other (default 0: next tick). */
  joinDelayMs?: number;
  /**
   * The member already in the room learns of the newcomer this much later than the newcomer
   * learns of it, so the newcomer's first messages can arrive before `onPeerJoin` (Trystero
   * does not do that, but our transport must cope).
   */
  joinSkewMs?: number;
}

export interface FakeTrysteroOptions {
  /** Timers for delays (pass a FakeClock's); without, everything runs on microtasks. */
  timers?: Timers;
  /** The clock behind `timers` (FakeClock's `now`), for ordering delayed messages. */
  now?: () => number;
  seed?: number;
  conditions?: FakeTrysteroConditions;
}

/**
 * In-memory stand-in for Trystero's `joinRoom` (the subset `RelayTransport` uses). Rooms are
 * keyed by app id + room id, like topics on the relays; members with the same password
 * discover each other and get `onPeerJoin`, members with different passwords get
 * `decrypt-failed` on both sides. Messages are reliable and ordered per link.
 */
export class FakeTrysteroNetwork {
  /** When false, relays never open; with `relaysFailFast` Trystero's `relay-failed` follows. */
  relaysReachable = true;
  relaysFailFast = true;
  /** When true, members discover each other but never connect (`peer-connect-failed`). */
  blockDirect = false;
  conditions: FakeTrysteroConditions;
  /** Every config passed to `joinRoom`, in order. */
  readonly configs: { peerId: string; roomId: string; config: TrysteroRoomConfig }[] = [];
  /** Every message sent through an action: [namespace, from, to, data]. */
  readonly sent: { action: string; from: string; to: string; data: string }[] = [];
  readonly #rooms = new Map<string, Set<FakeTrysteroRoom>>();
  readonly #timers: Timers | undefined;
  readonly #random: () => number;
  readonly now: () => number;

  constructor(options: FakeTrysteroOptions = {}) {
    this.#timers = options.timers;
    this.now = options.now ?? Date.now;
    this.#random = mulberry32(options.seed ?? 1);
    this.conditions = { ...options.conditions };
  }

  /** The module a rider with `peerId` would load (`trystero` option of `RelayDeps`). */
  moduleFor(peerId: string): TrysteroModuleLike {
    let last: FakeTrysteroRoom | null = null;
    return {
      joinRoom: (config, roomId) => {
        last = this.#join(peerId, config, roomId);
        return last;
      },
      getRelaySockets: () => {
        const urls = last?.config.relayConfig.urls ?? [];
        const open = this.relaysReachable && last !== null && !last.left;
        return Object.fromEntries(urls.map((u) => [u, { readyState: open ? 1 : 0 }]));
      },
    };
  }

  /** Members currently in `roomId` (any app id). */
  members(roomId: string): FakeTrysteroRoom[] {
    return [...this.#rooms.entries()]
      .filter(([key]) => key.endsWith(`|${roomId}`))
      .flatMap(([, set]) => [...set]);
  }

  /** Makes relays reachable again and lets waiting members find each other. */
  restoreRelays(): void {
    this.relaysReachable = true;
    for (const set of this.#rooms.values()) {
      const list = [...set];
      for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < i; j++) this.#discover(list[j]!, list[i]!);
      }
    }
  }

  /** Delivers `data` on action `action` from `from` to `to`, as if `from` had sent it. */
  inject(from: string, to: string, action: string, data: string): void {
    const sender = [...this.#rooms.values()].flatMap((s) => [...s]).find((r) => r.peerId === from);
    sender?.sendRaw(action, to, data);
  }

  #schedule(fn: () => void, ms: number): void {
    if (this.#timers && ms >= 0) this.#timers.setTimeout(fn, ms);
    else later(fn);
  }

  /** Delay for the next message on a link, keeping the link FIFO. */
  messageDelay(lastAt: number, now: number): number {
    const max = this.conditions.maxDelayMs ?? 0;
    const at = Math.max(lastAt, now + (max > 0 ? this.#random() * max : 0));
    return at;
  }

  get timers(): Timers | undefined {
    return this.#timers;
  }

  schedule(fn: () => void, ms: number): void {
    this.#schedule(fn, ms);
  }

  #join(peerId: string, config: TrysteroRoomConfig, roomId: string): FakeTrysteroRoom {
    this.configs.push({ peerId, roomId, config });
    const key = `${config.appId}|${roomId}`;
    let set = this.#rooms.get(key);
    if (!set) {
      set = new Set();
      this.#rooms.set(key, set);
    }
    const room = new FakeTrysteroRoom(this, peerId, config, () => {
      set.delete(room);
      if (set.size === 0) this.#rooms.delete(key);
    });
    const existing = [...set];
    set.add(room);
    if (!this.relaysReachable) {
      if (this.relaysFailFast) {
        later(() =>
          room.emitError({ code: 'relay-failed', message: 'all signaling relays failed' }),
        );
      }
      return room;
    }
    for (const other of existing) this.#discover(other, room);
    return room;
  }

  /** `older` was in the room first. */
  #discover(older: FakeTrysteroRoom, newer: FakeTrysteroRoom): void {
    if (older.linked.has(newer.peerId) || newer.linked.has(older.peerId)) return;
    const delay = this.conditions.joinDelayMs ?? 0;
    const skew = this.conditions.joinSkewMs ?? 0;
    this.#schedule(() => {
      if (older.left || newer.left) return;
      if (older.config.password !== newer.config.password) {
        older.emitError({
          code: 'decrypt-failed',
          message: 'bad password',
          peerId: newer.peerId,
          stage: 'offer',
        });
        newer.emitError({
          code: 'decrypt-failed',
          message: 'bad password',
          peerId: older.peerId,
          stage: 'answer',
        });
        return;
      }
      if (this.blockDirect) {
        for (const [a, b] of [
          [older, newer],
          [newer, older],
        ] as const) {
          a.emitError({
            code: 'peer-connect-failed',
            message: 'no direct path',
            peerId: b.peerId,
            turnConfigured: false,
          });
        }
        return;
      }
      if (older.linked.size + 1 >= older.config.maxUsers) {
        newer.emitError({ code: 'room-full', message: 'room full', peerId: older.peerId });
        return;
      }
      newer.link(older);
      if (skew > 0) this.#schedule(() => older.link(newer), skew);
      else older.link(newer);
    }, delay);
  }
}

class FakeAction implements TrysteroActionLike {
  readonly handlers = new Set<(data: unknown, ctx: { peerId: string }) => unknown>();
  gate: ((ctx: { peerId: string; byteLength: number }) => boolean) | null = null;
  readonly room: FakeTrysteroRoom;
  readonly namespace: string;
  constructor(room: FakeTrysteroRoom, namespace: string) {
    this.room = room;
    this.namespace = namespace;
  }

  send(data: string, options?: { target?: string | string[] | null }): Promise<void> {
    const targets =
      options?.target === undefined || options.target === null
        ? [...this.room.linked]
        : [options.target].flat();
    for (const to of targets) {
      if (!this.room.linked.has(to)) return Promise.reject(new Error(`no active peer ${to}`));
    }
    for (const to of targets) this.room.sendRaw(this.namespace, to, data);
    return Promise.resolve();
  }

  onMessage(handler: (data: unknown, ctx: { peerId: string }) => unknown): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onReceive(handler: (ctx: { peerId: string; byteLength: number }) => boolean): Unsubscribe {
    this.gate = handler;
    return () => {
      this.gate = null;
    };
  }
}

export class FakeTrysteroRoom implements TrysteroRoomLike {
  readonly linked = new Set<string>();
  left = false;
  readonly #actions = new Map<string, FakeAction>();
  readonly #join = new Set<(ctx: { peerId: string }) => unknown>();
  readonly #leave = new Set<(ctx: { peerId: string }) => unknown>();
  readonly #error = new Set<(err: TrysteroRoomError) => unknown>();
  readonly #lastAt = new Map<string, number>();
  readonly #peersByRoom = new Map<string, FakeTrysteroRoom>();

  readonly network: FakeTrysteroNetwork;
  readonly peerId: string;
  readonly config: TrysteroRoomConfig;
  readonly onLeft: () => void;

  constructor(
    network: FakeTrysteroNetwork,
    peerId: string,
    config: TrysteroRoomConfig,
    onLeft: () => void,
  ) {
    this.network = network;
    this.peerId = peerId;
    this.config = config;
    this.onLeft = onLeft;
  }

  makeAction(namespace: string): TrysteroActionLike {
    let a = this.#actions.get(namespace);
    if (!a) {
      a = new FakeAction(this, namespace);
      this.#actions.set(namespace, a);
    }
    return a;
  }

  onPeerJoin(handler: (ctx: { peerId: string }) => unknown): Unsubscribe {
    this.#join.add(handler);
    return () => this.#join.delete(handler);
  }

  onPeerLeave(handler: (ctx: { peerId: string }) => unknown): Unsubscribe {
    this.#leave.add(handler);
    return () => this.#leave.delete(handler);
  }

  onError(handler: (err: TrysteroRoomError) => unknown): Unsubscribe {
    this.#error.add(handler);
    return () => this.#error.delete(handler);
  }

  getSelf(): Promise<{ peerId: string }> {
    return Promise.resolve({ peerId: this.peerId });
  }

  leave(): Promise<void> {
    if (this.left) return Promise.resolve();
    this.left = true;
    this.onLeft();
    for (const [id, other] of this.#peersByRoom) {
      this.linked.delete(id);
      later(() => other.unlink(this));
    }
    this.#peersByRoom.clear();
    return Promise.resolve();
  }

  // ---- used by the network ----

  link(other: FakeTrysteroRoom): void {
    if (this.left || other.left || this.linked.has(other.peerId)) return;
    this.linked.add(other.peerId);
    this.#peersByRoom.set(other.peerId, other);
    for (const h of [...this.#join]) h({ peerId: other.peerId });
  }

  unlink(other: FakeTrysteroRoom): void {
    if (!this.linked.delete(other.peerId)) return;
    this.#peersByRoom.delete(other.peerId);
    for (const h of [...this.#leave]) h({ peerId: other.peerId });
  }

  emitError(err: TrysteroRoomError): void {
    if (this.left) return;
    for (const h of [...this.#error]) h(err);
  }

  sendRaw(action: string, to: string, data: string): void {
    const target = this.#peersByRoom.get(to);
    if (!target || this.left) return;
    this.network.sent.push({ action, from: this.peerId, to, data });
    const timers = this.network.timers;
    const deliver = () => target.receive(action, this.peerId, data);
    if (!timers) {
      later(deliver);
      return;
    }
    // FakeClock: `setTimeout(fn, 0)` runs on the next advance; equal times keep FIFO order.
    const now = this.network.now();
    const at = this.network.messageDelay(this.#lastAt.get(to) ?? 0, now);
    this.#lastAt.set(to, at);
    this.network.schedule(deliver, Math.max(0, at - now));
  }

  receive(action: string, from: string, data: string): void {
    if (this.left) return;
    const a = this.#actions.get(action);
    if (!a) return;
    const bytes = utf8Length(data);
    if (a.gate && !a.gate({ peerId: from, byteLength: bytes })) return;
    for (const h of [...a.handlers]) h(data, { peerId: from });
  }
}
