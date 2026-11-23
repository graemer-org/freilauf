import { describe, expect, it } from 'vitest';
import { buildRoute } from './build';
import { unproject } from './geo';
import type { RawPoint } from './gpx';
import {
  FINISH_MARGIN_M,
  curvatureAt,
  elevationAt,
  gradeAt,
  headingAt,
  lookahead,
  normalizeRouteStart,
  outline,
  pointAt,
  positionAt,
  profile,
  routeBaseId,
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

describe('start point and jumps (route offset)', () => {
  it('the position is offset + ridden; remaining distance and ascent follow it', () => {
    const p = positionAt(climb, 200, 1000);
    expect(p.distanceM).toBeCloseTo(1200, 6);
    expect(p.remainingM).toBeCloseTo(800, 6);
    // 5 % over the 800 m left (smoothing rounds the top a little).
    expect(p.ascentRemainingM).toBeCloseTo(40, -1);
    expect(p.gradePercent).toBeCloseTo(5, 1);
    expect(p.elevationM).toBeCloseTo(160, 0);
    // Without an offset it is the plain ridden distance, as before.
    expect(positionAt(climb, 200, 0).distanceM).toBeCloseTo(200, 6);
    expect(positionAt(climb, 200).distanceM).toBeCloseTo(200, 6);
    // Non-finite offsets count as 0; the position never goes below the start.
    expect(positionAt(climb, 200, Number.NaN).distanceM).toBeCloseTo(200, 6);
    expect(positionAt(climb, 100, -500).distanceM).toBe(0);
  });

  it('a point-to-point route finishes after the rest of the road, not its whole length', () => {
    const p = positionAt(climb, 900, 1500);
    expect(p).toMatchObject({ finished: true, remainingM: 0, gradePercent: 0 });
    expect(positionAt(climb, 499, 1500).finished).toBe(false);
  });

  it('on a loop laps count from the start/finish line, whatever the start point', () => {
    const T = ring.totalDistanceM;
    const start = T - 400;
    const a = positionAt(ring, 300, start);
    expect(a.lap).toBe(1);
    expect(a.distanceM).toBeCloseTo(T - 100, 6);
    const b = positionAt(ring, 500, start); // crossed the line
    expect(b.lap).toBe(2);
    expect(b.distanceM).toBeCloseTo(100, 6);
    expect(b.remainingM).toBeCloseTo(T - 100, 6);
    expect(positionAt(ring, 400 + T, start).lap).toBe(3);
  });

  it('normalizeRouteStart wraps on a loop and stops short of the finish otherwise', () => {
    const T = ring.totalDistanceM;
    expect(normalizeRouteStart(ring, T + 250)).toBeCloseTo(250, 6);
    expect(normalizeRouteStart(ring, -250)).toBeCloseTo(T - 250, 6);
    expect(normalizeRouteStart(ring, T)).toBe(0);
    expect(normalizeRouteStart(climb, 1234)).toBe(1234);
    expect(normalizeRouteStart(climb, climb.totalDistanceM)).toBeCloseTo(
      climb.totalDistanceM - FINISH_MARGIN_M,
      6,
    );
    expect(normalizeRouteStart(climb, 1e9)).toBeCloseTo(climb.totalDistanceM - FINISH_MARGIN_M, 6);
    expect(normalizeRouteStart(climb, -5)).toBe(0);
    expect(normalizeRouteStart(climb, Number.NaN)).toBe(0);
    // A jump to the very end lands on the road: not finished, some road left.
    const end = positionAt(climb, 0, normalizeRouteStart(climb, climb.totalDistanceM));
    expect(end.finished).toBe(false);
    expect(end.remainingM).toBeCloseTo(FINISH_MARGIN_M, 6);
  });

  it('routeBaseId ignores the resolution suffix of a route shared at a coarser step', () => {
    expect(routeBaseId('a1b2c3d4-20m')).toBe('a1b2c3d4');
    expect(routeBaseId('a1b2c3d4')).toBe('a1b2c3d4');
    expect(routeBaseId('builtin-steady-climb')).toBe('builtin-steady-climb');
  });
});
