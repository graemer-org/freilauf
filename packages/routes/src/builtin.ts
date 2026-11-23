/**
 * Built-in routes: original, synthetic and deterministic (generated here, not copied from any
 * real track). They are placed in the open Pacific so a recorded ride's map shows plain water
 * rather than pretending to be somewhere real.
 */
import { buildRoute } from './build';
import { unproject } from './geo';
import type { RawPoint, RawTrack } from './gpx';
import type { RouteTrack } from './types';

const ORIGIN = { lat0: -12.5, lon0: -150.5 };
const TAU = 2 * Math.PI;

/** A closed or open parametric curve sampled every ~2 m, scaled to `lengthM`. */
function curve(
  fn: (t: number) => [number, number],
  lengthM: number,
  elevation: (s: number, total: number) => number,
  closed: boolean,
): RawPoint[] {
  const fine = 20_000;
  const pts: [number, number][] = [];
  for (let k = 0; k <= fine; k++) pts.push(fn(k / fine));
  let len = 0;
  for (let k = 1; k < pts.length; k++) {
    len += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
  }
  const scale = lengthM / len;
  const out: RawPoint[] = [];
  let s = 0;
  const step = Math.max(1, Math.round(fine / (lengthM / 2)));
  const [x0, y0] = pts[0]!;
  for (let k = 0; k < pts.length; k += step) {
    if (k > 0) {
      const a = pts[k - step]!;
      const b = pts[k]!;
      s += Math.hypot(b[0] - a[0], b[1] - a[1]) * scale;
    }
    const [x, y] = pts[k]!;
    const g = unproject(ORIGIN, (x - x0) * scale, (y - y0) * scale);
    out.push({ lat: g.lat, lon: g.lon, ele: elevation(s, lengthM) });
  }
  if (closed) out.push({ ...out[0]! });
  return out;
}

function make(id: string, name: string, description: string, points: RawPoint[]): RouteTrack {
  const raw: RawTrack = { name, description, points, hasElevation: true };
  return buildRoute(raw, { id, name, description });
}

/** ≈ 12 km loop over gentle rollers (up to ~5 %). */
function rollingLoop(): RouteTrack {
  return make(
    'builtin-rolling-loop',
    'Rolling loop',
    'A 12 km loop over gentle rollers, never steeper than about 5 %.',
    curve(
      (t) => {
        const a = TAU * t;
        const r = 1 + 0.18 * Math.sin(3 * a) + 0.05 * Math.sin(7 * a);
        return [r * Math.sin(a), r * Math.cos(a)];
      },
      12_000,
      (s, L) => 120 + 25 * Math.sin((TAU * 2 * s) / L) + 10 * Math.sin((TAU * 5 * s) / L + 1),
      true,
    ),
  );
}

/** ≈ 8 km steady climb at ~6 %, winding, with a few tight bends near the top. */
function steadyClimb(): RouteTrack {
  return make(
    'builtin-steady-climb',
    'Steady climb',
    'An 8 km climb at a steady 6 % (between 5 and 7 %), winding up to a few tight bends near the top.',
    curve(
      (t) => {
        // Gentle S-bends, then three switchbacks in the last fifth.
        const x =
          0.04 * Math.sin(TAU * 4 * t) + (t > 0.8 ? 0.05 * Math.sin(TAU * 7.5 * (t - 0.8)) : 0);
        return [x, t];
      },
      8_000,
      (s) => 400 + 0.06 * s + 3.2 * Math.sin((TAU * s) / 2000),
      false,
    ),
  );
}

/** ≈ 4 km circuit with real corners and short punchy rises (up to ~9 %). */
function punchyCircuit(): RouteTrack {
  return make(
    'builtin-punchy-circuit',
    'Punchy circuit',
    'A short 4 km circuit with tight corners, a chicane and sharp little rises up to about 9 %.',
    curve(
      (t) => {
        const a = TAU * t;
        // A rounded square with a chicane on one side.
        const sx = Math.sign(Math.cos(a)) * Math.abs(Math.cos(a)) ** 0.15;
        const sy = Math.sign(Math.sin(a)) * Math.abs(Math.sin(a)) ** 0.15;
        const chicane = 0.12 * Math.exp(-(((a - Math.PI) / 0.25) ** 2));
        return [1.3 * sx + chicane, sy];
      },
      4_000,
      (s, L) => 50 + 12 * Math.sin((TAU * 3 * s) / L) + 5.5 * Math.sin((TAU * 7 * s) / L + 0.5),
      true,
    ),
  );
}

/** ≈ 20 km flat out-and-back: 10 km out, a tight turn, 10 km back on the other lane. */
function flatOutAndBack(): RouteTrack {
  const outM = 10_000;
  const lane = 8; // turning radius = half the distance between the lanes
  const pts: RawPoint[] = [];
  const ele = (s: number) => 5 + 0.8 * Math.sin((TAU * s) / 3000);
  const push = (x: number, y: number, s: number) => {
    const g = unproject(ORIGIN, x + 30_000, y);
    pts.push({ lat: g.lat, lon: g.lon, ele: ele(s) });
  };
  const wiggle = (y: number) => 40 * Math.sin((TAU * y) / 3000);
  for (let y = 0; y <= outM; y += 5) push(wiggle(y), y, y);
  for (let k = 1; k < 20; k++) {
    const a = (Math.PI * k) / 20;
    push(wiggle(outM) + lane - lane * Math.cos(a), outM + lane * Math.sin(a), outM + lane * a);
  }
  for (let y = outM; y >= 0; y -= 5) push(wiggle(y) + 2 * lane, y, 2 * outM - y);
  return make(
    'builtin-flat-out-and-back',
    'Flat out-and-back',
    'A flat 20 km out-and-back: 10 km out, a tight turn, and 10 km back. Ridden as laps.',
    pts,
  );
}

let cached: readonly RouteTrack[] | null = null;

/** The built-in routes (built once, on first use). */
export function builtinRoutes(): readonly RouteTrack[] {
  cached ??= Object.freeze([rollingLoop(), steadyClimb(), punchyCircuit(), flatOutAndBack()]);
  return cached;
}

export function getBuiltinRoute(id: string): RouteTrack | null {
  return builtinRoutes().find((r) => r.id === id) ?? null;
}
