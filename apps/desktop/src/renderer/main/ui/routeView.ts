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

// ───────────── picking a point: start point and jumps (docs/routes.md) ─────────────

/** A place on the route in words: `km 42.3`. */
export function formatRouteKm(m: number): string {
  const v = Math.max(0, Number.isFinite(m) ? m : 0);
  return `km ${(v / 1000).toFixed(1)}`;
}

/** What the profile or map shows for a point: `km 42.3 · 812 m · +3.1 %`. */
export function pointLabel(p: {
  distanceM: number;
  elevationM: number;
  gradePercent: number;
}): string {
  return `${formatRouteKm(p.distanceM)} · ${Math.round(Number.isFinite(p.elevationM) ? p.elevationM : 0)} m · ${formatGradient(p.gradePercent)}`;
}

/** 'start' before the ride (choose where it starts), 'jump' during it. */
export type PickMode = 'start' | 'jump';

/** The question of the confirmation and the word on its button. */
export function pickPrompt(mode: PickMode, label: string): { text: string; confirm: string } {
  return mode === 'start'
    ? { text: `Start at ${label}`, confirm: 'Start here' }
    : { text: `Jump to ${label}`, confirm: 'Jump' };
}

/** Distance, elevation and gradient (percent, over the next 10 m) at a route distance. */
export function trackPointInfo(
  track: RouteTrack,
  distanceM: number,
): { distanceM: number; elevationM: number; gradePercent: number } {
  const d = routeDistance(track, distanceM);
  const p = createTrackPoint();
  const a = sampleTrack(track, d, p).elevationM;
  // Centred difference over ±10 m, inside the route.
  const total = (track.count - 1) * track.stepM;
  const lo = track.loop ? d - 10 : Math.max(0, d - 10);
  const hi = track.loop ? d + 10 : Math.min(total, d + 10);
  const g =
    hi > lo
      ? ((sampleTrack(track, hi, p).elevationM - sampleTrack(track, lo, p).elevationM) /
          (hi - lo)) *
        100
      : 0;
  return { distanceM: d, elevationM: a, gradePercent: g };
}

/** The same from an evenly spaced profile (Routes tab without the track): coarse but honest. */
export function profilePointInfo(
  profile: readonly number[],
  totalM: number,
  distanceM: number,
): { distanceM: number; elevationM: number; gradePercent: number } {
  const d = Math.max(0, Math.min(totalM, Number.isFinite(distanceM) ? distanceM : 0));
  const spacing = profile.length > 1 && totalM > 0 ? totalM / (profile.length - 1) : 0;
  const half = Math.max(10, spacing / 2);
  const lo = Math.max(0, d - half);
  const hi = Math.min(totalM, d + half);
  const g =
    hi > lo
      ? ((profileElevationAt(profile, totalM, hi) - profileElevationAt(profile, totalM, lo)) /
          (hi - lo)) *
        100
      : 0;
  return { distanceM: d, elevationM: profileElevationAt(profile, totalM, d), gradePercent: g };
}

/**
 * Keyboard steps for a profile showing `spanM` of road: ← → move by `small` (about 1 % of the
 * span, a round number of metres), Shift by `large` (10 ×). 97.6 km → 1 km / 10 km; the 660 m
 * "ahead" profile → 10 m / 100 m.
 */
export function pickSteps(spanM: number): { small: number; large: number } {
  const raw = Math.max(10, (Number.isFinite(spanM) ? spanM : 0) / 100);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= raw * 0.999) ?? 10 * mag;
  return { small: nice, large: nice * 10 };
}

export interface MapCandidate {
  /** Route distance of the nearest point of this pass, metres. */
  distanceM: number;
  /** Its distance from the pointer, in box units. */
  boxDistance: number;
}

/**
 * Every pass of the route near a point of the map box (`fit` maps track x/y into the box):
 * runs of samples within `radius` box units, each reduced to its nearest sample. An
 * out-and-back route gives two candidates where the legs overlap.
 */
export function mapCandidates(
  track: RouteTrack,
  fit: Pick<OutlineFit, 'map'>,
  boxX: number,
  boxY: number,
  radius: number,
): MapCandidate[] {
  const n = Math.min(track.count, track.x.length, track.y.length);
  if (n === 0) return [];
  const stride = Math.max(1, Math.ceil(n / 4000));
  const out: MapCandidate[] = [];
  let run: MapCandidate | null = null;
  let lastIn = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const [px, py] = fit.map(track.x[i]!, track.y[i]!);
    const dist = Math.hypot(px - boxX, py - boxY);
    if (dist > radius) continue;
    // A new pass when the previous sample inside the radius is more than a few samples back.
    if (!run || i - lastIn > 3 * stride) {
      run = { distanceM: i * track.stepM, boxDistance: dist };
      out.push(run);
    } else if (dist < run.boxDistance) {
      run.distanceM = i * track.stepM;
      run.boxDistance = dist;
    }
    lastIn = i;
  }
  // On a loop, a pass across the start/finish line is one pass.
  if (
    track.loop &&
    out.length > 1 &&
    lastIn >= n - 1 - 3 * stride &&
    out[0]!.distanceM < 4 * stride * track.stepM
  ) {
    const tail = out.pop()!;
    if (tail.boxDistance < out[0]!.boxDistance) out[0] = tail;
  }
  return out;
}

/**
 * Which pass a click on the map means. Passes about as close to the pointer as the closest one
 * (within `tolerance` box units) are ambiguous (overlapping legs); of those, the next one ahead
 * of `currentM` along the route is taken (wrapping on a loop; on a point-to-point route the
 * nearest one behind if none is ahead). The kilometre in the confirmation then shows the rider
 * which leg was picked. Null without candidates.
 */
export function chooseMapCandidate(
  candidates: readonly MapCandidate[],
  currentM: number,
  totalM: number,
  loop: boolean,
  tolerance = 2,
): MapCandidate | null {
  if (candidates.length === 0) return null;
  const best = Math.min(...candidates.map((c) => c.boxDistance));
  const near = candidates.filter((c) => c.boxDistance <= best + tolerance);
  // Distance ahead along the route; passes behind (point-to-point) only after all ahead ones,
  // nearest first.
  const ahead = (c: MapCandidate): number => {
    const g = c.distanceM - currentM;
    if (loop && totalM > 0) return ((g % totalM) + totalM) % totalM;
    return g >= 0 ? g : 1e12 - g;
  };
  return near.reduce((a, b) => (ahead(b) < ahead(a) ? b : a));
}

/** Box coordinates (viewBox units) of a pointer over an SVG drawn with `xMidYMid meet`. */
export function clientToBox(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  boxW: number,
  boxH: number,
): [number, number] {
  const scale = Math.min(rect.width / boxW, rect.height / boxH) || 1;
  const ox = rect.left + (rect.width - boxW * scale) / 2;
  const oy = rect.top + (rect.height - boxH * scale) / 2;
  return [(clientX - ox) / scale, (clientY - oy) / scale];
}
