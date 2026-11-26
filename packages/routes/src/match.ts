/**
 * Matching a recorded track (e.g. a ride file from a friend) to a route by GPS proximity, for
 * the ghost rider (docs/ghost.md): each point is placed at the nearest place along the route,
 * searched forward from the previous one, so an out-and-back's return leg and the laps of a
 * loop are told apart. The longest part that follows the route continuously is used; a track
 * that does not follow the route is refused with the reason.
 */
import { haversineM, project } from './geo';
import type { RouteTrack } from './types';

/** Farther than this from the road, a point is off the route (GPS noise and smoothing fit). */
export const MATCH_TOLERANCE_M = 60;
/** This many points in a row off the route (or going backwards) end a continuous part. */
const OFF_ROUTE_POINTS = 5;
/** A part must follow at least this much of the route (or all of a short route) to be used. */
export const MIN_MATCH_M = 500;
/** How far back along the route the next point may lie (GPS jitter while slow). */
const BACK_M = 30;
/** How far ahead the search looks at least, and per second since the last point. */
const AHEAD_MIN_M = 300;
const AHEAD_PER_S = 40;

export interface MatchPoint {
  timeS: number;
  lat: number;
  lon: number;
}

export type MatchResult =
  | {
      ok: true;
      /** Moving time and route position (m from the start, across laps) of the matched part. */
      points: { timeS: number; distanceM: number }[];
      fromM: number;
      toM: number;
      /** Share of the file's positioned points that lie in the matched part (0 … 1). */
      share: number;
      /** Mean distance of the matched points from the road (m). */
      meanOffM: number;
    }
  | { ok: false; reason: string };

const km = (m: number): string => `${(m / 1000).toFixed(1)} km`;

interface Near {
  /** Route position 0 … length. */
  at: number;
  off: number;
}

