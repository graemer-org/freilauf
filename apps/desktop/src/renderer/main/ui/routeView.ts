/**
 * Pure helpers behind the route UI: SVG geometry for profiles and outlines,
 * the gradient classes of the profile ahead, and the words. No React, no
 * DOM — unit-tested directly.
 */
import type { RouteTrack } from '@freilauf/routes';
import { createTrackPoint, routeDistance, sampleTrack } from './scene/routeSample';

const MINUS = '−';

// ───────────── words ─────────────

/** `12.4 km`, `850 m` below one kilometre. */
export function formatKm(m: number): string {
  if (!Number.isFinite(m)) return '–';
  const v = Math.max(0, m);
  if (v < 1000) return `${Math.round(v / 10) * 10} m`;
  return `${(v / 1000).toFixed(v < 100_000 ? 1 : 0)} km`;
}

/** Whole metres of climbing: `↑ 520 m`. */
export const formatClimb = (m: number): string =>
  `${Math.round(Math.max(0, Number.isFinite(m) ? m : 0))} m`;

/** A gradient with sign and one decimal: `+4.5 %`, `−2.0 %`. */
export function formatGradient(g: number): string {
  if (!Number.isFinite(g)) return '–';
  const r = Math.round(g * 10) / 10;
  const sign = r > 0 ? '+' : r < 0 ? MINUS : '';
  return `${sign}${Math.abs(r).toFixed(1)} %`;
}

/** One line for a route card: distance, climbing, descending, kind. */
export function routeSummary(e: {
  totalDistanceM: number;
  ascentM: number;
  descentM: number;
  loop: boolean;
}): string {
  return `${formatKm(e.totalDistanceM)} · ↑ ${formatClimb(e.ascentM)} · ↓ ${formatClimb(e.descentM)} · ${e.loop ? 'Loop' : 'Point to point'}`;
}

/** Accessible description of a route's profile and shape. */
export function routeImageLabel(e: {
  name: string;
  totalDistanceM: number;
  ascentM: number;
  descentM: number;
  loop: boolean;
}): string {
  return `${e.name}: ${e.loop ? 'loop' : 'point-to-point route'} of ${formatKm(e.totalDistanceM)}, ${formatClimb(e.ascentM)} of climbing and ${formatClimb(e.descentM)} of descending.`;
}

// ───────────── gradient classes ─────────────

/**
 * Gradient bands for colouring the profile, from descending to very steep.
 * Each band has its own hue and lightness (see --grade-* in main.css), and
 * the slope of the profile itself carries the same information.
 */
export const GRADE_BANDS = [
  { id: 'down', label: 'Descent', max: -2 },
  { id: 'flat', label: 'Flat', max: 2 },
  { id: 'gentle', label: '2–5 %', max: 5 },
  { id: 'moderate', label: '5–8 %', max: 8 },
  { id: 'steep', label: '8–11 %', max: 11 },
  { id: 'wall', label: '11 % and more', max: Number.POSITIVE_INFINITY },
] as const;

export type GradeBand = (typeof GRADE_BANDS)[number]['id'];

export function gradeBand(g: number): GradeBand {
  const v = Number.isFinite(g) ? g : 0;
  for (const b of GRADE_BANDS) if (v < b.max) return b.id;
  return 'wall';
}

// ───────────── profile ─────────────

export interface ProfileBox {
  width: number;
  height: number;
  /** Padding at the top and bottom, in box units. */
  padTop?: number;
  padBottom?: number;
  /** Smallest elevation span shown, metres (a flat route plots flat). */
  minSpanM?: number;
}

export interface ProfileGeometry {
  /** Closed area under the profile. */
  area: string;
  /** The profile line. */
  line: string;
  min: number;
  max: number;
  /** Box y for an elevation. */
  y: (elevationM: number) => number;
}

/** Elevation range for plotting, padded, at least `minSpan` tall. */
export function plotRange(values: readonly number[], minSpan: number): { lo: number; hi: number } {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { lo: 0, hi: minSpan };
  const span = Math.max(hi - lo, minSpan);
  const mid = (lo + hi) / 2;
  return { lo: mid - span / 2, hi: mid + span / 2 };
}

