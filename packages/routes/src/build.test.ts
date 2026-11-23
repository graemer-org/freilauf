import { describe, expect, it } from 'vitest';
import { buildRoute, gaussianSmooth, prepareRoute, resampleTrack } from './build';
import { haversineM, unproject } from './geo';
import type { RawPoint, RawTrack } from './gpx';
import { curvatureAt, gradeAt, headingAt } from './query';

const ORIGIN = { lat0: 46.5, lon0: 8.0 };
/** Points at local x/y (m) around ORIGIN. */
const at = (x: number, y: number, ele = 0): RawPoint => ({ ...unproject(ORIGIN, x, y), ele });
const raw = (points: RawPoint[], hasElevation = true): RawTrack => ({
  name: 'Test',
  points,
  hasElevation,
});

/** Deterministic PRNG (mulberry32) and a normal deviate from it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

describe('buildRoute geometry', () => {
  it('resamples a straight line north at the fixed step', () => {
    const pts = Array.from({ length: 101 }, (_, i) => at(0, i * 25, 100)); // 2.5 km, 25 m apart
    const t = buildRoute(raw(pts));
    expect(t.totalDistanceM).toBeCloseTo(2500, 0);
    expect(t.stepM).toBeCloseTo(10, 2);
    expect(t.count).toBe(251);
    expect(t.x[0]).toBe(0);
    expect(t.y[0]).toBe(0);
    expect(t.y[100]).toBeCloseTo(100 * t.stepM, 1);
    expect(Math.max(...t.x.map(Math.abs))).toBeLessThan(0.01);
    for (const h of t.headingRad) expect(h).toBeCloseTo(0, 4);
    expect(t.loop).toBe(false);
    expect(t.ascentM).toBeCloseTo(0, 6);
    // lat/lon follow the samples
    expect(haversineM(t.lat[0]!, t.lon[0]!, t.lat[250]!, t.lon[250]!)).toBeCloseTo(2500, 0);
    expect(t.id).toMatch(/^route-[a-z0-9]+$/);
  });

  it('curvature of a quarter circle of radius r is ≈ 1/r (+ = right)', () => {
    const r = 200;
    const pts: RawPoint[] = [];
    for (let y = 0; y < 500; y += 5) pts.push(at(0, y));
    // Quarter circle to the right (clockwise seen from above: north → east).
    for (let k = 0; k <= 90; k++) {
      const a = (k * Math.PI) / 180;
      pts.push(at(r - r * Math.cos(a), 500 + r * Math.sin(a)));
    }
    for (let x = r + 5; x < r + 500; x += 5) pts.push(at(x, 500 + r));
    const t = buildRoute(raw(pts));
    const arc = (Math.PI / 2) * r;
    const mid = 500 + arc / 2;
    expect(curvatureAt(t, mid)).toBeCloseTo(1 / r, 3);
    expect(curvatureAt(t, 200)).toBeCloseTo(0, 4);
    expect(curvatureAt(t, 500 + arc + 200)).toBeCloseTo(0, 4);
    expect(headingAt(t, 100)).toBeCloseTo(0, 3);
    expect(headingAt(t, 500 + arc + 100)).toBeCloseTo(Math.PI / 2, 2);
  });

  it('headings are unwrapped across north', () => {
    // A full circle, counter-clockwise twice is not needed: one turn through ±π is enough.
    const pts: RawPoint[] = [];
    for (let k = 0; k <= 400; k++) {
      const a = (k / 400) * 1.5 * 2 * Math.PI;
      pts.push(at(100 * Math.sin(a), 100 * Math.cos(a)));
    }
    const t = buildRoute(raw(pts));
    for (let i = 1; i < t.count; i++) {
      expect(Math.abs(t.headingRad[i]! - t.headingRad[i - 1]!)).toBeLessThan(0.3);
    }
    expect(t.headingRad[t.count - 1]! - t.headingRad[0]!).toBeGreaterThan(2.5 * Math.PI);
  });

  it('drops duplicates and GPS spikes, but keeps a sparse turnaround', () => {
    const pts: RawPoint[] = [];
    for (let i = 0; i <= 200; i++) {
      pts.push(at(0, i * 10, 0));
      if (i % 50 === 0) pts.push(at(0, i * 10, 0)); // stationary
    }
    pts.splice(100, 0, at(2000, 1000, 0)); // spike out and back
    const r = prepareRoute(raw(pts));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats.duplicatesDropped).toBe(5);
    expect(r.stats.spikesDropped).toBe(1);
    expect(r.track.totalDistanceM).toBeCloseTo(2000, 0);
    expect(r.warnings.join()).toMatch(/GPS spike/);

    // Out-and-back with a planner's 100 m spacing: the far point is a real turnaround.
    const ob: RawPoint[] = [];
    for (let i = 0; i <= 30; i++) ob.push(at(0, i * 100));
    for (let i = 29; i >= 0; i--) ob.push(at(6, i * 100));
    const o = prepareRoute(raw(ob));
    expect(o.ok && o.stats.spikesDropped).toBe(0);
    expect(o.ok && o.track.loop).toBe(true);
    expect(o.ok && o.track.totalDistanceM).toBeGreaterThan(6000);
  });

  it('detects loops (end within 50 m, longer than 500 m) and closes them', () => {
    const circle = (n: number, r: number, gap: number) =>
      Array.from({ length: n }, (_, k) => {
        const a = (k / n) * (2 * Math.PI - gap / r);
        return at(r * Math.sin(a), r - r * Math.cos(a), 10 + 0.01 * k);
      });
    const t = buildRoute(raw(circle(300, 300, 30)));
    expect(t.loop).toBe(true);
    expect(t.x[t.count - 1]).toBe(t.x[0]);
    expect(t.elevationM[t.count - 1]).toBe(t.elevationM[0]);
    expect(buildRoute(raw(circle(300, 300, 120))).loop).toBe(false);
    expect(buildRoute(raw(circle(100, 60, 10))).loop).toBe(false); // 377 m: too short for laps
  });

  it('uses a larger step for long routes so the sample count stays ≤ 20 000', () => {
    const pts = Array.from({ length: 2501 }, (_, i) => at(0, i * 100)); // 250 km
    const t = buildRoute(raw(pts));
    expect(t.count).toBeLessThanOrEqual(20_000);
    expect(t.stepM).toBeGreaterThan(12);
    expect(t.stepM).toBeLessThanOrEqual(13);
    expect(t.totalDistanceM).toBeCloseTo(250_000, -1);
  });

  it('refuses tracks that are too short', () => {
    const r = prepareRoute(raw([at(0, 0), at(0, 50)]));
    expect(r.ok).toBe(false);
    expect(() => buildRoute(raw([at(0, 0), at(0, 50)]))).toThrow(RangeError);
  });

  it('a file without elevation becomes a flat route', () => {
    const t = buildRoute(
      raw(
        Array.from({ length: 50 }, (_, i) => at(0, i * 20, 0)),
        false,
      ),
    );
    expect(t.elevationM.every((e) => e === 0)).toBe(true);
    expect(t.ascentM).toBe(0);
  });

  it('is deterministic and gives the same id to the same content', () => {
    const pts = Array.from({ length: 300 }, (_, i) => at(Math.sin(i / 20) * 50, i * 10, i * 0.3));
    const a = buildRoute(raw(pts));
    const b = buildRoute(raw(pts.map((p) => ({ ...p }))));
    expect(b).toEqual(a);
    const c = buildRoute(raw(pts.map((p, i) => (i === 150 ? { ...p, ele: p.ele + 20 } : p))));
    expect(c.id).not.toBe(a.id);
  });
});

describe('elevation smoothing', () => {
  /** A 5 km climb at 6 %, GPS-like points every 4–9 m with σ = 1.5 m elevation noise and spikes. */
  function noisyClimb(seed: number): { points: RawPoint[]; trueAscent: number } {
    const r = rng(seed);
    const points: RawPoint[] = [];
    for (let y = 0; y <= 5000; y += 4 + 5 * r()) {
      let ele = 500 + 0.06 * y + 1.5 * gauss(r);
      if (r() < 0.005) ele += 40 * (r() - 0.5); // barometric glitch
      points.push(at(2 * gauss(r), y, ele));
    }
    return { points, trueAscent: 300 };
  }

  it('turns a noisy 6 % climb into gradients within a tight band of the truth', () => {
    for (const seed of [1, 2, 3]) {
      const { points, trueAscent } = noisyClimb(seed);
      const r = prepareRoute(raw(points));
      if (!r.ok) throw new Error(r.errors.join());
      const t = r.track;
      // The noisy sum is wildly inflated; the smoothed ascent is close to the truth.
      expect(r.stats.rawAscentM).toBeGreaterThan(2.5 * trueAscent);
      expect(Math.abs(t.ascentM - trueAscent)).toBeLessThan(0.02 * trueAscent);
      expect(t.descentM).toBeLessThan(5);
      const errors: number[] = [];
      // The first and last 100 m only see noise from one side.
      for (let d = 100; d <= t.totalDistanceM - 100; d += 10)
        errors.push(Math.abs(gradeAt(t, d) - 6));
      errors.sort((a, b) => a - b);
      expect(errors.at(-1)).toBeLessThan(2); // worst sample of the whole climb
      expect(errors[Math.floor(errors.length * 0.95)]).toBeLessThan(1.5); // 95th percentile
      expect(errors[Math.floor(errors.length * 0.5)]).toBeLessThan(0.6); // median
    }
  });

  it('keeps a flat noisy road flat', () => {
    const r = rng(9);
    const pts: RawPoint[] = [];
    for (let y = 0; y <= 5000; y += 5) pts.push(at(0, y, 200 + 2 * gauss(r)));
    const t = buildRoute(raw(pts));
    expect(t.ascentM).toBeLessThan(5);
    for (let d = 0; d <= t.totalDistanceM; d += 10) expect(Math.abs(gradeAt(t, d))).toBeLessThan(2);
  });

  it('caps gradients at 25 % and limits how fast they change', () => {
    const pts: RawPoint[] = [];
    for (let y = 0; y <= 3000; y += 5) pts.push(at(0, y, y < 1500 ? 100 : 100 + (y - 1500) * 0.6));
    const t = buildRoute(raw(pts));
    let maxChange = 0;
    for (let d = 0; d <= t.totalDistanceM; d += 10) {
      expect(gradeAt(t, d)).toBeLessThanOrEqual(25.01);
      if (d > 0) maxChange = Math.max(maxChange, Math.abs(gradeAt(t, d) - gradeAt(t, d - 10)));
    }
    expect(gradeAt(t, 2500)).toBeCloseTo(25, 0);
    expect(maxChange).toBeLessThanOrEqual(1.5 + 1e-6); // 0.15 % per metre
  });

  it('gaussianSmooth keeps a straight trend straight to the ends', () => {
    const v = Array.from({ length: 50 }, (_, i) => 3 * i + 7);
    const s = gaussianSmooth(v, 3, false);
    s.forEach((x, i) => expect(x).toBeCloseTo(v[i]!, 9));
  });
});

describe('resampleTrack', () => {
  it('coarsens a track and derives a new id', () => {
    const pts = Array.from({ length: 401 }, (_, i) => at(0, i * 10, 100 + i));
    const t = buildRoute(raw(pts));
    const c = resampleTrack(t, 25);
    expect(c.stepM).toBeCloseTo(25, 6);
    expect(c.count).toBe(161);
    expect(c.totalDistanceM).toBeCloseTo(t.totalDistanceM, 6);
    expect(c.id).toBe(`${t.id}-25m`);
    expect(Math.abs(c.ascentM - t.ascentM)).toBeLessThan(2);
    expect(resampleTrack(t, 10)).toBe(t);
  });
});
