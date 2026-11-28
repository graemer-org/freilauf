/**
 * Route preparation: clean the raw points, resample at a fixed step, smooth the elevation into
 * rideable gradients, compute headings, ascent and loop. Deterministic and pure. The parameters
 * and why they were chosen are in docs/adr/0004-routes.md.
 */
import type { RawPoint, RawTrack } from './gpx';
import { cleanText, fnv1a, haversineM, project } from './geo';
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from './gpx';
import type { RouteTrack } from './types';
import { routeTimesFrom, type RouteTimes } from './times';

export const DEFAULT_STEP_M = 10;
/** Samples per track at most; longer routes get a larger step (200 km at 10 m). */
export const MAX_TRACK_SAMPLES = 20_000;
export const MIN_ROUTE_LENGTH_M = 100;
export const MAX_ROUTE_LENGTH_M = 1_000_000;
/** End within this of the start (and long enough): ridden as laps. */
export const LOOP_MAX_GAP_M = 50;
export const LOOP_MIN_LENGTH_M = 500;

export interface SmoothingOptions {
  /** Median filter span (m): removes elevation spikes shorter than about half of it. */
  medianSpanM: number;
  /** Gaussian smoothing of the elevation, standard deviation in metres of distance. */
  sigmaM: number;
  /** Gradients beyond ± this (percent) are cut (only ever noise on a road). */
  maxGradePercent: number;
  /** The gradient may change by at most this many percentage points per metre. */
  maxGradeChangePerM: number;
  /** Gaussian smoothing of the heading (m), before the curvature is taken from it. */
  headingSigmaM: number;
}

/**
 * Defaults, tuned on noisy synthetic climbs (tests) and a real 98 km out-and-back planner export with
 * point spacing from under 1 m to 470 m (packages/routes/fixtures). See docs/adr/0004-routes.md.
 */
export const DEFAULT_SMOOTHING: Readonly<SmoothingOptions> = {
  medianSpanM: 50,
  sigmaM: 40,
  maxGradePercent: 25,
  maxGradeChangePerM: 0.15,
  headingSigmaM: 10,
};

export interface BuildOptions {
  /** Nominal sample spacing (default 10 m); grows for long routes so count ≤ maxSamples. */
  stepM?: number;
  maxSamples?: number;
  smoothing?: Partial<SmoothingOptions>;
  /** Overrides the content-derived id (built-in routes). */
  id?: string;
  name?: string;
  description?: string;
}

export interface BuildStats {
  inputPoints: number;
  duplicatesDropped: number;
  spikesDropped: number;
  /** Straight-line gaps longer than 1 km between consecutive points. */
  longGaps: number;
  /** Ascent / descent summed over the raw points' elevation (what noise makes of it). */
  rawAscentM: number;
  rawDescentM: number;
  /** Loop routes: elevation difference between end and start that was spread over the lap. */
  loopDriftM: number;
}

export type PrepareResult =
  | {
      ok: true;
      track: RouteTrack;
      stats: BuildStats;
      warnings: string[];
      /** When a recorded ride passed each place (GPX with `<time>`); absent otherwise. */
      times?: RouteTimes;
    }
  | { ok: false; errors: string[] };

/** Out-and-back excursions longer than this (and 10× the median spacing) are GPS spikes. */
const SPIKE_MIN_M = 200;
const DUPLICATE_M = 0.5;
const LONG_GAP_M = 1_000;

/** Prepares a route; never throws. */
export function prepareRoute(raw: RawTrack, options: BuildOptions = {}): PrepareResult {
  try {
    return prepare(raw, options);
  } catch (e) {
    return { ok: false, errors: [`The route could not be prepared (${String(e)}).`] };
  }
}

/** Like prepareRoute, but throws a RangeError for an unusable track. */
export function buildRoute(raw: RawTrack, options: BuildOptions = {}): RouteTrack {
  const r = prepareRoute(raw, options);
  if (!r.ok) throw new RangeError(r.errors.join(' '));
  return r.track;
}