const n1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/**
 * SVG paths for elevations at evenly spaced points across the box width.
 */
export function profileGeometry(values: readonly number[], box: ProfileBox): ProfileGeometry {
  const { width, height } = box;
  const top = box.padTop ?? 2;
  const bottom = height - (box.padBottom ?? 0);
  const { lo, hi } = plotRange(values, box.minSpanM ?? 30);
  const y = (e: number): number => bottom - ((e - lo) / (hi - lo)) * (bottom - top);
  if (values.length < 2) {
    const flat = `M0 ${n1(bottom)} L${width} ${n1(bottom)}`;
    return { area: `${flat} Z`, line: flat, min: lo, max: hi, y };
  }
  const step = width / (values.length - 1);
  let line = '';
  for (let i = 0; i < values.length; i++) {
    const v = Number.isFinite(values[i]) ? values[i]! : lo;
    line += `${i === 0 ? 'M' : 'L'}${n1(i * step)} ${n1(y(v))}`;
  }
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  return { area, line, min: lo, max: hi, y };
}

/** Elevation at `points` evenly spaced distances along a track. */
export function trackProfile(track: RouteTrack, points: number): number[] {
  const out: number[] = [];
  const p = createTrackPoint();
  const total = (track.count - 1) * track.stepM;
  const n = Math.max(2, Math.round(points));
  for (let i = 0; i < n; i++) out.push(sampleTrack(track, (total * i) / (n - 1), p).elevationM);
  return out;
}

/** Elevation of an evenly spaced profile at a distance (linear between points). */
export function profileElevationAt(profile: readonly number[], totalM: number, d: number): number {
  if (profile.length === 0) return 0;
  if (profile.length === 1 || !(totalM > 0)) return profile[0]!;
  const f = (Math.max(0, Math.min(totalM, d)) / totalM) * (profile.length - 1);
  const i = Math.min(profile.length - 2, Math.floor(f));
  const t = f - i;
  return profile[i]! + (profile[i + 1]! - profile[i]!) * t;
}

/**
 * Steepest mean gradient over any `windowM` stretch of an evenly spaced
 * profile (percent), or null when the profile is too coarse to tell.
 */
export function steepestGradient(
  profile: readonly number[],
  totalM: number,
  windowM = 200,
): number | null {
  if (profile.length < 3 || !(totalM > 0)) return null;
  const spacing = totalM / (profile.length - 1);
  if (spacing > windowM) return null;
  const span = Math.max(1, Math.round(windowM / spacing));
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + span < profile.length; i++) {
    const g = ((profile[i + span]! - profile[i]!) / (span * spacing)) * 100;
    if (g > best) best = g;
  }
  return Number.isFinite(best) ? best : null;
}

export interface AheadChunk {
  /** Box x from / to. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  grade: number;
  band: GradeBand;
}

export interface AheadGeometry {
  chunks: AheadChunk[];
  line: string;
  /** Box x of the rider. */
  riderX: number;
  riderY: number;
  /** The steepest chunk ahead of the rider, for a label. */
  steepest: AheadChunk | null;
  /** Elevation range shown, metres. */
  lo: number;
  hi: number;
}

/**
 * The road just behind and ahead of the rider, zoomed: chunks of `chunkM`
 * coloured by their gradient. Chunks sit on a fixed grid of route distance
 * so their colours do not flicker as the rider moves.
 */
