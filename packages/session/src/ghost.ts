/**
 * Ghost traces (docs/ghost.md): how far along a route a ride was after how much moving time,
 * derived from a stored ride when it is needed and never stored themselves.
 *
 * A trace is in route coordinates: metres from the route's start, continuing across laps on a
 * loop (lap 2 starts at the route's length). A ride that jumped along the route consists of
 * several continuous parts; only the longest one becomes the ghost, because across a jump the
 * ride's time says nothing about the road in between (ADR 0010).
 */
import type { RecordedRide, RideRoute, RideWeather } from './types';

export interface GhostTrace {
  /** Moving time (s) since the ride started, non-decreasing. */
  timeS: number[];
  /** Route position (m) at that time, strictly increasing. */
  distanceM: number[];
}

/** Points are kept at most every this many metres (the stored ride is 1 Hz). */
export const GHOST_STEP_M = 5;
/** A trace never holds more points than this; long rides get a coarser step. */
export const MAX_GHOST_POINTS = 20_000;
/** A continuous part shorter than this is no ghost. */
export const MIN_GHOST_M = 200;
/** Slack at the ends when deciding whether a ride covered the whole route. */
const COVER_SLACK_M = 0.5;

export interface GhostPoint {
  timeS: number;
  distanceM: number;
}

/**
 * Downsamples (and makes monotone) a list of time/position points: distance never decreases,
 * a point is kept every GHOST_STEP_M (or coarser, to stay within MAX_GHOST_POINTS), the first
 * and the last are always kept.
 */
export function downsampleTrace(points: readonly GhostPoint[]): GhostTrace {
  const timeS: number[] = [];
  const distanceM: number[] = [];
  const clean = points.filter((p) => Number.isFinite(p.timeS) && Number.isFinite(p.distanceM));
  if (clean.length === 0) return { timeS, distanceM };
  let maxD = -Infinity;
  let maxT = -Infinity;
  const mono = clean.map((p) => {
    maxD = Math.max(maxD, p.distanceM);
    maxT = Math.max(maxT, p.timeS);
    return { t: maxT, d: maxD };
  });
  const first = mono[0]!;
  const last = mono[mono.length - 1]!;
  const step = Math.max(GHOST_STEP_M, (last.d - first.d) / (MAX_GHOST_POINTS - 2));
  timeS.push(first.t);
  distanceM.push(first.d);
  for (let i = 1; i < mono.length; i++) {
    const p = mono[i]!;
    if (p.d - distanceM[distanceM.length - 1]! >= step) {
      timeS.push(p.t);
      distanceM.push(p.d);
    }
  }
  if (last.d > distanceM[distanceM.length - 1]!) {
    timeS.push(last.t);
    distanceM.push(last.d);
  }
  return { timeS, distanceM };
}

/** Time at route position `d` on raw points (linear between them); null outside. */
export function timeAtDistance(points: readonly GhostPoint[], d: number): number | null {
  if (points.length === 0) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (d < first.distanceM - 1e-9 || d > last.distanceM + 1e-9) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.distanceM < d) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  if (d <= a.distanceM) return a.timeS;
  const span = b.distanceM - a.distanceM;
  return span > 0 ? a.timeS + ((d - a.distanceM) / span) * (b.timeS - a.timeS) : b.timeS;
}

/**
 * The fastest time for the whole route within one continuous part: start to finish on a
 * point-to-point route (the part must begin at the start), any full lap from the start/finish
 * line on a loop. null when the part does not cover it.
 */
export function fullRouteTimeS(
  points: readonly GhostPoint[],
  shape: { lengthM: number; loop: boolean },
): number | null {
  const L = shape.lengthM;
  if (points.length < 2 || !(L > 0)) return null;
  const from = points[0]!.distanceM;
  const to = points[points.length - 1]!.distanceM;
  if (!shape.loop) {
    if (from > COVER_SLACK_M || to < L - COVER_SLACK_M) return null;
    const a = timeAtDistance(points, Math.max(from, 0));
    const b = timeAtDistance(points, Math.min(to, L));
    return a !== null && b !== null ? b - a : null;
  }
  let best: number | null = null;
  for (
    let k = Math.max(0, Math.ceil((from - COVER_SLACK_M) / L));
    (k + 1) * L <= to + COVER_SLACK_M;
    k++
  ) {
    const a = timeAtDistance(points, Math.max(from, k * L));
    const b = timeAtDistance(points, Math.min(to, (k + 1) * L));
    if (a !== null && b !== null && (best === null || b - a < best)) best = b - a;
  }
  return best;
}

/** RecordedRide.route if it is well-formed (stored files are untrusted). */
export function validRideRoute(route: unknown): RideRoute | null {
  if (typeof route !== 'object' || route === null) return null;
  const r = route as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 200) return null;
  if (typeof r.lengthM !== 'number' || !Number.isFinite(r.lengthM) || r.lengthM <= 0) return null;
  if (typeof r.loop !== 'boolean' || !Array.isArray(r.offsetsM)) return null;
  if (r.offsetsM.length === 0 || r.offsetsM.length > 10_000) return null;
  if (!r.offsetsM.every((o) => typeof o === 'number' && Number.isFinite(o) && o >= 0)) return null;
  const weather = validRideWeather(r.weather);
  return {
    id: r.id,
    lengthM: r.lengthM,
    loop: r.loop,
    offsetsM: r.offsetsM as number[],
    ...(weather ? { weather } : {}),
  };
}

