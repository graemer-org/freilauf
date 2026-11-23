/**
 * Queries on a prepared track. Distances are metres along the route. On a loop every query
 * wraps (lap 2 continues where lap 1 started; headings keep counting the turns); on a
 * point-to-point route distances are clamped to the route, and past the finish the road is
 * flat and straight (grade and curvature 0).
 */
import { ascentDescent } from './build';
import type { RoutePosition, RouteTrack } from './types';

interface Derived {
  /** Gradient at each sample (fraction), central differences. */
  grade: number[];
  /** Curvature at each sample (1/m), from the smoothed heading. */
  curvature: number[];
  /** Ascent from the start up to each sample (m). */
  cumAscent: number[];
  /** Net heading change over one lap (whole turns; 0 for point-to-point). */
  lapTurn: number;
}

/** Curvature is capped here (radius 5 m): U-turns on out-and-back routes are not drawable tighter. */
export const MAX_CURVATURE = 0.2;

const cache = new WeakMap<RouteTrack, Derived>();

function derived(track: RouteTrack): Derived {
  let d = cache.get(track);
  if (d) return d;
  const n = track.count;
  const e = track.elevationM;
  const h = track.headingRad;
  const s = track.stepM;
  const m = track.loop ? n - 1 : n;
  const lapTurn = track.loop ? h[n - 1]! - h[0]! : 0;
  const at = (arr: readonly number[], i: number, offset: number): number => {
    if (i >= 0 && i < n) return arr[i]!;
    if (track.loop) {
      const lap = Math.floor(i / m);
      return arr[i - lap * m]! + lap * offset;
    }
    return arr[Math.min(n - 1, Math.max(0, i))]!;
  };
  const grade: number[] = new Array<number>(n);
  const curvature: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = track.loop || i > 0 ? i - 1 : i;
    const hi = track.loop || i < n - 1 ? i + 1 : i;
    const span = (hi - lo) * s;
    grade[i] = span > 0 ? (at(e, hi, 0) - at(e, lo, 0)) / span : 0;
    const k = span > 0 ? (at(h, hi, lapTurn) - at(h, lo, lapTurn)) / span : 0;
    curvature[i] = Math.max(-MAX_CURVATURE, Math.min(MAX_CURVATURE, k));
  }
  const cumAscent = ascentDescent(e).cumulative;
  d = { grade, curvature, cumAscent, lapTurn };
  cache.set(track, d);
  return d;
}

/** Index and fraction for a distance; `lap` counts whole laps on a loop. */
function locate(
  track: RouteTrack,
  distanceM: number,
): { i: number; t: number; lap: number; beyond: boolean } {
  const total = track.totalDistanceM;
  let d = Number.isFinite(distanceM) ? distanceM : 0;
  let lap = 0;
  let beyond = false;
  if (track.loop && total > 0) {
    lap = Math.floor(d / total);
    d -= lap * total;
  } else if (d > total) {
    d = total;
    beyond = distanceM > total;
  } else if (d < 0) d = 0;
  const f = d / track.stepM;
  const i = Math.min(track.count - 2, Math.max(0, Math.floor(f)));
  return { i, t: Math.min(1, Math.max(0, f - i)), lap, beyond };
}

const lerp = (arr: readonly number[], i: number, t: number): number =>
  arr[i]! + (arr[i + 1]! - arr[i]!) * t;

/** Gradient in percent at a distance (0 past the finish of a point-to-point route). */
export function gradeAt(track: RouteTrack, distanceM: number): number {
  const { i, t, beyond } = locate(track, distanceM);
  if (beyond) return 0;
  return lerp(derived(track).grade, i, t) * 100;
}

export function elevationAt(track: RouteTrack, distanceM: number): number {
  const { i, t } = locate(track, distanceM);
  return lerp(track.elevationM, i, t);
}

/** Heading (rad, unwrapped); on a loop it keeps counting turns across laps. */
export function headingAt(track: RouteTrack, distanceM: number): number {
  const { i, t, lap } = locate(track, distanceM);
  return lerp(track.headingRad, i, t) + lap * derived(track).lapTurn;
}

