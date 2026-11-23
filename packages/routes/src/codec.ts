/**
 * Native storage/share format of a prepared route: a small JSON envelope with the samples
 * quantised and delta-encoded as base64url varints (5 bits per character). Headings, lat/lon
 * and ascent are not stored; they are recomputed from the positions on decode, exactly as
 * buildRoute computes them. Decoding validates everything (untrusted peers and files).
 */
import {
  ascentDescent,
  computeHeadings,
  MAX_ROUTE_LENGTH_M,
  MAX_TRACK_SAMPLES,
  resampleTrack,
} from './build';
import { cleanText, unproject, utf8ByteLength } from './geo';
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from './gpx';
import type { RouteTrack } from './types';

export const ROUTE_FORMAT = 'freilauf-route';
export const ROUTE_FORMAT_VERSION = 1;
export const ROUTE_FILE_EXTENSION = '.freilauf-route.json';
/** Upper bound for an encoded route (UTF-8 bytes), enforced by decodeRoute. */
export const MAX_ENCODED_ROUTE_BYTES = 512 * 1024;

export interface EncodeOptions {
  /** Position resolution (m). Default 0.1 m (storage). */
  positionQuantumM?: number;
  /** Elevation resolution (m). Default 0.1 m. */
  elevationQuantumM?: number;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALUE = new Map([...ALPHABET].map((c, i) => [c, i]));
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MIN_QUANTUM = 0.01;
const MAX_QUANTUM = 10;

function pushVarint(out: string[], v: number): void {
  let z = v < 0 ? -2 * v - 1 : 2 * v;
  while (z >= 32) {
    out.push(ALPHABET[32 | (z % 32)]!);
    z = Math.floor(z / 32);
  }
  out.push(ALPHABET[z]!);
}

/** Decodes up to `limit` zigzag varints; null on any malformed input. */
function readVarints(s: string, limit: number): number[] | null {
  const out: number[] = [];
  let z = 0;
  let mul = 1;
  for (const c of s) {
    const d = VALUE.get(c);
    if (d === undefined) return null;
    z += (d % 32) * mul;
    if (d >= 32) {
      mul *= 32;
      if (mul > 2 ** 40) return null;
      continue;
    }
    if (out.length >= limit) return null;
    out.push(z % 2 === 0 ? z / 2 : -(z + 1) / 2);
    z = 0;
    mul = 1;
  }
  return mul === 1 ? out : null;
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Encodes a route as compact text. */
export function encodeRoute(track: RouteTrack, options: EncodeOptions = {}): string {
  const qp = Math.min(MAX_QUANTUM, Math.max(MIN_QUANTUM, options.positionQuantumM ?? 0.1));
  const qe = Math.min(MAX_QUANTUM, Math.max(MIN_QUANTUM, options.elevationQuantumM ?? 0.1));
  const e: string[] = [];
  let prevE = 0;
  for (let i = 0; i < track.count; i++) {
    const q = Math.round(track.elevationM[i]! / qe);
    pushVarint(e, q - prevE);
    prevE = q;
  }
  // Positions relative to the first sample; deltas of the quantised absolute values, so the
  // rounding never accumulates.
  const p: string[] = [];
  let px = 0;
  let py = 0;
  for (let i = 1; i < track.count; i++) {
    const qx = Math.round((track.x[i]! - track.x[0]!) / qp);
    const qy = Math.round((track.y[i]! - track.y[0]!) / qp);
    pushVarint(p, qx - px);
    pushVarint(p, qy - py);
    px = qx;
    py = qy;
  }
  return JSON.stringify({
    f: ROUTE_FORMAT,
    v: ROUTE_FORMAT_VERSION,
    id: track.id,
    name: track.name,
    ...(track.description ? { desc: track.description } : {}),
    step: round(track.stepM, 6),
    n: track.count,
    loop: track.loop,
    lat0: round(track.lat[0]!, 7),
    lon0: round(track.lon[0]!, 7),
    qp,
    qe,
    e: e.join(''),
    p: p.join(''),
  });
}

export type DecodeRouteResult = { ok: true; track: RouteTrack } | { ok: false; errors: string[] };

const fail = (msg: string): DecodeRouteResult => ({ ok: false, errors: [msg] });
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Decodes untrusted text (file, storage or peer). Never throws. */
export function decodeRoute(text: string): DecodeRouteResult {
  try {
    return decode(text);
  } catch {
    return fail('Not a valid Freilauf route');
  }
}

function decode(text: string): DecodeRouteResult {
  if (typeof text !== 'string') return fail('Input is not text');
  if (text.length > MAX_ENCODED_ROUTE_BYTES || utf8ByteLength(text) > MAX_ENCODED_ROUTE_BYTES) {
    return fail(`Encoded route is larger than ${MAX_ENCODED_ROUTE_BYTES} bytes`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return fail('Not valid JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return fail('Not a Freilauf route');
  }
  const r = data as Record<string, unknown>;
  if (r['f'] !== ROUTE_FORMAT) return fail('Not a Freilauf route');
  const v = r['v'];
  if (!isNum(v) || v < 0) return fail('Missing or invalid format version');
  if (Math.floor(v) !== ROUTE_FORMAT_VERSION) return fail(`Unsupported route format version ${v}`);

  const { id, name, desc, step, n, loop, lat0, lon0, qp, qe, e, p } = r;
  if (typeof id !== 'string' || !ID.test(id)) return fail('Invalid route id');
  if (typeof name !== 'string' || name.length > 4 * MAX_NAME_LENGTH) return fail('Invalid name');
  if (
    desc !== undefined &&
    (typeof desc !== 'string' || desc.length > 4 * MAX_DESCRIPTION_LENGTH)
  ) {
    return fail('Invalid description');
  }
  if (!isNum(step) || step < 1 || step > 1000) return fail('Invalid step');
  if (!isNum(n) || !Number.isInteger(n) || n < 2 || n > MAX_TRACK_SAMPLES) {
    return fail('Invalid sample count');
  }
  if ((n - 1) * step > MAX_ROUTE_LENGTH_M) return fail('Route too long');
  if (typeof loop !== 'boolean') return fail('Invalid loop flag');
  if (!isNum(lat0) || lat0 < -90 || lat0 > 90 || !isNum(lon0) || lon0 < -180 || lon0 > 180) {
    return fail('Invalid origin');
  }
  for (const q of [qp, qe]) {
    if (!isNum(q) || q < MIN_QUANTUM || q > MAX_QUANTUM) return fail('Invalid resolution');
  }
  if (typeof e !== 'string' || typeof p !== 'string') return fail('Missing samples');
  const de = readVarints(e, n);
  const dp = readVarints(p, 2 * (n - 1));
  if (!de || de.length !== n) return fail('Corrupt elevation data');
  if (!dp || dp.length !== 2 * (n - 1)) return fail('Corrupt position data');

  const elevationM: number[] = new Array<number>(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += de[i]!;
    const ele = acc * (qe as number);
    if (!Number.isFinite(ele) || ele < -500 || ele > 9000) return fail('Elevation out of range');
    elevationM[i] = ele;
  }
  const x: number[] = [0];
  const y: number[] = [0];
  let ax = 0;
  let ay = 0;
  // Samples are `step` apart along the road, so the straight line between two can't be longer.
  const maxChord = step + 2 * (qp as number) + 0.01;
  for (let i = 1; i < n; i++) {
    ax += dp[2 * (i - 1)]!;
    ay += dp[2 * (i - 1) + 1]!;
    const xi = ax * (qp as number);
    const yi = ay * (qp as number);
    if (Math.hypot(xi - x[i - 1]!, yi - y[i - 1]!) > maxChord)
      return fail('Inconsistent positions');
    x.push(xi);
    y.push(yi);
  }
  const proj = { lat0, lon0 };
  const lat: number[] = new Array<number>(n);
  const lon: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const g = unproject(proj, x[i]!, y[i]!);
    if (!Number.isFinite(g.lat) || Math.abs(g.lat) > 90 || !Number.isFinite(g.lon)) {
      return fail('Position out of range');
    }
    lat[i] = g.lat;
    lon[i] = ((((g.lon + 180) % 360) + 360) % 360) - 180;
  }
  const cleanName = cleanText(name, MAX_NAME_LENGTH) || 'Route';
  const cleanDesc = typeof desc === 'string' ? cleanText(desc, MAX_DESCRIPTION_LENGTH) : '';
  const { ascentM, descentM } = ascentDescent(elevationM);
  return {
    ok: true,
    track: {
      id,
      name: cleanName,
      ...(cleanDesc ? { description: cleanDesc } : {}),
      stepM: step,
      count: n,
      totalDistanceM: (n - 1) * step,
      elevationM,
      x,
      y,
      headingRad: computeHeadings(x, y, step, loop),
      lat,
      lon,
      ascentM,
      descentM,
      loop,
    },
  };
}

// ── Sharing ────────────────────────────────────────────────────────────────────────────────

/** Coarser steps tried, in order, until the route fits the budget. */
export const SHARE_STEPS_M: readonly number[] = [10, 15, 20, 25, 30, 40, 50];
/** Beyond this the gradient no longer follows short climbs; sharing is refused instead. */
export const MAX_SHARE_STEP_M = 50;
/**
 * Largest shared route (UTF-8 bytes): one group document (16 KiB) minus headroom. A rider's
 * documents may total 32 KiB (four at most); the app lowers this further by what a shared
 * workout and the community standing need, and the community extras (challenges, relays)
 * make room for the route as they do for a workout (docs/adr/0004-routes.md).
 */
export const ROUTE_SHARE_BUDGET_BYTES = 16 * 1024 - 512;

export type ShareRouteResult =
  | { ok: true; track: RouteTrack; text: string; stepM: number; bytes: number }
  | { ok: false; reason: string };

/**
 * Reduces the resolution step by step (SHARE_STEPS_M) until the encoded route fits maxBytes.
 * Positions are quantised to a tenth of the step (enough for drawing; no accumulation),
 * elevation to 0.1 m. Refuses — rather than sending mush — when even MAX_SHARE_STEP_M does
 * not fit.
 */
export function simplifyForSharing(
  track: RouteTrack,
  maxBytes: number = ROUTE_SHARE_BUDGET_BYTES,
): ShareRouteResult {
  let lastBytes = 0;
  for (const nominal of SHARE_STEPS_M) {
    if (nominal < track.stepM * 0.999) continue;
    const coarse = resampleTrack(track, nominal);
    const text = encodeRoute(coarse, { positionQuantumM: Math.max(0.1, coarse.stepM / 10) });
    lastBytes = utf8ByteLength(text);
    if (lastBytes <= maxBytes) {
      return { ok: true, track: coarse, text, stepM: coarse.stepM, bytes: lastBytes };
    }
  }
  const km = (track.totalDistanceM / 1000).toFixed(1);
  return {
    ok: false,
    reason:
      lastBytes > 0
        ? `the route (${km} km) is too long to share in a group: even with a point every ${MAX_SHARE_STEP_M} m it needs ${Math.ceil(lastBytes / 1024)} KB, and a group allows ${Math.floor(maxBytes / 1024)} KB`
        : `the route's resolution (${Math.round(track.stepM)} m) is too coarse to share`,
  };
}
