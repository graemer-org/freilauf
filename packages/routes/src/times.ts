/**
 * When a recorded ride passed each place of its route: kept (compactly) with an imported GPX
 * that has `<time>` on its points, so the weather of that day can be loaded for the times the
 * ride really was there (docs/adr/0012-historical-wind.md). Pure.
 */

/** Recorded passage times along a route. */
export interface RouteTimes {
  /** When the ride started (ms since 1970, UTC). */
  startMs: number;
  /** Distance between two entries of `offsetsS` (m). */
  stepM: number;
  /** Seconds after the start at 0, stepM, 2·stepM, … and (last) at totalM, the route's end. */
  offsetsS: number[];
  totalM: number;
}

/** Entries kept at most (a coarse profile is plenty for hourly weather). */
export const MAX_ROUTE_TIMES = 200;
/** Finest spacing kept (m). */
export const MIN_ROUTE_TIMES_STEP_M = 500;
/** A recording shorter than this, or longer than MAX_RIDE_SPAN_MS, has no usable times. */
export const MIN_RIDE_SPAN_MS = 60_000;
export const MAX_RIDE_SPAN_MS = 14 * 24 * 3600 * 1000;

/**
 * Passage times at route distances from (distance, time) pairs of the original points (in
 * route order). Times are forced to run forward. Null when too few points have a time (under
 * half of them, or fewer than two) or the span is implausible.
 */
export function routeTimesFrom(
  pairs: readonly { distM: number; timeMs: number }[],
  totalPoints: number,
  totalDistanceM: number,
): RouteTimes | null {
  if (pairs.length < 2 || pairs.length < totalPoints / 2 || !(totalDistanceM > 0)) return null;
  const dist: number[] = [];
  const time: number[] = [];
  let maxT = -Infinity;
  for (const p of pairs) {
    if (!Number.isFinite(p.distM) || !Number.isFinite(p.timeMs)) continue;
    maxT = Math.max(maxT, p.timeMs);
    const d = dist.length > 0 ? Math.max(dist[dist.length - 1]!, p.distM) : p.distM;
    dist.push(d);
    time.push(maxT);
  }
  if (dist.length < 2) return null;
  const startMs = time[0]!;
  const span = time[time.length - 1]! - startMs;
  if (span < MIN_RIDE_SPAN_MS || span > MAX_RIDE_SPAN_MS) return null;
  const scale = dist[dist.length - 1]! > 0 ? totalDistanceM / dist[dist.length - 1]! : 1;
  const stepM = Math.max(MIN_ROUTE_TIMES_STEP_M, totalDistanceM / (MAX_ROUTE_TIMES - 2));
  const offsetsS: number[] = [];
  let j = 0;
  const at = (d: number): number => {
    while (j < dist.length - 2 && dist[j + 1]! * scale < d) j++;
    const d0 = dist[j]! * scale;
    const d1 = dist[j + 1]! * scale;
    const f = d1 > d0 ? Math.min(1, Math.max(0, (d - d0) / (d1 - d0))) : 1;
    return time[j]! + f * (time[j + 1]! - time[j]!);
  };
  for (let k = 0; k * stepM < totalDistanceM - 1e-6; k++) {
    offsetsS.push(Math.round((at(k * stepM) - startMs) / 1000));
  }
  offsetsS.push(Math.round((at(totalDistanceM) - startMs) / 1000));
  return { startMs: Math.round(startMs), stepM, offsetsS, totalM: totalDistanceM };
}

/** When the recorded ride passed route distance `alongM` (ms, UTC); clamped to the route. */
export function routeTimeAt(t: RouteTimes, alongM: number): number {
  const n = t.offsetsS.length;
  if (n === 0) return t.startMs;
  const d = Math.min(Math.max(0, alongM), t.totalM);
  const i = Math.min(n - 2, Math.floor(d / t.stepM));
  const d0 = i * t.stepM;
  // The last entry is at the route's end, which may be less than a full step on.
  const d1 = i + 1 === n - 1 ? t.totalM : (i + 1) * t.stepM;
  const f = d1 > d0 ? Math.min(1, (d - d0) / (d1 - d0)) : 1;
  return t.startMs + (t.offsetsS[i]! + f * (t.offsetsS[i + 1]! - t.offsetsS[i]!)) * 1000;
}

/** Start and end of the recording (ms, UTC). */
export function routeTimesSpan(t: RouteTimes): { startMs: number; endMs: number } {
  return { startMs: t.startMs, endMs: t.startMs + (t.offsetsS.at(-1) ?? 0) * 1000 };
}

/** Validates stored times (untrusted); null when unusable. */
export function decodeRouteTimes(raw: unknown): RouteTimes | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { startMs, stepM, offsetsS, totalM } = r;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return null;
  if (typeof totalM !== 'number' || !(totalM > 0) || totalM > 1e7) return null;
  if (typeof stepM !== 'number' || !(stepM >= 1) || stepM > 1e6) return null;
  if (!Array.isArray(offsetsS) || offsetsS.length < 2 || offsetsS.length > MAX_ROUTE_TIMES + 2)
    return null;
  let prev = -1;
  for (const o of offsetsS) {
    if (typeof o !== 'number' || !Number.isFinite(o) || o < prev || o > MAX_RIDE_SPAN_MS / 1000)
      return null;
    prev = o;
  }
  return { startMs, stepM, offsetsS: offsetsS as number[], totalM };
}
