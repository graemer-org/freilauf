import { describe, expect, it } from 'vitest';
import {
  createTrackPoint,
  curvatureAt,
  elevationAt,
  gradeAt,
  gradeSigns,
  headingAt,
  lapTurn,
  nextSign,
  routeDistance,
  sampleTrack,
  turnAhead,
} from './routeSample';
import { syntheticTrack } from './testTrack';

describe('sampleTrack', () => {
  const track = syntheticTrack([
    { lengthM: 100, gradePercent: 5 },
    { lengthM: 100, turnDeg: 90 },
  ]);

  it('interpolates between samples', () => {
    expect(elevationAt(track, 0)).toBe(100);
    expect(elevationAt(track, 15)).toBeCloseTo(100.75, 9);
    expect(gradeAt(track, 20, 20)).toBeCloseTo(5, 9);
    expect(headingAt(track, 150)).toBeCloseTo(Math.PI / 4, 9);
  });

  it('extends a point-to-point route straight and level beyond its ends', () => {
    const end = sampleTrack(track, track.totalDistanceM, createTrackPoint());
    const past = sampleTrack(track, track.totalDistanceM + 50, createTrackPoint());
    expect(past.elevationM).toBe(end.elevationM);
    expect(past.x - end.x).toBeCloseTo(50 * Math.sin(end.headingRad), 9);
    expect(past.y - end.y).toBeCloseTo(50 * Math.cos(end.headingRad), 9);
    expect(elevationAt(track, -20)).toBe(100);
  });

  it('wraps a loop and keeps the heading continuous across the lap', () => {
    const loop = syntheticTrack([{ lengthM: 400, turnDeg: 360 }], { loop: true });
    expect(lapTurn(loop)).toBeCloseTo(2 * Math.PI, 9);
    const before = headingAt(loop, loop.totalDistanceM - 1);
    const after = headingAt(loop, loop.totalDistanceM + 1);
    expect(after - before).toBeCloseTo((2 * Math.PI * 2) / 400, 6);
    expect(routeDistance(loop, loop.totalDistanceM + 30)).toBeCloseTo(30, 9);
    expect(routeDistance(track, 1e6)).toBe(track.totalDistanceM);
  });

  it('measures turns and curvature (+ right)', () => {
    expect(turnAhead(track, 100, 100)).toBeCloseTo(Math.PI / 2, 9);
    expect(curvatureAt(track, 150, 20)).toBeCloseTo(Math.PI / 2 / 100, 9);
    expect(curvatureAt(track, 50, 20)).toBe(0);
  });

  it('copes with degenerate input', () => {
    const p = sampleTrack({ ...track, count: 0, elevationM: [] }, 10, createTrackPoint());
    expect(p.elevationM).toBe(0);
    expect(Number.isFinite(elevationAt(track, Number.NaN))).toBe(true);
  });
});

describe('gradient signs', () => {
  const track = syntheticTrack([
    { lengthM: 500 },
    { lengthM: 600, gradePercent: 8 },
    { lengthM: 500 },
  ]);
  const signs = gradeSigns(track);

  it('marks the foot of a climb and where it levels off', () => {
    expect(signs.length).toBe(2);
    expect(Math.abs(signs[0]!.atM - 500)).toBeLessThanOrEqual(50);
    expect(signs[0]!.gradePercent).toBeGreaterThan(5);
    expect(Math.abs(signs[1]!.atM - 1100)).toBeLessThanOrEqual(50);
    expect(Math.abs(signs[1]!.gradePercent)).toBeLessThan(3);
  });

  it('finds the next sign ahead and how far away it is', () => {
    const next = nextSign(track, signs, 300);
    expect(next?.atM).toBe(signs[0]!.atM);
    expect(next?.inM).toBeCloseTo(signs[0]!.atM - 300, 9);
    expect(nextSign(track, signs, 300, 100)).toBeNull();
    expect(nextSign(track, signs, 1500)).toBeNull();
  });

  it('finds nothing on a flat road', () => {
    expect(gradeSigns(syntheticTrack([{ lengthM: 2000 }]))).toEqual([]);
  });
});
