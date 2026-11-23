/**
 * Reading a `RouteTrack` at any distance: elevation, heading, position and
 * gradient, linearly interpolated between the resampled points
 * (index = distance / stepM). Kept local to the scene on purpose, so the
 * renderer has no dependency on the route engine's helper names.
 *
 * Distances outside the route: on a loop they wrap; otherwise the route is
 * extended straight and level beyond either end (so the road ahead of the
 * finish is drawn, flat, instead of ending in the air).
 */
import type { RouteTrack } from '@freilauf/routes';

export interface TrackPoint {
  elevationM: number;
  /** Radians, 0 = north, clockwise, unwrapped (continuous along the route). */
  headingRad: number;
  /** Local metres east / north. */
  x: number;
  y: number;
}

export function createTrackPoint(): TrackPoint {
  return { elevationM: 0, headingRad: 0, x: 0, y: 0 };
}

/**
 * Unwrapped heading gained per lap on a loop (≈ ±2π), so that heading stays
 * continuous when the distance wraps from one lap into the next.
 */
export function lapTurn(track: RouteTrack): number {
  const h = track.headingRad;
  if (!track.loop || h.length < 2) return 0;
  const turns = Math.round((h[h.length - 1]! - h[0]!) / (2 * Math.PI));
  return turns * 2 * Math.PI;
}

/** Fills `out` with the track at `distanceM` (any value; see the module note). */
export function sampleTrack(track: RouteTrack, distanceM: number, out: TrackPoint): TrackPoint {
  const n = Math.min(
    track.count,
    track.elevationM.length,
    track.headingRad.length,
    track.x.length,
    track.y.length,
  );
  if (n === 0 || !(track.stepM > 0)) {
    out.elevationM = 0;
    out.headingRad = 0;
    out.x = 0;
    out.y = 0;
    return out;
  }
  const total = (n - 1) * track.stepM;
  let d = Number.isFinite(distanceM) ? distanceM : 0;
  let headingOffset = 0;
  if (track.loop && total > 0) {
    const lap = Math.floor(d / total);
    d -= lap * total;
    headingOffset = lap * lapTurn(track);
  }
  let extra = 0;
  if (d < 0) {
    extra = d;
    d = 0;
  } else if (d > total) {
    extra = d - total;
    d = total;
  }
  const f = d / track.stepM;
  const i = Math.min(n - 2, Math.max(0, Math.floor(f)));
  const t = n === 1 ? 0 : Math.min(1, Math.max(0, f - i));
  const j = Math.min(n - 1, i + 1);
  const lerp = (a: number[]): number => a[i]! + (a[j]! - a[i]!) * t;
  out.elevationM = lerp(track.elevationM);
  out.headingRad = lerp(track.headingRad) + headingOffset;
  out.x = lerp(track.x);
  out.y = lerp(track.y);
  if (extra !== 0) {
    out.x += Math.sin(out.headingRad) * extra;
    out.y += Math.cos(out.headingRad) * extra;
  }
  return out;
}

const scratchA = createTrackPoint();
const scratchB = createTrackPoint();

/** Elevation at a distance, metres. */
export function elevationAt(track: RouteTrack, distanceM: number): number {
  return sampleTrack(track, distanceM, scratchA).elevationM;
}

/** Heading at a distance, radians (unwrapped). */
export function headingAt(track: RouteTrack, distanceM: number): number {
  return sampleTrack(track, distanceM, scratchA).headingRad;
}

/** Mean gradient in percent over [distanceM, distanceM + spanM]. */
export function gradeAt(track: RouteTrack, distanceM: number, spanM = 10): number {
  const span = Math.max(0.5, spanM);
  const a = sampleTrack(track, distanceM, scratchA).elevationM;
  const b = sampleTrack(track, distanceM + span, scratchB).elevationM;
  return ((b - a) / span) * 100;
}

