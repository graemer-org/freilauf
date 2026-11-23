import { describe, expect, it } from 'vitest';
import { buildRoute } from './build';
import { unproject } from './geo';
import type { RawPoint } from './gpx';
import {
  curvatureAt,
  elevationAt,
  gradeAt,
  headingAt,
  lookahead,
  outline,
  pointAt,
  positionAt,
  profile,
} from './query';

const O = { lat0: 46.5, lon0: 8 };
const at = (x: number, y: number, ele: number): RawPoint => ({ ...unproject(O, x, y), ele });

/** 2 km straight north, a steady 5 % climb. */
const climb = buildRoute({
  name: 'Climb',
  hasElevation: true,
  points: Array.from({ length: 201 }, (_, i) => at(0, i * 10, 100 + i * 0.5)),
});

/** A 1 km-radius circle (≈ 6.28 km) ridden clockwise, flat. */
const ring = buildRoute({
  name: 'Ring',
  hasElevation: true,
  points: Array.from({ length: 629 }, (_, k) => {
    const a = (k / 629) * 2 * Math.PI;
    return at(1000 * Math.sin(a), 1000 * Math.cos(a) - 1000, 50);
  }),
});

describe('point-to-point queries', () => {
  it('interpolates elevation and grade inside the route', () => {
    expect(gradeAt(climb, 1000)).toBeCloseTo(5, 1);
    expect(elevationAt(climb, 1000)).toBeCloseTo(150, 0);
    expect(elevationAt(climb, 1005)).toBeCloseTo(150.25, 0);
    expect(pointAt(climb, 1005).y).toBeCloseTo(1005, 0);
  });

  it('clamps at the ends; flat and straight past the finish', () => {
    expect(elevationAt(climb, -50)).toBe(climb.elevationM[0]);
    expect(elevationAt(climb, 5000)).toBe(climb.elevationM.at(-1));
    expect(gradeAt(climb, 2000.5)).toBe(0);
    expect(curvatureAt(climb, 3000)).toBe(0);
    expect(pointAt(climb, 9000).y).toBeCloseTo(2000, 0);
    expect(gradeAt(climb, Number.NaN)).toBeCloseTo(gradeAt(climb, 0), 9);
  });

  it('positionAt: remaining distance and ascent, finished at the end', () => {
    const p = positionAt(climb, 500);
    expect(p).toMatchObject({ routeId: climb.id, name: 'Climb', lap: 1, finished: false });
    expect(p.remainingM).toBeCloseTo(1500, 0);
    expect(p.ascentRemainingM).toBeCloseTo(75, -1);
    expect(p.gradePercent).toBeCloseTo(5, 1);
    const f = positionAt(climb, 2500);
    expect(f).toMatchObject({
      finished: true,
      remainingM: 0,
      ascentRemainingM: 0,
      gradePercent: 0,
      lap: 1,
    });
    expect(f.distanceM).toBeCloseTo(climb.totalDistanceM, 6);
    expect(positionAt(climb, -10).distanceM).toBe(0);
  });

  it('lookahead past the finish continues flat and straight', () => {
    const la = lookahead(climb, 1900, 300, 31);
    expect(la.distanceM).toHaveLength(31);
    expect(la.distanceM.at(-1)).toBeCloseTo(300, 9);
    expect(la.elevationDeltaM[10]).toBeCloseTo(5, 0); // 100 m at 5 %
    expect(la.elevationDeltaM[30]).toBeCloseTo(la.elevationDeltaM[10]!, 0);
    expect(la.headingDeltaRad.every((h) => Math.abs(h) < 1e-6)).toBe(true);
    expect(la.forwardM.at(-1)).toBeCloseTo(300, 3);
    expect(la.rightM.at(-1)).toBeCloseTo(0, 3);
  });
});

describe('loop queries', () => {
  it('is detected as a loop and wraps every query', () => {
    expect(ring.loop).toBe(true);
    const T = ring.totalDistanceM;
    expect(T).toBeCloseTo(2 * Math.PI * 1000, -1);
    expect(elevationAt(ring, T + 100)).toBeCloseTo(elevationAt(ring, 100), 9);
    expect(pointAt(ring, T + 100).x).toBeCloseTo(pointAt(ring, 100).x, 6);
    expect(curvatureAt(ring, 1234)).toBeCloseTo(1 / 1000, 4);
    expect(curvatureAt(ring, T - 1)).toBeCloseTo(1 / 1000, 4); // also across the seam
  });

  it('headings keep counting turns across laps', () => {
    const T = ring.totalDistanceM;
    expect(headingAt(ring, T + 100) - headingAt(ring, 100)).toBeCloseTo(2 * Math.PI, 3);
    expect(headingAt(ring, T + 5) - headingAt(ring, T - 5)).toBeCloseTo(10 / 1000, 3);
  });

  it('positionAt counts laps', () => {
    const T = ring.totalDistanceM;
    const p = positionAt(ring, 2 * T + 300);
    expect(p.lap).toBe(3);
    expect(p.distanceM).toBeCloseTo(300, 6);
    expect(p.remainingM).toBeCloseTo(T - 300, 6);
    expect(p.finished).toBe(false);
    expect(positionAt(ring, T).lap).toBe(2);
  });

  it('lookahead bends right on a clockwise ring, through the lap seam', () => {
    const T = ring.totalDistanceM;
    const la = lookahead(ring, T - 100, 200, 21);
    expect(la.headingDeltaRad.at(-1)).toBeCloseTo(0.2, 2);
    expect(la.rightM.at(-1)).toBeGreaterThan(19);
    expect(la.curvature.every((k) => Math.abs(k - 0.001) < 1e-4)).toBe(true);
  });
});

describe('profile and outline', () => {
  it('profile has at most maxPoints values spanning the route', () => {
    const p = profile(climb, 50);
    expect(p).toHaveLength(50);
    expect(p[0]).toBeCloseTo(climb.elevationM[0]!, 6);
    expect(p.at(-1)).toBeCloseTo(climb.elevationM.at(-1)!, 6);
    expect(profile(climb, 1000)).toHaveLength(climb.count);
  });

  it('outline keeps shape within maxPoints', () => {
    const o = outline(ring, 40);
    expect(o.length).toBeLessThanOrEqual(40);
    expect(o.length).toBeGreaterThan(20);
    for (const [x, y] of o) expect(Math.hypot(x, y + 1000)).toBeCloseTo(1000, -1);
    // A straight line needs only its two ends.
    expect(outline(climb, 200).length).toBeLessThanOrEqual(200);
    expect(outline(climb, 5)).toHaveLength(2);
  });
});
