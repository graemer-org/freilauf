/**
 * Test helpers (not exported from the package): synthetic rides and a tiny session simulator
 * that moves documents between riders exactly like the p2p transport would (one document per
 * kind and rider, the same text for everybody present).
 */

import type { Now } from './periods';
import { newRiderId } from './profile';
import { type RideFacts, type RideFactsSample, rideFacts } from './scoring';
import { type CommunityState, addRide, emptyState } from './state';
import { type OutgoingDocument, type ShareOptions, documentsToShare, mergeIncoming } from './sync';
import { seededRandom } from './util';

export const CET = 60;
/** Wednesday 2026-11-18 12:00 CET (ISO week 2026-W47, month 2026-11). */
export const T0 = Date.UTC(2026, 10, 18, 11, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const at = (ms: number, utcOffsetMin = CET): Now => ({ ms, utcOffsetMin });

export interface SyntheticRide {
  id: string;
  start: number;
  seconds: number;
  powerW: number | ((i: number) => number);
  ftpW?: number;
  speedMps?: number;
  gradePercent?: number;
  offset?: number;
  group?: boolean;
}

export function samples(r: SyntheticRide): RideFactsSample[] {
  const out: RideFactsSample[] = [];
  const speed = r.speedMps ?? 10;
  for (let i = 0; i <= r.seconds; i++) {
    out.push({
      timestamp: r.start + i * 1000,
      elapsedS: i,
      powerW: typeof r.powerW === 'function' ? r.powerW(i) : r.powerW,
      speedMps: speed,
      distanceM: i * speed,
      gradePercent: r.gradePercent ?? 0,
      heartRateBpm: null,
    });
  }
  return out;
}

export function facts(r: SyntheticRide): RideFacts {
  const f = rideFacts({
    rideId: r.id,
    startedAt: r.start,
    samples: samples(r),
    ftpW: r.ftpW ?? 250,
    utcOffsetMin: r.offset ?? CET,
    groupRide: r.group ?? false,
  });
  if (!f) throw new Error('facts failed');
  return f;
}

let counter = 0;
export function rider(name: string, seed = ++counter): CommunityState {
  return emptyState(newRiderId(seededRandom(seed * 7919)), name, T0 - 30 * DAY);
}

export function ride(state: CommunityState, r: SyntheticRide): CommunityState {
  return addRide(state, facts(r));
}

export type World = Record<string, CommunityState>;

/**
 * Runs a session among `names` for a few gossip rounds: first everyone is unidentified, then
 * identified by the rider ids learnt from documents. Returns the updated world and the last
 * documents each rider published.
 */
export function session(
  world: World,
  names: readonly string[],
  now: Now,
  options?: ShareOptions,
  rounds = 3,
): { world: World; published: Record<string, OutgoingDocument[]> } {
  const w: World = { ...world };
  const known: Record<string, Record<string, string | null>> = {};
  for (const n of names)
    known[n] = Object.fromEntries(names.filter((m) => m !== n).map((m) => [m, null]));
  const published: Record<string, OutgoingDocument[]> = {};
  for (let round = 0; round < rounds; round++) {
    for (const n of names) {
      const peers = Object.values(known[n] ?? {}).map((riderId) => ({ riderId }));
      const res = documentsToShare(w[n] as CommunityState, peers, now, options);
      w[n] = res.state;
      published[n] = res.documents;
    }
    for (const n of names) {
      for (const m of names) {
        if (m === n) continue;
        const res = mergeIncoming(w[n] as CommunityState, { peerName: m }, published[m] ?? [], now);
        w[n] = res.state;
        const k = known[n];
        if (k) k[m] = res.riderId;
      }
    }
  }
  return { world: w, published };
}

export function id(world: World, name: string): string {
  return (world[name] as CommunityState).profile.riderId;
}
