import { sanitizeName } from './signalling/channel';
import type { GroupRider, RiderRoute, RiderState } from './types';

/** No update for this long -> `stale: true`. */
export const STALE_AFTER_MS = 3_000;
/** Distance is extrapolated with the last speed for at most this long. */
export const MAX_EXTRAPOLATION_MS = 2_000;
/** Time constant with which a correction (new packet vs. extrapolation) is blended in. */
export const SMOOTHING_TAU_MS = 600;
/** Corrections larger than this snap instead of blending (first packet, big jumps). */
export const SNAP_DISTANCE_M = 100;
/** A `sentAt` this much *older* than the last one is treated as a sender clock reset. */
export const CLOCK_RESET_MS = 5_000;
export const MAX_STATE_MESSAGE_LENGTH = 2_048;
export const STATE_MESSAGE_VERSION = 1;

/** Accepted ranges; anything outside drops the whole packet. */
export const RIDER_STATE_LIMITS = {
  distanceM: [0, 10_000_000],
  speedMps: [0, 50],
  powerW: [0, 4_000],
  cadenceRpm: [0, 300],
  heartRateBpm: [0, 300],
  gear: [0, 100],
  /** Routes are at most 1000 km (MAX_ROUTE_LENGTH_M in @freilauf/routes). */
  routeM: [0, 1_000_000],
} as const;

/** Route ids as @freilauf/routes makes them (and its codec accepts). */
const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The local rider's route, for placing the others on it (see RemoteRiders.getRiders). */
export interface LocalRoutePlacement extends RiderRoute {
  /** Length of the route (m) and whether it is ridden as laps. */
  lengthM: number;
  loop: boolean;
}

/** Data channel message: `{"v":1,"type":"state","state":{...RiderState}}`. */
export interface StateMessage {
  v: typeof STATE_MESSAGE_VERSION;
  type: 'state';
  state: RiderState;
}

function inRange(v: unknown, [min, max]: readonly [number, number]): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/**
 * Validates and sanitises an untrusted rider state. Returns null for anything malformed:
 * wrong types, non-finite numbers or values outside RIDER_STATE_LIMITS. Names are stripped of
 * control/bidi characters and cut to 24 code points (empty -> "Rider").
 */
export function sanitizeRiderState(value: unknown): RiderState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const L = RIDER_STATE_LIMITS;
  if (typeof v['name'] !== 'string') return null;
  const sentAt = v['sentAt'];
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt <= 0) return null;
  const { distanceM, speedMps, powerW, cadenceRpm, heartRateBpm, gear } = v;
  if (!inRange(distanceM, L.distanceM)) return null;
  if (!inRange(speedMps, L.speedMps)) return null;
  if (!inRange(powerW, L.powerW)) return null;
  if (!inRange(cadenceRpm, L.cadenceRpm)) return null;
  const hr =
    heartRateBpm === null ? null : inRange(heartRateBpm, L.heartRateBpm) ? heartRateBpm : undefined;
  if (hr === undefined) return null;
  if (!inRange(gear, L.gear)) return null;
  // Optional; when present it must be valid like every other field.
  let route: RiderRoute | undefined;
  if (v['route'] !== undefined) {
    const r = v['route'];
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return null;
    const { id, m } = r as Record<string, unknown>;
    if (typeof id !== 'string' || !ROUTE_ID.test(id) || !inRange(m, L.routeM)) return null;
    route = { id, m };
  }
  return {
    name: sanitizeName(v['name']) || 'Rider',
    sentAt,
    distanceM,
    speedMps,
    powerW,
    cadenceRpm,
    heartRateBpm: hr,
    gear: Math.round(gear),
    ...(route ? { route } : {}),
  };
}

export function encodeStateMessage(state: RiderState): string {
  const msg: StateMessage = { v: STATE_MESSAGE_VERSION, type: 'state', state };
  return JSON.stringify(msg);
}

/** Parses a raw data-channel message. Never throws; null for anything that is not a valid state. */
export function decodeStateMessage(raw: unknown): RiderState | null {
  if (typeof raw !== 'string' || raw.length > MAX_STATE_MESSAGE_LENGTH) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m['v'] !== STATE_MESSAGE_VERSION || m['type'] !== 'state') return null;
  return sanitizeRiderState(m['state']);
}

/** Distance after `elapsedMs` at constant speed, extrapolating at most MAX_EXTRAPOLATION_MS. */
export function extrapolateDistance(
  distanceM: number,
  speedMps: number,
  elapsedMs: number,
): number {
  const dt = Math.min(Math.max(elapsedMs, 0), MAX_EXTRAPOLATION_MS);
  return distanceM + (speedMps * dt) / 1000;
}