/** RideRoute.weather if well-formed; null for none (or a broken one: treated as no wind). */
export function validRideWeather(w: unknown): RideWeather | null {
  if (typeof w !== 'object' || w === null) return null;
  const { key, label } = w as Record<string, unknown>;
  if (typeof key !== 'string' || key.length === 0 || key.length > 40) return null;
  if (typeof label !== 'string' || label.length === 0 || label.length > 80) return null;
  return { key, label };
}

/** The conditions key of a ride's route info: its weather key, or null for no wind. */
export const conditionsOf = (w: RideWeather | null | undefined): string | null => w?.key ?? null;

/** One continuous part of a ride along its route, as raw points. */
export function rideRouteParts(
  ride: RecordedRide,
): { route: RideRoute; parts: GhostPoint[][] } | null {
  const route = validRideRoute(ride.route);
  if (!route) return null;
  const L = route.lengthM;
  const parts: GhostPoint[][] = [];
  let current: GhostPoint[] | null = null;
  let currentSeg = -1;
  let done = false; // point-to-point: the part reached the finish
  for (const s of ride.samples) {
    const seg = typeof s.segment === 'number' && Number.isInteger(s.segment) ? s.segment : 0;
    const offset = route.offsetsM[seg];
    if (offset === undefined || !Number.isFinite(s.distanceM) || !Number.isFinite(s.elapsedS)) {
      continue;
    }
    if (seg !== currentSeg) {
      current = [];
      parts.push(current);
      currentSeg = seg;
      done = false;
      // The ride starts at its start point at time 0 (the first sample is a second in).
      if (seg === 0) current.push({ timeS: 0, distanceM: offset });
    }
    if (done || !current) continue;
    const d = offset + s.distanceM;
    if (!route.loop && d >= L) {
      // Past the finish the road continues flat: only the crossing belongs to the route.
      const prev = current[current.length - 1];
      if (prev && prev.distanceM < L && d > prev.distanceM) {
        const f = (L - prev.distanceM) / (d - prev.distanceM);
        current.push({ timeS: prev.timeS + f * (s.elapsedS - prev.timeS), distanceM: L });
      } else if (!prev) current.push({ timeS: s.elapsedS, distanceM: L });
      done = true;
      continue;
    }
    current.push({ timeS: s.elapsedS, distanceM: d });
  }
  return { route, parts: parts.filter((p) => p.length >= 2) };
}

export interface RideGhost {
  /** routeBaseId of the route. */
  routeId: string;
  trace: GhostTrace;
  /** Route positions where the ghost's part begins and ends (m, across laps). */
  fromM: number;
  toM: number;
  /** Time for the whole route within this part (see fullRouteTimeS), or null. */
  fullTimeS: number | null;
  /** Continuous parts the ride had (1 = no jumps). */
  parts: number;
}

/** The ghost of a stored ride: its longest continuous part along its route, or null. */
export function rideGhost(ride: RecordedRide): RideGhost | null {
  const found = rideRouteParts(ride);
  if (!found || found.parts.length === 0) return null;
  let best: GhostPoint[] | null = null;
  let bestLen = -1;
  for (const p of found.parts) {
    const len = p[p.length - 1]!.distanceM - p[0]!.distanceM;
    if (len > bestLen) {
      best = p;
      bestLen = len;
    }
  }
  if (!best || bestLen < MIN_GHOST_M) return null;
  const trace = downsampleTrace(best);
  return {
    routeId: found.route.id,
    trace,
    fromM: trace.distanceM[0]!,
    toM: trace.distanceM[trace.distanceM.length - 1]!,
    fullTimeS: fullRouteTimeS(best, found.route),
    parts: found.parts.length,
  };
}

/** What the ride history shows about a ride's route (RideListItem.route). */
export interface RideRouteInfo {
  id: string;
  /** Where its ghost part begins and ends (m); equal when it has none. */
  fromM: number;
  toM: number;
  fullTimeS: number | null;
  /** False when the ride jumped along the route (its ghost is its longest continuous part). */
  continuous: boolean;
  /** True when the ride can be raced as a ghost (a continuous part of at least MIN_GHOST_M). */
  ghost: boolean;
  /** Ridden with a day's wind (absent = no wind). */
  weather?: RideWeather;
}

export function rideRouteInfo(ride: RecordedRide): RideRouteInfo | null {
  const route = validRideRoute(ride.route);
  if (!route) return null;
  const g = rideGhost(ride);
  return {
    id: route.id,
    fromM: g?.fromM ?? route.offsetsM[0]!,
    toM: g?.toM ?? route.offsetsM[0]!,
    fullTimeS: g?.fullTimeS ?? null,
    continuous: route.offsetsM.length <= 1,
    ghost: g !== null,
    ...(route.weather ? { weather: route.weather } : {}),
  };
}
