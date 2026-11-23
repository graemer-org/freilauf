import { describe, expect, it } from 'vitest';
import {
  aheadGeometry,
  fitOutline,
  formatClimb,
  formatGradient,
  formatKm,
  gradeBand,
  plotRange,
  profileElevationAt,
  profileGeometry,
  routeImageLabel,
  routeProgress,
  routeSummary,
  steepestGradient,
  trackOutline,
  trackPosition,
  trackProfile,
} from './routeView';
import { syntheticTrack } from './scene/testTrack';

describe('words', () => {
  it('formats distances, climbing and gradients', () => {
    expect(formatKm(12_400)).toBe('12.4 km');
    expect(formatKm(850)).toBe('850 m');
    expect(formatKm(-5)).toBe('0 m');
    expect(formatKm(Number.NaN)).toBe('–');
    expect(formatKm(123_456)).toBe('123 km');
    expect(formatClimb(519.6)).toBe('520 m');
    expect(formatGradient(4.46)).toBe('+4.5 %');
    expect(formatGradient(-2)).toBe('−2.0 %');
    expect(formatGradient(0.01)).toBe('0.0 %');
  });

  it('summarises a route in one line and in words', () => {
    const e = { name: 'Hills', totalDistanceM: 42_300, ascentM: 520, descentM: 510, loop: true };
    expect(routeSummary(e)).toBe('42.3 km · ↑ 520 m · ↓ 510 m · Loop');
    expect(routeSummary({ ...e, loop: false })).toContain('Point to point');
    expect(routeImageLabel(e)).toBe(
      'Hills: loop of 42.3 km, 520 m of climbing and 510 m of descending.',
    );
  });
});

describe('gradient bands', () => {
  it('steps from descent to wall', () => {
    expect(gradeBand(-6)).toBe('down');
    expect(gradeBand(0)).toBe('flat');
    expect(gradeBand(3)).toBe('gentle');
    expect(gradeBand(6)).toBe('moderate');
    expect(gradeBand(9)).toBe('steep');
    expect(gradeBand(14)).toBe('wall');
    expect(gradeBand(Number.NaN)).toBe('flat');
  });
});

describe('profile geometry', () => {
  it('plots flat routes flat, with a minimum span', () => {
    expect(plotRange([100, 100], 30)).toEqual({ lo: 85, hi: 115 });
    expect(plotRange([], 10)).toEqual({ lo: 0, hi: 10 });
    const g = profileGeometry([100, 100, 100], { width: 100, height: 50, padTop: 0 });
    expect(g.line).toBe('M0 25L50 25L100 25');
    expect(g.area.endsWith('L100 50 L0 50 Z')).toBe(true);
  });

  it('puts higher points higher', () => {
    const g = profileGeometry([0, 100], { width: 10, height: 100, padTop: 0 });
    expect(g.y(100)).toBeLessThan(g.y(0));
    expect(g.y(0)).toBe(100);
    expect(g.y(100)).toBe(0);
  });

  it('reads an evenly spaced profile at a distance and finds its steepest part', () => {
    const profile = [0, 0, 10, 30, 30];
    expect(profileElevationAt(profile, 400, 250)).toBe(20);
    expect(profileElevationAt(profile, 400, 9999)).toBe(30);
    expect(steepestGradient(profile, 400, 100)).toBe(20);
    expect(steepestGradient(profile, 400_000, 100)).toBeNull();
    expect(steepestGradient([1, 2], 100)).toBeNull();
  });

  it('samples a track evenly', () => {
    const track = syntheticTrack([{ lengthM: 1000, gradePercent: 5 }]);
    const p = trackProfile(track, 11);
    expect(p).toHaveLength(11);
    expect(p[0]).toBe(100);
    expect(p[10]).toBeCloseTo(150, 9);
  });
});

describe('the road ahead', () => {
  const track = syntheticTrack([
    { lengthM: 500 },
    { lengthM: 500, gradePercent: 9 },
    { lengthM: 500 },
  ]);

  it('colours chunks by gradient on a fixed grid and labels the steepest', () => {
    const g = aheadGeometry(track, 400, { width: 600, height: 100 });
    expect(g.chunks.some((c) => c.band === 'steep')).toBe(true);
    expect(g.chunks[0]!.band).toBe('flat');
    expect(g.steepest?.grade).toBeCloseTo(9, 6);
    expect(g.riderX).toBeCloseTo((60 / 660) * 600, 6);
    const later = aheadGeometry(track, 410, { width: 600, height: 100 });
    // Chunk edges are on the 25 m grid: the second chunk starts at 350 m in both.
    expect(later.chunks.length).toBeGreaterThan(10);
  });

  it('has no steepest label on the flat', () => {
    const flat = syntheticTrack([{ lengthM: 2000 }]);
    expect(aheadGeometry(flat, 500, { width: 600, height: 100 }).steepest).toBeNull();
  });
});

describe('outline and map', () => {
  it('fits north up, keeping the aspect', () => {
    const fit = fitOutline(
      [
        [0, 0],
        [100, 0],
        [100, 50],
      ],
      { width: 100, height: 100, pad: 0 },
    );
    expect(fit.map(0, 0)).toEqual([0, 75]);
    expect(fit.map(100, 50)).toEqual([100, 25]);
    expect(fit.path).toBe('M0 75L100 75L100 25');
    expect(fitOutline([], { width: 10, height: 10 }).path).toBe('');
  });

  it('decimates a track outline and keeps its end', () => {
    const track = syntheticTrack([{ lengthM: 5000, turnDeg: 90 }]);
    const o = trackOutline(track, 50);
    expect(o.length).toBeLessThanOrEqual(52);
    expect(o[o.length - 1]).toEqual([track.x[track.count - 1], track.y[track.count - 1]]);
  });

  it('places the rider and measures progress (per lap on a loop)', () => {
    const track = syntheticTrack([{ lengthM: 1000 }]);
    const p = trackPosition(track, 500);
    expect(p.y).toBeCloseTo(500, 6);
    expect(p.headingRad).toBe(0);
    expect(routeProgress(1000, 250, false)).toBe(0.25);
    expect(routeProgress(1000, 1250, true)).toBe(0.25);
    expect(routeProgress(1000, 1250, false)).toBe(1);
    expect(routeProgress(0, 10, false)).toBe(0);
  });
});
