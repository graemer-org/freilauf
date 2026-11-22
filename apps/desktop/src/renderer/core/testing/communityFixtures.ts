/**
 * Test helpers for the community service (not used by the app): synthetic rides, an in-memory
 * key-value storage and a synchronous fake group session that moves shared documents between
 * riders like the p2p transport does (one document per kind and rider, same text for everyone,
 * 4 kinds / 32 KiB / 16 KiB limits), delivering only when `flush()` is called.
 */
import type { RecordedRide } from '@freilauf/session';
import type { CommunityGroupLink, GroupDocument, GroupPeer } from '../communityService';
import type { KeyValueStorage } from '../workoutLibrary';

/** Wednesday 2026-11-18 12:00 CET. */
export const T0 = Date.UTC(2026, 10, 18, 11, 0, 0);
export const CET = 60;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function syntheticRide(
  id: string,
  startedAt: number,
  seconds: number,
  powerW: number,
  speedMps = 10,
): RecordedRide {
  return {
    id,
    name: `Ride ${id}`,
    startedAt,
    riderMassKg: 75,
    samples: Array.from({ length: seconds + 1 }, (_, i) => ({
      timestamp: startedAt + i * 1000,
      elapsedS: i,
      powerW,
      cadenceRpm: 90,
      heartRateBpm: null,
      speedMps,
      distanceM: i * speedMps,
      gradePercent: 1,
      gear: 12,
    })),
  };
}

export interface MemoryStorage extends KeyValueStorage {
  map: Map<string, string>;
  writes: number;
  /** When set, setItem throws (quota). */
  full: boolean;
}

export function memoryStorage(): MemoryStorage {
  const map = new Map<string, string>();
  const s: MemoryStorage = {
    map,
    writes: 0,
    full: false,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (s.full) throw new Error('QuotaExceededError');
      s.writes++;
      map.set(k, v);
    },
  };
  return s;
}

function utf8(text: string): number {
  return new TextEncoder().encode(text).length;
}

let idCounter = 0;

/** A session hub: groups join and leave; `flush()` delivers changed documents. */
export class FakeHub {
  readonly groups = new Map<string, FakeGroup>();

  join(peerId: string, name: string): FakeGroup {
    const g = new FakeGroup(this, peerId, name);
    const existing = [...this.groups.values()];
    this.groups.set(peerId, g);
    for (const other of existing) other.emitJoined({ peerId, name });
    for (const other of existing) other.emitPeers();
    return g;
  }

  leave(peerId: string): void {
    const g = this.groups.get(peerId);
    if (!g) return;
    this.groups.delete(peerId);
    for (const other of this.groups.values()) other.dropPeer(peerId);
  }

  /** Delivers documents until nothing changes any more (at most `rounds` passes). */
  flush(rounds = 10): void {
    for (let r = 0; r < rounds; r++) {
      let delivered = false;
      for (const receiver of this.groups.values()) {
        for (const sender of this.groups.values()) {
          if (sender !== receiver && receiver.receive(sender)) delivered = true;
        }
      }
      if (!delivered) return;
    }
  }
}

export class FakeGroup implements CommunityGroupLink {
  readonly local = new Map<string, { id: string; text: string }>();
  /** sender peerId → kind → document as delivered. */
  readonly inbox = new Map<string, Map<string, { id: string; text: string }>>();
  /** Every text ever delivered to this group, per sender. */
  readonly received: { from: string; kind: string; text: string }[] = [];
  readonly #docListeners = new Set<(peerId: string, kind: string) => void>();
  readonly #joinListeners = new Set<(peer: GroupPeer) => void>();
  readonly #peerListeners = new Set<() => void>();

  readonly hub: FakeHub;
  readonly peerId: string;
  readonly name: string;

  constructor(hub: FakeHub, peerId: string, name: string) {
    this.hub = hub;
    this.peerId = peerId;
    this.name = name;
  }

  shareDocument(kind: string, text: string): string | null {
    if (!this.hub.groups.has(this.peerId)) return 'closed';
    if (utf8(text) > 16_384) return 'too-large';
    const existing = this.local.get(kind);
    if (existing?.text === text) return null;
    if (!existing && this.local.size >= 4) return 'too-many-documents';
    let total = utf8(text);
    for (const [k, d] of this.local) if (k !== kind) total += utf8(d.text);
    if (total > 32_768) return 'too-many-bytes';
    this.local.set(kind, { id: `d${++idCounter}`, text });
    return null;
  }

  unshareDocument(kind: string): void {
    this.local.delete(kind);
  }

  getLocalDocuments(): { kind: string; text: string }[] {
    return [...this.local].map(([kind, d]) => ({ kind, text: d.text }));
  }

  getSharedDocuments(): GroupDocument[] {
    const out: GroupDocument[] = [];
    for (const [peerId, docs] of this.inbox) {
      const name = this.hub.groups.get(peerId)?.name ?? 'Rider';
      for (const [kind, d] of docs)
        out.push({ peerId, peerName: name, kind, id: d.id, text: d.text });
    }
    return out;
  }

  onDocumentChange(listener: (peerId: string, kind: string) => void): () => void {
    this.#docListeners.add(listener);
    return () => this.#docListeners.delete(listener);
  }

  getPeers(): GroupPeer[] {
    return [...this.hub.groups.values()]
      .filter((g) => g !== this)
      .map((g) => ({ peerId: g.peerId, name: g.name }));
  }

  onPeerJoined(listener: (peer: GroupPeer) => void): () => void {
    this.#joinListeners.add(listener);
    return () => this.#joinListeners.delete(listener);
  }

  onPeersChange(listener: () => void): () => void {
    this.#peerListeners.add(listener);
    return () => this.#peerListeners.delete(listener);
  }

  leave(): void {
    this.hub.leave(this.peerId);
  }

  emitJoined(peer: GroupPeer): void {
    for (const l of [...this.#joinListeners]) l(peer);
  }

  emitPeers(): void {
    for (const l of [...this.#peerListeners]) l();
  }

  dropPeer(peerId: string): void {
    const docs = this.inbox.get(peerId);
    this.inbox.delete(peerId);
    for (const kind of docs?.keys() ?? []) for (const l of [...this.#docListeners]) l(peerId, kind);
    this.emitPeers();
  }

  /** Brings this group's copy of `sender`'s documents up to date. True if anything changed. */
  receive(sender: FakeGroup): boolean {
    let box = this.inbox.get(sender.peerId);
    if (!box) {
      box = new Map();
      this.inbox.set(sender.peerId, box);
    }
    const changed: string[] = [];
    for (const [kind, d] of sender.local) {
      if (box.get(kind)?.id === d.id) continue;
      box.set(kind, { ...d });
      this.received.push({ from: sender.peerId, kind, text: d.text });
      changed.push(kind);
    }
    for (const kind of [...box.keys()]) {
      if (!sender.local.has(kind)) {
        box.delete(kind);
        changed.push(kind);
      }
    }
    for (const kind of changed) for (const l of [...this.#docListeners]) l(sender.peerId, kind);
    return changed.length > 0;
  }
}