function prepare(raw: RawTrack, options: BuildOptions): PrepareResult {
  const smoothing = { ...DEFAULT_SMOOTHING, ...options.smoothing };
  const warnings: string[] = [];
  const input = raw.points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.ele),
  );
  const stats: BuildStats = {
    inputPoints: raw.points.length,
    duplicatesDropped: 0,
    spikesDropped: 0,
    longGaps: 0,
    rawAscentM: 0,
    rawDescentM: 0,
    loopDriftM: 0,
  };

  // 1. Duplicates and stationary points.
  const dedup: RawPoint[] = [];
  for (const p of input) {
    const last = dedup[dedup.length - 1];
    if (last && haversineM(last.lat, last.lon, p.lat, p.lon) < DUPLICATE_M) {
      stats.duplicatesDropped++;
      continue;
    }
    dedup.push(p);
  }
  if (dedup.length < 2) return { ok: false, errors: ['The route needs at least two points.'] };

  // 2. GPS spikes: a single point far off that the track immediately returns from. Speed-free;
  //    the threshold scales with the file's typical spacing so a planner's sparse turnaround
  //    point is not mistaken for one.
  const spacing: number[] = [];
  for (let i = 1; i < dedup.length; i++) {
    const a = dedup[i - 1]!;
    const b = dedup[i]!;
    spacing.push(haversineM(a.lat, a.lon, b.lat, b.lon));
  }
  const median = [...spacing].sort((a, b) => a - b)[Math.floor(spacing.length / 2)] ?? 0;
  const spikeM = Math.max(SPIKE_MIN_M, 10 * median);
  const points: RawPoint[] = [dedup[0]!];
  for (let i = 1; i < dedup.length - 1; i++) {
    const a = points[points.length - 1]!;
    const p = dedup[i]!;
    const b = dedup[i + 1]!;
    const out = haversineM(a.lat, a.lon, p.lat, p.lon);
    const back = haversineM(p.lat, p.lon, b.lat, b.lon);
    const direct = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (Math.min(out, back) > spikeM && direct < 0.25 * Math.min(out, back)) {
      stats.spikesDropped++;
      continue;
    }
    points.push(p);
  }
  points.push(dedup[dedup.length - 1]!);
  if (stats.spikesDropped > 0) {
    warnings.push(`${stats.spikesDropped} GPS spikes (points far off the track) were removed.`);
  }

  // 3. Distance along the points.
  const dist: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (d > LONG_GAP_M) stats.longGaps++;
    dist.push(dist[i - 1]! + d);
    const de = b.ele - a.ele;
    if (de > 0) stats.rawAscentM += de;
    else stats.rawDescentM -= de;
  }
  if (stats.longGaps > 0) {
    warnings.push(
      `${stats.longGaps} gaps longer than 1 km between points were bridged with straight lines.`,
    );
  }
  // Recorded times (before the loop is closed: the closing point has no time of its own).
  const timed: { distM: number; timeMs: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const t = points[i]!.timeMs;
    if (t !== undefined) timed.push({ distM: dist[i]!, timeMs: t });
  }
  const timedOf = points.length;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let total = dist[dist.length - 1]!;
  const gap = haversineM(first.lat, first.lon, last.lat, last.lon);
  const loop = gap <= LOOP_MAX_GAP_M && total > LOOP_MIN_LENGTH_M;
  if (loop && gap > DUPLICATE_M) {
    // Close the loop so the last sample is the first one again.
    points.push({ ...first, ele: last.ele });
    total += gap;
    dist.push(total);
  }
  if (total < MIN_ROUTE_LENGTH_M) {
    return { ok: false, errors: [`The route is shorter than ${MIN_ROUTE_LENGTH_M} m.`] };
  }
  if (total > MAX_ROUTE_LENGTH_M) {
    return { ok: false, errors: [`The route is longer than ${MAX_ROUTE_LENGTH_M / 1000} km.`] };
  }
  if (loop) {
    // Barometric drift: the end of a loop should be as high as its start. Spread the
    // difference over the lap instead of leaving a step at the finish line.
    const drift = points[points.length - 1]!.ele - first.ele;
    stats.loopDriftM = drift;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      points[i] = { ...p, ele: p.ele - (drift * dist[i]!) / total };
    }
  }

  // 4. Step: the nominal one, larger if needed to stay within maxSamples; then adjusted so
  //    that (count − 1) × step is exactly the route length.
  const maxSamples = Math.max(2, Math.floor(options.maxSamples ?? MAX_TRACK_SAMPLES));
  let nominal = Math.max(1, options.stepM ?? DEFAULT_STEP_M);
  if (total / nominal + 1 > maxSamples) nominal = Math.ceil(total / (maxSamples - 1));
  const intervals = Math.max(1, Math.round(total / nominal));
  const stepM = total / intervals;
  const count = intervals + 1;

  // 5. Resample (linear between points: lat/lon, projected x/y and elevation).
  const proj = { lat0: first.lat, lon0: first.lon };
  const lat: number[] = new Array<number>(count);
  const lon: number[] = new Array<number>(count);
  const x: number[] = new Array<number>(count);
  const y: number[] = new Array<number>(count);
  const rawEle: number[] = new Array<number>(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const d = i === count - 1 ? total : i * stepM;
    while (j < points.length - 2 && dist[j + 1]! < d) j++;
    const a = points[j]!;
    const b = points[j + 1]!;
    const span = dist[j + 1]! - dist[j]!;
    const t = span > 0 ? Math.min(1, Math.max(0, (d - dist[j]!) / span)) : 0;
    lat[i] = a.lat + (b.lat - a.lat) * t;
    lon[i] = a.lon + (b.lon - a.lon) * t;
    rawEle[i] = a.ele + (b.ele - a.ele) * t;
    const pt = project(proj, lat[i]!, lon[i]!);
    x[i] = pt.x;
    y[i] = pt.y;
  }
  if (loop) {
    lat[count - 1] = lat[0]!;
    lon[count - 1] = lon[0]!;
    x[count - 1] = x[0]!;
    y[count - 1] = y[0]!;
  }

  // 6. Elevation and heading.
  const elevationM = raw.hasElevation
    ? smoothElevation(cellMeans(points, dist, count, stepM, rawEle), stepM, loop, smoothing)
    : new Array<number>(count).fill(0);
  const headingRad = computeHeadings(x, y, stepM, loop, smoothing.headingSigmaM);
  const { ascentM, descentM } = ascentDescent(elevationM);

  const name = cleanText(options.name ?? raw.name, MAX_NAME_LENGTH) || 'Route';
  const description = cleanText(
    options.description ?? raw.description ?? '',
    MAX_DESCRIPTION_LENGTH,
  );
  const track: RouteTrack = {
    id: '',
    name,
    ...(description ? { description } : {}),
    stepM,
    count,
    totalDistanceM: (count - 1) * stepM,
    elevationM,
    x,
    y,
    headingRad,
    lat,
    lon,
    ascentM,
    descentM,
    loop,
  };
  track.id = options.id ?? routeId(track);
  const times = routeTimesFrom(timed, timedOf, track.totalDistanceM);
  return { ok: true, track, stats, warnings, ...(times ? { times } : {}) };
}