/** Heading change in radians over [distanceM, distanceM + spanM]; + = turning right. */
export function turnAhead(track: RouteTrack, distanceM: number, spanM: number): number {
  const a = sampleTrack(track, distanceM, scratchA).headingRad;
  const b = sampleTrack(track, distanceM + spanM, scratchB).headingRad;
  return b - a;
}

/** Curvature in rad/m around a distance (+ = bending right), from a ±spanM/2 window. */
export function curvatureAt(track: RouteTrack, distanceM: number, spanM = 20): number {
  const s = Math.max(1, spanM);
  return turnAhead(track, distanceM - s / 2, s) / s;
}

/**
 * Mean of `value` over [from, to] using `steps` midpoint samples. Used for
 * the camera, so it follows the road smoothly and deterministically.
 */
export function meanOver(
  track: RouteTrack,
  from: number,
  to: number,
  steps: number,
  value: (p: TrackPoint) => number,
): number {
  const k = Math.max(1, Math.round(steps));
  let sum = 0;
  for (let i = 0; i < k; i++) {
    sum += value(sampleTrack(track, from + ((i + 0.5) * (to - from)) / k, scratchA));
  }
  return sum / k;
}

/** Wraps a distance into [0, total) on a loop; clamps it otherwise. */
export function routeDistance(track: RouteTrack, distanceM: number): number {
  const total = Math.max(0, (track.count - 1) * track.stepM);
  if (!Number.isFinite(distanceM) || total <= 0) return 0;
  if (track.loop) {
    const d = distanceM % total;
    return d < 0 ? d + total : d;
  }
  return Math.min(total, Math.max(0, distanceM));
}

export interface GradeSign {
  /** Route distance where the new gradient starts, metres. */
  atM: number;
  /** The new gradient, percent (mean over the 100 m after the sign). */
  gradePercent: number;
}

/**
 * Where the gradient clearly changes, for the roadside signs: points on a
 * 25 m grid of route distance where the mean gradient of the next 100 m
 * differs from that of the previous 100 m by at least `minDelta` points and
 * is itself at least `minGrade` steep (or the road levels off after a climb
 * or descent of that size). Strongest change wins within `spacingM`.
 * Depends on the track only, so the signs stand still in the world.
 */
export function gradeSigns(
  track: RouteTrack,
  minDelta = 3,
  minGrade = 3,
  spacingM = 300,
): GradeSign[] {
  const grid = 25;
  const win = 100;
  const total = (track.count - 1) * track.stepM;
  const found: { atM: number; gradePercent: number; delta: number }[] = [];
  for (let s = win; s + win <= total; s += grid) {
    const before = gradeAt(track, s - win, win);
    const after = gradeAt(track, s, win);
    const delta = Math.abs(after - before);
    if (delta < minDelta) continue;
    if (Math.abs(after) < minGrade && Math.abs(before) < minGrade) continue;
    const last = found[found.length - 1];
    if (last && s - last.atM < spacingM) {
      if (delta > last.delta) found[found.length - 1] = { atM: s, gradePercent: after, delta };
      continue;
    }
    found.push({ atM: s, gradePercent: after, delta });
  }
  return found.map(({ atM, gradePercent }) => ({ atM, gradePercent }));
}

/**
 * The next sign within `rangeM` ahead of the rider (route distance, wrapping
 * on a loop); `inM` is how far ahead it stands.
 */
export function nextSign(
  track: RouteTrack,
  signs: readonly GradeSign[],
  distanceM: number,
  rangeM = 500,
): (GradeSign & { inM: number }) | null {
  if (signs.length === 0) return null;
  const total = (track.count - 1) * track.stepM;
  const d = routeDistance(track, distanceM);
  for (const s of signs) {
    if (s.atM > d && s.atM - d <= rangeM) return { ...s, inM: s.atM - d };
  }
  if (track.loop && total > 0) {
    const first = signs[0]!;
    const inM = first.atM + total - d;
    if (inM <= rangeM) return { ...first, inM };
  }
  return null;
}