/** The nearest place on segments [i0, i1) (indices may run past the end on a loop). */
function nearest(
  xs: Float64Array,
  ys: Float64Array,
  n: number,
  step: number,
  loop: boolean,
  px: number,
  py: number,
  i0: number,
  i1: number,
  /** Route position the point is expected near; places behind it (or far beyond) cost more. */
  here?: { at: number; maxAheadM: number },
): Near {
  let best: Near = { at: 0, off: Infinity };
  let bestCost = Infinity;
  const segs = n - 1;
  for (let j = i0; j < i1; j++) {
    const i = loop ? ((j % segs) + segs) % segs : j;
    if (i < 0 || i >= segs) continue;
    const ax = xs[i]!;
    const ay = ys[i]!;
    const bx = xs[i + 1]!;
    const by = ys[i + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    let cost = off;
    if (here) {
      // Along the window (unwrapped on a loop): behind is unlikely, far ahead too.
      const delta = (j + t) * step - here.at;
      cost += delta < 0 ? -delta : Math.max(0, delta - here.maxAheadM) * 0.2;
    }
    if (off <= MATCH_TOLERANCE_M ? cost < bestCost : bestCost === Infinity && off < best.off) {
      best = { at: (i + t) * step, off };
      if (off <= MATCH_TOLERANCE_M) bestCost = cost;
    }
  }
  return best;
}

/** The nearest place of each stretch of the route within MATCH_TOLERANCE_M of a point. */
function candidates(
  xs: Float64Array,
  ys: Float64Array,
  n: number,
  step: number,
  px: number,
  py: number,
): Near[] {
  const out: Near[] = [];
  let run: Near | null = null;
  for (let i = 0; i < n - 1; i++) {
    const near = nearest(xs, ys, n, step, false, px, py, i, i + 1);
    if (near.off <= MATCH_TOLERANCE_M) {
      if (!run || near.off < run.off) run = near;
    } else if (run) {
      out.push(run);
      run = null;
    }
  }
  if (run) out.push(run);
  return out;
}

/**
 * Places a track on a route. Points need moving time (s) and a position; points without a
 * position are left out before calling.
 */
export function matchTrackToRoute(track: RouteTrack, input: readonly MatchPoint[]): MatchResult {
  const pts = input.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.timeS),
  );
  if (pts.length < 2) {
    return {
      ok: false,
      reason: 'The ride has no GPS positions, so it cannot be placed on this route.',
    };
  }
  const n = track.count;
  const L = track.totalDistanceM;
  const step = track.stepM;
  const origin = { lat0: track.lat[0]!, lon0: track.lon[0]! };
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = project(origin, track.lat[i]!, track.lon[i]!);
    xs[i] = p.x;
    ys[i] = p.y;
  }
  const segs = n - 1;
  const loop = track.loop;

  // Far away altogether? Measure the closest approach.
  let closest = Infinity;
  for (let k = 0; k < pts.length; k += Math.max(1, Math.floor(pts.length / 400))) {
    const p = pts[k]!;
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 400))) {
      closest = Math.min(closest, haversineM(p.lat, p.lon, track.lat[i]!, track.lon[i]!));
    }
  }
  if (closest > 5_000) {
    return {
      ok: false,
      reason: `The ride is nowhere near this route (${km(closest)} away at its closest).`,
    };
  }

  type Part = { points: { timeS: number; distanceM: number }[]; offSum: number; next: number };
  const proj = pts.map((p) => project(origin, p.lat, p.lon));

  /**
   * Follows the track from point `k`, placed at route position `at`, until it leaves the route
   * (or `limit` points were looked at). Returns the part and the index after it.
   */
  const follow = (k: number, at: number, off: number, limit: number): Part => {
    const part: Part = {
      points: [{ timeS: pts[k]!.timeS, distanceM: at }],
      offSum: off,
      next: k + 1,
    };
    let unrolled = at;
    let lastTimeS = pts[k]!.timeS;
    let misses = 0;
    let backwards = 0;
    let i = k + 1;
    for (; i < pts.length && i - k <= limit; i++) {
      const p = pts[i]!;
      const { x, y } = proj[i]!;
      const dt = Math.max(0, p.timeS - lastTimeS);
      const ahead = AHEAD_MIN_M + AHEAD_PER_S * dt;
      const here = loop ? unrolled - Math.floor(unrolled / L) * L : unrolled;
      const i0 = Math.floor((here - BACK_M) / step);
      const i1 = Math.ceil((here + ahead) / step) + 1;
      const near = nearest(xs, ys, n, step, loop, x, y, i0, Math.min(i1, loop ? i0 + segs : segs), {
        at: here,
        maxAheadM: 15 + 25 * dt,
      });
      if (near.off > MATCH_TOLERANCE_M) {
        if (++misses >= OFF_ROUTE_POINTS) break;
        continue;
      }
      // Unroll across the start/finish line of a loop.
      let d = near.at - here + unrolled;
      if (loop) {
        while (d < unrolled - L / 2) d += L;
        while (d > unrolled + L / 2) d -= L;
      }
      if (d < unrolled - BACK_M) {
        if (++backwards >= OFF_ROUTE_POINTS) break;
        continue;
      }
      misses = 0;
      backwards = 0;
      lastTimeS = p.timeS;
      if (d > unrolled) unrolled = d;
      part.points.push({ timeS: p.timeS, distanceM: unrolled });
      part.offSum += near.off;
      part.next = i + 1;
    }
    return part;
  };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]!);
    maxX = Math.max(maxX, xs[i]!);
    minY = Math.min(minY, ys[i]!);
    maxY = Math.max(maxY, ys[i]!);
  }
  const T = MATCH_TOLERANCE_M;
  const parts: Part[] = [];
  let k = 0;
  while (k < pts.length) {
    const q = proj[k]!;
    if (q.x < minX - T || q.x > maxX + T || q.y < minY - T || q.y > maxY + T) {
      k++;
      continue;
    }
    // Where on the route could this point be? Every stretch of road within the tolerance (an
    // out-and-back passes twice); the one the next points follow forward wins.
    const options = candidates(xs, ys, n, step, proj[k]!.x, proj[k]!.y);
    if (options.length === 0) {
      k++;
      continue;
    }
    let chosen = options[0]!;
    if (options.length > 1) {
      let score = -Infinity;
      for (const o of options) {
        const trial = follow(k, o.at, o.off, 40);
        const gain = trial.points[trial.points.length - 1]!.distanceM - o.at;
        const s = trial.points.length * 1000 + gain - o.off;
        if (s > score) {
          score = s;
          chosen = o;
        }
      }
    }
    const part = follow(k, chosen.at, chosen.off, Infinity);
    parts.push(part);
    k = Math.max(k + 1, part.next);
  }

  let best: Part | null = null;
  let bestLen = -1;
  for (const q of parts) {
    const len = q.points[q.points.length - 1]!.distanceM - q.points[0]!.distanceM;
    if (len > bestLen) {
      best = q;
      bestLen = len;
    }
  }
  const needed = Math.min(MIN_MATCH_M, L * 0.8);
  if (!best || bestLen < needed) {
    const reversed = followsBackwards(xs, ys, n, step, origin, pts);
    return {
      ok: false,
      reason: reversed
        ? 'The ride goes the other way along this route.'
        : bestLen > 0
          ? `Only ${Math.round(bestLen)} m of the ride follow this route; a ghost needs at least ${Math.round(needed)} m in one go.`
          : `The ride does not follow this route (it comes within ${Math.round(closest)} m of it, but never along it).`,
    };
  }
  return {
    ok: true,
    points: best.points,
    fromM: best.points[0]!.distanceM,
    toM: best.points[best.points.length - 1]!.distanceM,
    share: best.points.length / pts.length,
    meanOffM: best.offSum / best.points.length,
  };
}

/** True when most of the track lies on the route but its positions run backwards along it. */
function followsBackwards(
  xs: Float64Array,
  ys: Float64Array,
  n: number,
  step: number,
  origin: { lat0: number; lon0: number },
  pts: readonly MatchPoint[],
): boolean {
  let on = 0;
  let down = 0;
  let up = 0;
  let prev: number | null = null;
  const every = Math.max(1, Math.floor(pts.length / 300));
  for (let k = 0; k < pts.length; k += every) {
    const p = pts[k]!;
    const { x, y } = project(origin, p.lat, p.lon);
    const near = nearest(xs, ys, n, step, false, x, y, 0, n - 1);
    if (near.off > MATCH_TOLERANCE_M) {
      prev = null;
      continue;
    }
    on++;
    if (prev !== null) {
      if (near.at < prev - 1) down++;
      else if (near.at > prev + 1) up++;
    }
    prev = near.at;
  }
  return on >= 10 && down > up * 3;
}