export function aheadGeometry(
  track: RouteTrack,
  distanceM: number,
  box: { width: number; height: number },
  opts: { behindM?: number; aheadM?: number; chunkM?: number; minSpanM?: number } = {},
): AheadGeometry {
  const behind = opts.behindM ?? 60;
  const ahead = opts.aheadM ?? 600;
  const chunk = opts.chunkM ?? 25;
  const from = distanceM - behind;
  const to = distanceM + ahead;
  const p = createTrackPoint();
  const total = (track.count - 1) * track.stepM;
  const clampD = (d: number): number => (track.loop ? d : Math.max(0, Math.min(total, d)));
  const elev = (d: number): number => sampleTrack(track, clampD(d), p).elevationM;

  const stops: number[] = [from];
  for (let s = Math.ceil(from / chunk) * chunk; s < to; s += chunk) if (s > from) stops.push(s);
  stops.push(to);
  const values = stops.map(elev);
  const { lo, hi } = plotRange(values, opts.minSpanM ?? 20);
  const top = 3;
  const bottom = box.height - 2;
  const sx = (d: number): number => ((d - from) / (to - from)) * box.width;
  const sy = (e: number): number => bottom - ((e - lo) / (hi - lo)) * (bottom - top);
  const chunks: AheadChunk[] = [];
  let line = '';
  let steepest: AheadChunk | null = null;
  for (let i = 0; i < stops.length; i++) {
    line += `${i === 0 ? 'M' : 'L'}${n1(sx(stops[i]!))} ${n1(sy(values[i]!))}`;
    if (i === 0) continue;
    const d0 = stops[i - 1]!;
    const d1 = stops[i]!;
    const grade = d1 > d0 ? ((values[i]! - values[i - 1]!) / (d1 - d0)) * 100 : 0;
    const c: AheadChunk = {
      x0: sx(d0),
      x1: sx(d1),
      y0: sy(values[i - 1]!),
      y1: sy(values[i]!),
      grade,
      band: gradeBand(grade),
    };
    chunks.push(c);
    if (d0 >= distanceM && d1 - d0 >= chunk * 0.6 && (!steepest || grade > steepest.grade)) {
      steepest = c;
    }
  }
  return {
    chunks,
    line,
    riderX: sx(distanceM),
    riderY: sy(elev(distanceM)),
    steepest: steepest && steepest.grade >= 2 ? steepest : null,
    lo,
    hi,
  };
}

// ───────────── outline / map ─────────────

export interface OutlineFit {
  /** SVG path of the outline in the box (north up). */
  path: string;
  /** Maps outline coordinates to the box. */
  map: (x: number, y: number) => [number, number];
  scale: number;
}

/** Fits [x east, y north] points into a square-ish box, north up, keeping the aspect. */
export function fitOutline(
  points: readonly (readonly [number, number])[],
  box: { width: number; height: number; pad?: number },
): OutlineFit {
  const pad = box.pad ?? 4;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) {
    return { path: '', map: () => [box.width / 2, box.height / 2], scale: 1 };
  }
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const scale = Math.min((box.width - 2 * pad) / spanX, (box.height - 2 * pad) / spanY);
  const ox = (box.width - spanX * scale) / 2;
  const oy = (box.height - spanY * scale) / 2;
  const map = (x: number, y: number): [number, number] => [
    ox + (x - minX) * scale,
    box.height - (oy + (y - minY) * scale),
  ];
  let path = '';
  let first = true;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const [px, py] = map(x, y);
    path += `${first ? 'M' : 'L'}${n1(px)} ${n1(py)}`;
    first = false;
  }
  return { path, map, scale };
}

/** The track's shape as at most `maxPoints` [x, y] points, evenly spaced by distance. */
export function trackOutline(track: RouteTrack, maxPoints = 400): [number, number][] {
  const n = Math.min(track.count, track.x.length, track.y.length);
  if (n === 0) return [];
  const every = Math.max(1, Math.ceil(n / maxPoints));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i += every) out.push([track.x[i]!, track.y[i]!]);
  if ((n - 1) % every !== 0) out.push([track.x[n - 1]!, track.y[n - 1]!]);
  return out;
}

/** Position and heading (radians, 0 = north, clockwise) on the track at a route distance. */
export function trackPosition(
  track: RouteTrack,
  distanceM: number,
): { x: number; y: number; headingRad: number } {
  const p = sampleTrack(track, routeDistance(track, distanceM), createTrackPoint());
  return { x: p.x, y: p.y, headingRad: p.headingRad };
}

/** Share of the route done, 0…1 (of the current lap on a loop). */
export function routeProgress(totalM: number, distanceM: number, loop: boolean): number {
  if (!(totalM > 0) || !Number.isFinite(distanceM)) return 0;
  const d = loop ? ((distanceM % totalM) + totalM) % totalM : distanceM;
  return Math.max(0, Math.min(1, d / totalM));
}