/** Signed curvature in 1/m: positive = the road bends right (heading increases). */
export function curvatureAt(track: RouteTrack, distanceM: number): number {
  const { i, t, beyond } = locate(track, distanceM);
  if (beyond) return 0;
  return lerp(derived(track).curvature, i, t);
}

export interface RoutePoint {
  x: number;
  y: number;
  lat: number;
  lon: number;
  elevationM: number;
  headingRad: number;
}

/** Interpolated point (clamped to the route on point-to-point routes). */
export function pointAt(track: RouteTrack, distanceM: number): RoutePoint {
  const { i, t, lap } = locate(track, distanceM);
  return {
    x: lerp(track.x, i, t),
    y: lerp(track.y, i, t),
    lat: lerp(track.lat, i, t),
    lon: lerp(track.lon, i, t),
    elevationM: lerp(track.elevationM, i, t),
    headingRad: lerp(track.headingRad, i, t) + lap * derived(track).lapTurn,
  };
}

/** Ascent from the start of the route (or lap) up to a distance. */
export function ascentTo(track: RouteTrack, distanceM: number): number {
  const { i, t } = locate(track, distanceM);
  return lerp(derived(track).cumAscent, i, t);
}

/**
 * A point-to-point route cannot be started (or jumped to) closer to the finish than this: the
 * rider should land on the road, not on the finish line.
 */
export const FINISH_MARGIN_M = 100;

/**
 * Where on the route a chosen start or jump target really is (docs/routes.md, "Choosing where to start, and jumping"): on a
 * loop it wraps into 0 … length; on a point-to-point route it is clamped to 0 … length −
 * FINISH_MARGIN_M (or to the middle of a route shorter than twice the margin).
 */
export function normalizeRouteStart(
  track: Pick<RouteTrack, 'totalDistanceM' | 'loop'>,
  distanceM: number,
): number {
  const total = track.totalDistanceM;
  if (!(total > 0)) return 0;
  const d = Number.isFinite(distanceM) ? distanceM : 0;
  if (track.loop) {
    const w = d - Math.floor(d / total) * total;
    return w >= total ? 0 : w;
  }
  const max = Math.max(0, total - Math.min(FINISH_MARGIN_M, total / 2));
  return Math.min(max, Math.max(0, d));
}

/**
 * Routes shared at a coarser resolution get a derived id (`<id>-20m`, see resampleTrack) but
 * keep the original's length and shape: both are the same road. Use this id to compare routes
 * between riders.
 */
export function routeBaseId(id: string): string {
  return id.replace(/-\d+m$/, '');
}

/**
 * Where a rider is on the route: at `offsetM + riddenDistanceM` (`offsetM` = where the ride
 * started on the route, moved by every jump; 0 = from the start). Laps on a loop (a new lap each
 * time the start/finish line is crossed); on a point-to-point route the position stays at the
 * finish (finished = true, flat road) once it is reached.
 */
export function positionAt(track: RouteTrack, riddenDistanceM: number, offsetM = 0): RoutePosition {
  const total = track.totalDistanceM;
  const ridden = Number.isFinite(riddenDistanceM) ? Math.max(0, riddenDistanceM) : 0;
  const along = Math.max(0, ridden + (Number.isFinite(offsetM) ? offsetM : 0));
  let distanceM: number;
  let lap = 1;
  let finished = false;
  if (track.loop) {
    const laps = Math.floor(along / total);
    lap = laps + 1;
    distanceM = along - laps * total;
  } else {
    distanceM = Math.min(along, total);
    finished = along >= total;
  }
  const remainingM = finished ? 0 : Math.max(0, total - distanceM);
  return {
    routeId: track.id,
    name: track.name,
    totalDistanceM: total,
    distanceM,
    lap,
    gradePercent: finished ? 0 : gradeAt(track, distanceM),
    elevationM: elevationAt(track, distanceM),
    remainingM,
    ascentRemainingM: finished ? 0 : Math.max(0, track.ascentM - ascentTo(track, distanceM)),
    finished,
  };
}