/**
 * Mean elevation of the piecewise-linear raw profile over each sample's cell (± step/2),
 * integrated exactly. Unlike picking the value at the sample, this uses every raw point —
 * dense, noisy recordings average out instead of aliasing — and weighs unevenly spaced
 * points by the distance they cover.
 */
function cellMeans(
  points: readonly RawPoint[],
  dist: readonly number[],
  count: number,
  stepM: number,
  fallback: readonly number[],
): number[] {
  const area: number[] = [0];
  for (let j = 1; j < points.length; j++) {
    area.push(
      area[j - 1]! + ((points[j - 1]!.ele + points[j]!.ele) / 2) * (dist[j]! - dist[j - 1]!),
    );
  }
  const total = dist[dist.length - 1]!;
  let j = 0;
  const areaAt = (d: number): number => {
    while (j > 0 && dist[j]! > d) j--;
    while (j < points.length - 2 && dist[j + 1]! < d) j++;
    const span = dist[j + 1]! - dist[j]!;
    const t = Math.max(0, Math.min(span, d - dist[j]!));
    const e0 = points[j]!.ele;
    const slope = span > 0 ? (points[j + 1]!.ele - e0) / span : 0;
    return area[j]! + t * e0 + 0.5 * t * t * slope;
  };
  const out: number[] = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i * stepM - stepM / 2);
    const b = Math.min(total, i * stepM + stepM / 2);
    const lo = areaAt(a);
    const hi = areaAt(b);
    out[i] = b - a > 1e-9 ? (hi - lo) / (b - a) : fallback[i]!;
  }
  return out;
}

/** Climbing and descending are only counted once the road has risen/fallen this much (m). */
export const ASCENT_THRESHOLD_M = 1;

/**
 * Ascent and descent of a profile with a small dead band (ASCENT_THRESHOLD_M), the usual way
 * to keep residual ripples from adding up. `cumulative[i]` is the ascent up to sample i.
 */