interface Track {
  state: RiderState;
  /** Local receive time (local clock); never compared with the sender's clock. */
  receivedAt: number;
  /** Display offset at `receivedAt`, decaying to 0 (smooths corrections). */
  offsetM: number;
}

function displayedDistance(track: Track, now: number): number {
  const base = extrapolateDistance(
    track.state.distanceM,
    track.state.speedMps,
    now - track.receivedAt,
  );
  if (track.offsetM === 0) return base;
  const dt = Math.max(0, now - track.receivedAt);
  return Math.max(0, base + track.offsetM * Math.exp(-dt / SMOOTHING_TAU_MS));
}

/**
 * Remote rider bookkeeping: ordering, extrapolation, smoothing, staleness, gaps.
 * Pure and clock-free (every method takes the local time), so it is trivially testable.
 */
export class RemoteRiders {
  #tracks = new Map<string, Track>();

  /** Returns true if the state was accepted (newer than the last one from that peer). */
  ingest(peerId: string, state: RiderState, receivedAt: number): boolean {
    const prev = this.#tracks.get(peerId);
    if (!prev) {
      this.#tracks.set(peerId, { state, receivedAt, offsetM: 0 });
      return true;
    }
    const back = prev.state.sentAt - state.sentAt;
    if (back >= 0 && back < CLOCK_RESET_MS) return false; // duplicate or out of order
    const shown = displayedDistance(prev, receivedAt);
    let offsetM = shown - state.distanceM;
    if (Math.abs(offsetM) > SNAP_DISTANCE_M) offsetM = 0;
    this.#tracks.set(peerId, { state, receivedAt, offsetM });
    return true;
  }

  remove(peerId: string): boolean {
    return this.#tracks.delete(peerId);
  }

  has(peerId: string): boolean {
    return this.#tracks.has(peerId);
  }

  clear(): void {
    this.#tracks.clear();
  }

  /**
   * Remote riders at local time `now`, leader first. `gapM` is measured along the route for
   * riders on `localRoute` (same id), otherwise relative to `localDistanceM` (ridden distance).
   */
  getRiders(
    now: number,
    localDistanceM: number,
    localRoute?: LocalRoutePlacement | null,
  ): GroupRider[] {
    const riders: GroupRider[] = [];
    for (const [peerId, track] of this.#tracks) {
      const s = track.state;
      const distanceM = displayedDistance(track, now);
      const routeGap =
        localRoute && s.route && s.route.id === localRoute.id
          ? // The route position moves with the (extrapolated, smoothed) distance.
            gapAlongRoute(s.route.m + (distanceM - s.distanceM), localRoute)
          : null;
      riders.push({
        peerId,
        name: s.name,
        distanceM,
        speedMps: s.speedMps,
        powerW: s.powerW,
        cadenceRpm: s.cadenceRpm,
        heartRateBpm: s.heartRateBpm,
        gear: s.gear,
        gapM: routeGap ?? distanceM - localDistanceM,
        ...(routeGap !== null ? { sameRoute: true } : {}),
        stale: now - track.receivedAt > STALE_AFTER_MS,
      });
    }
    riders.sort((a, b) => b.gapM - a.gapM || (a.peerId < b.peerId ? -1 : 1));
    return riders;
  }
}

/**
 * A route position moved along by extrapolation, put back on the route: wrapped on a loop,
 * clamped to the route otherwise (and to RIDER_STATE_LIMITS without a known shape).
 */
export function routeAhead(m: number, shape: { lengthM: number; loop: boolean } | null): number {
  const [min, max] = RIDER_STATE_LIMITS.routeM;
  if (!Number.isFinite(m)) return 0;
  if (shape && shape.lengthM > 0) {
    const L = shape.lengthM;
    if (shape.loop) return Math.min(max, m - Math.floor(m / L) * L);
    return Math.min(L, Math.max(0, m));
  }
  return Math.min(max, Math.max(min, m));
}

/**
 * Gap (m, + = ahead) from the local rider to a position on the same route: on a loop the shorter
 * way round (−length/2 … +length/2), otherwise along the road, both clamped to the route.
 */
export function gapAlongRoute(remoteM: number, local: LocalRoutePlacement): number {
  const L = local.lengthM;
  if (!(L > 0)) return remoteM - local.m;
  if (local.loop) {
    const g = remoteM - local.m;
    return g - Math.floor((g + L / 2) / L) * L;
  }
  const clamp = (v: number): number => Math.min(L, Math.max(0, v));
  return clamp(remoteM) - clamp(local.m);
}