export interface Lookahead {
  /** Distance ahead of the rider (m), 0 … lengthM. */
  distanceM: number[];
  /** Elevation relative to the rider (m). */
  elevationDeltaM: number[];
  /** Heading relative to the rider's (rad, + = right). */
  headingDeltaRad: number[];
  /** Curvature at each point (1/m, + = right). */
  curvature: number[];
  /** Position relative to the rider in the rider's frame: forward (m) and right (m). */
  forwardM: number[];
  rightM: number[];
}

/**
 * The road ahead for drawing: `points` evenly spaced samples from the rider (distance) to
 * `lengthM` ahead. Wraps on a loop; flat and straight past the finish of a point-to-point
 * route. `forwardM`/`rightM` integrate the headings, so they follow the route even past the
 * finish (where it continues straight).
 */
export function lookahead(
  track: RouteTrack,
  distanceM: number,
  lengthM: number,
  points: number,
): Lookahead {
  const n = Math.max(2, Math.min(10_000, Math.floor(Number.isFinite(points) ? points : 2)));
  const len = Math.max(0, Number.isFinite(lengthM) ? lengthM : 0);
  const d0 = Number.isFinite(distanceM) ? distanceM : 0;
  const e0 = elevationAt(track, d0);
  const h0 = headingAt(track, d0);
  const out: Lookahead = {
    distanceM: [],
    elevationDeltaM: [],
    headingDeltaRad: [],
    curvature: [],
    forwardM: [],
    rightM: [],
  };
  let fwd = 0;
  let right = 0;
  let prevH = 0;
  const ds = len / (n - 1);
  for (let k = 0; k < n; k++) {
    const d = d0 + k * ds;
    const dh = headingAt(track, d) - h0;
    if (k > 0) {
      const mid = (prevH + dh) / 2;
      fwd += ds * Math.cos(mid);
      right += ds * Math.sin(mid);
    }
    prevH = dh;
    out.distanceM.push(k * ds);
    out.elevationDeltaM.push(elevationAt(track, d) - e0);
    out.headingDeltaRad.push(dh);
    out.curvature.push(curvatureAt(track, d));
    out.forwardM.push(fwd);
    out.rightM.push(right);
  }
  return out;
}

/** Elevation profile with at most maxPoints values, evenly spaced over the whole route. */
export function profile(track: RouteTrack, maxPoints: number): number[] {
  const n = Math.max(2, Math.floor(maxPoints));
  if (track.count <= n) return [...track.elevationM];
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(elevationAt(track, (track.totalDistanceM * k) / (n - 1)));
  return out;
}

/**
 * Outline (x/y) with at most maxPoints points, by Douglas–Peucker with a tolerance searched
 * so that the result just fits: keeps corners where uniform sampling would cut them.
 */
export function outline(track: RouteTrack, maxPoints: number): [number, number][] {
  const n = Math.max(2, Math.floor(maxPoints));
  const pts: [number, number][] = track.x.map((x, i) => [x, track.y[i]!]);
  if (pts.length <= n) return pts;
  const extent = Math.max(
    1,
    Math.max(...track.x) - Math.min(...track.x),
    Math.max(...track.y) - Math.min(...track.y),
  );
  let lo = 0;
  let hi = extent;
  let best = uniform(pts, n);
  for (let iter = 0; iter < 30; iter++) {
    const tol = (lo + hi) / 2;
    const keep = douglasPeucker(pts, tol);
    if (keep.length <= n) {
      best = keep;
      hi = tol;
    } else lo = tol;
  }
  return best;
}

function uniform(pts: [number, number][], n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) out.push(pts[Math.round((k * (pts.length - 1)) / (n - 1))]!);
  return out;
}

function douglasPeucker(pts: [number, number][], tol: number): [number, number][] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      let d: number;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      }
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}