export function ascentDescent(
  elevationM: readonly number[],
  thresholdM: number = ASCENT_THRESHOLD_M,
): { ascentM: number; descentM: number; cumulative: number[] } {
  let ascentM = 0;
  let descentM = 0;
  const cumulative: number[] = [];
  let ref = elevationM[0] ?? 0;
  for (const e of elevationM) {
    if (e - ref >= thresholdM) {
      ascentM += e - ref;
      ref = e;
    } else if (ref - e >= thresholdM) {
      descentM += ref - e;
      ref = e;
    }
    cumulative.push(ascentM);
  }
  return { ascentM, descentM, cumulative };
}

/** Stable id from the content: same samples (to 0.1 m / 1e-6°), same id. */
export function routeId(
  track: Pick<RouteTrack, 'count' | 'stepM' | 'lat' | 'lon' | 'elevationM'>,
): string {
  const parts: string[] = [`${track.count}|${track.stepM.toFixed(3)}`];
  const every = Math.max(1, Math.floor(track.count / 2000));
  for (let i = 0; i < track.count; i += every) {
    parts.push(
      `${Math.round(track.lat[i]! * 1e6)},${Math.round(track.lon[i]! * 1e6)},${Math.round(track.elevationM[i]! * 10)}`,
    );
  }
  const s = parts.join(';');
  return `route-${fnv1a(s)}${fnv1a(s.split('').reverse().join(''))}`;
}

/**
 * Gaussian smoothing of evenly spaced values. Out-of-range neighbours: on a loop the values
 * continue periodically (plus `lapOffset` per lap, for unwrapped headings); otherwise they are
 * mirrored through the end point (odd reflection), which keeps a straight trend straight to
 * the very end instead of flattening it.
 */
export function gaussianSmooth(
  values: readonly number[],
  sigmaSamples: number,
  loop: boolean,
  lapOffset = 0,
): number[] {
  const n = values.length;
  if (n < 3 || sigmaSamples <= 0.3) return [...values];
  const radius = Math.ceil(3 * sigmaSamples);
  const weights: number[] = [];
  for (let k = -radius; k <= radius; k++)
    weights.push(Math.exp(-(k * k) / (2 * sigmaSamples ** 2)));
  const norm = weights.reduce((a, b) => a + b, 0);
  const m = loop ? n - 1 : n; // a loop's last sample repeats the first
  const at = (i: number): number => {
    if (i >= 0 && i < n) return values[i]!;
    if (loop) {
      const lap = Math.floor(i / m);
      return values[i - lap * m]! + lap * lapOffset;
    }
    if (i < 0) return 2 * values[0]! - values[Math.min(n - 1, -i)]!;
    return 2 * values[n - 1]! - values[Math.max(0, 2 * (n - 1) - i)]!;
  };
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += weights[k + radius]! * at(i + k);
    out[i] = s / norm;
  }
  if (loop) out[n - 1] = out[0]! + lapOffset;
  return out;
}

function median(values: readonly number[], span: number, loop: boolean): number[] {
  const n = values.length;
  const half = Math.floor(span / 2);
  if (half < 1 || n < 3) return [...values];
  const m = loop ? n - 1 : n;
  const out = new Array<number>(n);
  const window: number[] = [];
  for (let i = 0; i < n; i++) {
    window.length = 0;
    for (let k = -half; k <= half; k++) {
      let idx = i + k;
      if (loop) idx = ((idx % m) + m) % m;
      else idx = Math.min(n - 1, Math.max(0, idx));
      window.push(values[idx]!);
    }
    window.sort((a, b) => a - b);
    out[i] = window[half]!;
  }
  if (loop) out[n - 1] = out[0]!;
  return out;
}

/**
 * Raw resampled elevation → rideable profile: median (spikes) → Gaussian (noise) → gradient
 * cap → limit on how fast the gradient may change → re-integrated, with the start/end
 * elevations of the Gaussian profile kept (drift spread linearly).
 */
export function smoothElevation(
  raw: readonly number[],
  stepM: number,
  loop: boolean,
  options: SmoothingOptions = DEFAULT_SMOOTHING,
): number[] {
  const n = raw.length;
  if (n < 2) return [...raw];
  const medSpan = Math.max(3, 2 * Math.floor(options.medianSpanM / stepM / 2) + 1);
  const med = median(raw, medSpan, loop);
  const smooth = gaussianSmooth(med, options.sigmaM / stepM, loop);

  const maxG = options.maxGradePercent / 100;
  const g: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    g.push(Math.max(-maxG, Math.min(maxG, (smooth[i + 1]! - smooth[i]!) / stepM)));
  }
  const rate = (options.maxGradeChangePerM / 100) * stepM;
  const limit = (seq: number[], forward: boolean): number[] => {
    const out = [...seq];
    const order = forward ? out.keys() : [...out.keys()].reverse();
    let prev: number | null = null;
    for (const i of order) {
      if (prev !== null) out[i] = Math.max(prev - rate, Math.min(prev + rate, out[i]!));
      prev = out[i]!;
    }
    return out;
  };
  const a = limit(limit(g, true), false);
  const b = limit(limit(g, false), true);
  const grades = a.map((v, i) => (v + b[i]!) / 2);

  const out = new Array<number>(n);
  out[0] = smooth[0]!;
  for (let i = 1; i < n; i++) out[i] = out[i - 1]! + grades[i - 1]! * stepM;
  // The rate limit moves height around; give back what it moved (spread linearly). What the
  // gradient cap removed stays removed, except on a loop, which must close.
  let target = smooth[0]!;
  if (loop) target = smooth[n - 1]!;
  else for (let i = 0; i < n - 1; i++) target += g[i]! * stepM;
  const drift = out[n - 1]! - target;
  for (let i = 1; i < n; i++) out[i] = out[i]! - (drift * i) / (n - 1);
  if (loop) out[n - 1] = out[0]!;
  return out;
}

/** Direction of travel (0 = north, clockwise), unwrapped and lightly smoothed. */
export function computeHeadings(
  x: readonly number[],
  y: readonly number[],
  stepM: number,
  loop: boolean,
  sigmaM: number = DEFAULT_SMOOTHING.headingSigmaM,
): number[] {
  const n = x.length;
  const m = loop ? n - 1 : n;
  const raw: number[] = new Array<number>(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let a: number;
    let b: number;
    if (loop) {
      a = (i - 1 + m) % m;
      b = (i + 1) % m;
    } else {
      a = Math.max(0, i - 1);
      b = Math.min(n - 1, i + 1);
    }
    const dx = x[b]! - x[a]!;
    const dy = y[b]! - y[a]!;
    let h = Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dx, dy) : prev;
    if (i > 0) {
      while (h - prev > Math.PI) h -= 2 * Math.PI;
      while (h - prev < -Math.PI) h += 2 * Math.PI;
    }
    raw[i] = h;
    prev = h;
  }
  let lapTurn = 0;
  if (loop) {
    // Net turn over a lap is a whole number of turns; make the closing sample consistent.
    lapTurn = Math.round((raw[n - 1]! - raw[0]!) / (2 * Math.PI)) * 2 * Math.PI;
    raw[n - 1] = raw[0]! + lapTurn;
  }
  return gaussianSmooth(raw, sigmaM / stepM, loop, lapTurn);
}

/**
 * The same route at another (normally coarser) step: positions, lat/lon and elevation are
 * interpolated linearly, headings and ascent recomputed. Keeps the id when the step is
 * unchanged, otherwise derives one (`<id>-<step>m`) so both versions can coexist.
 */
export function resampleTrack(track: RouteTrack, nominalStepM: number): RouteTrack {
  const total = track.totalDistanceM;
  const intervals = Math.max(1, Math.round(total / Math.max(1, nominalStepM)));
  const stepM = total / intervals;
  if (intervals === track.count - 1) return track;
  const count = intervals + 1;
  const pick = (arr: readonly number[]): number[] => {
    const out = new Array<number>(count);
    for (let k = 0; k < count; k++) {
      const f = (k * stepM) / track.stepM;
      const i = Math.min(track.count - 2, Math.floor(f));
      const t = Math.min(1, Math.max(0, f - i));
      out[k] = arr[i]! + (arr[i + 1]! - arr[i]!) * t;
    }
    out[count - 1] = arr[track.count - 1]!;
    return out;
  };
  const x = pick(track.x);
  const y = pick(track.y);
  const elevationM = pick(track.elevationM);
  const { ascentM, descentM } = ascentDescent(elevationM);
  const base = track.id.replace(/-\d+m$/, '');
  return {
    ...track,
    id: `${base}-${Math.round(stepM)}m`.slice(0, 64),
    stepM,
    count,
    totalDistanceM: (count - 1) * stepM,
    elevationM,
    x,
    y,
    lat: pick(track.lat),
    lon: pick(track.lon),
    headingRad: computeHeadings(x, y, stepM, track.loop),
    ascentM,
    descentM,
  };
}
