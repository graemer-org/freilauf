import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseGpx, prepareRoute } from '@freilauf/routes';
import { describe, expect, it } from 'vitest';
import {
  aheadGeometry,
  chooseMapCandidate,
  clientToBox,
  formatRouteKm,
  mapCandidates,
  pickPrompt,
  pickSteps,
  pointLabel,
  profilePointInfo,
  trackPointInfo,
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

describe('picking a point on the route (start point, jumps)', () => {
  it('words: the label and the confirmation for both modes', () => {
    expect(formatRouteKm(42_312)).toBe('km 42.3');
    expect(formatRouteKm(-3)).toBe('km 0.0');
    const label = pointLabel({ distanceM: 42_312, elevationM: 811.6, gradePercent: 3.06 });
    expect(label).toBe('km 42.3 · 812 m · +3.1 %');
    expect(pickPrompt('jump', label)).toEqual({
      text: 'Jump to km 42.3 · 812 m · +3.1 %',
      confirm: 'Jump',
    });
    expect(pickPrompt('start', label)).toEqual({
      text: 'Start at km 42.3 · 812 m · +3.1 %',
      confirm: 'Start here',
    });
  });

  it('keyboard steps are round and scale with what the profile shows', () => {
    expect(pickSteps(97_600)).toEqual({ small: 1000, large: 10_000 });
    expect(pickSteps(660)).toEqual({ small: 10, large: 100 });
    expect(pickSteps(12_000)).toEqual({ small: 200, large: 2000 });
    expect(pickSteps(0)).toEqual({ small: 10, large: 100 });
  });

  it('point info from the track and from a coarse profile', () => {
    const t = syntheticTrack([{ lengthM: 500 }, { lengthM: 500, gradePercent: 6 }], {});
    const flat = trackPointInfo(t, 200);
    expect(flat.gradePercent).toBeCloseTo(0, 1);
    const up = trackPointInfo(t, 800);
    expect(up.gradePercent).toBeCloseTo(6, 0);
    expect(up.elevationM).toBeGreaterThan(flat.elevationM);
    const coarse = profilePointInfo([100, 100, 130], 1000, 750);
    expect(coarse).toMatchObject({ distanceM: 750, elevationM: 115 });
    expect(coarse.gradePercent).toBeCloseTo(6, 6);
    expect(profilePointInfo([100, 100], 1000, 5000).distanceM).toBe(1000);
  });

  it('clientToBox undoes xMidYMid meet letterboxing', () => {
    const rect = { left: 10, top: 20, width: 200, height: 100 };
    expect(clientToBox(rect, 110, 70, 100, 100)).toEqual([50, 50]);
    expect(clientToBox(rect, 60, 20, 100, 100)).toEqual([0, 0]);
  });

  describe('on the real out-and-back fixture (isar-ursprung.gpx)', () => {
    const file = path.resolve(
      import.meta.dirname,
      '../../../../../../packages/routes/fixtures/isar-ursprung.gpx',
    );
    const parsed = parseGpx(readFileSync(file, 'utf8'));
    if (!parsed.ok) throw new Error('fixture did not parse');
    const prepared = prepareRoute(parsed.track);
    if (!prepared.ok) throw new Error('fixture did not prepare');
    const track = prepared.track;
    const total = track.totalDistanceM;
    const outline = trackOutline(track, 400);
    const fit = fitOutline(outline, { width: 100, height: 100, pad: 9 });
    const boxAt = (d: number): [number, number] => {
      const p = trackPosition(track, d);
      return fit.map(p.x, p.y);
    };

    it('is the 97.6 km out-and-back the maintainer rides', () => {
      expect(total / 1000).toBeCloseTo(97.6, 0);
      expect(track.loop).toBe(true); // ends where it started
    });

    it('a point on the shared road has one candidate per leg; the next one ahead is chosen', () => {
      const [x, y] = boxAt(20_000);
      const cands = mapCandidates(track, fit, x, y, 4);
      expect(cands.length).toBe(2);
      const legs = cands.map((c) => c.distanceM).sort((a, b) => a - b);
      expect(legs[0]).toBeGreaterThan(19_000);
      expect(legs[0]).toBeLessThan(21_000);
      // The return leg passes the same place at about 97.6 − 20 km.
      expect(legs[1]).toBeGreaterThan(total - 21_500);
      expect(legs[1]).toBeLessThan(total - 18_500);
      // Riding at km 10: the outbound leg is next. At km 30: the return leg is.
      expect(chooseMapCandidate(cands, 10_000, total, true)!.distanceM).toBe(legs[0]);
      expect(chooseMapCandidate(cands, 30_000, total, true)!.distanceM).toBe(legs[1]);
      // Past the return pass (km 85): on a loop the outbound leg of the next lap comes first.
      expect(chooseMapCandidate(cands, 85_000, total, true)!.distanceM).toBe(legs[0]);
      // Ridden as point to point from km 85: none ahead, the nearest behind.
      expect(chooseMapCandidate(cands, 85_000, total, false)!.distanceM).toBe(legs[1]);
    });

    it('the turnaround and a clear miss', () => {
      const far = trackPosition(track, total / 2);
      const [x, y] = fit.map(far.x, far.y);
      const turn = chooseMapCandidate(mapCandidates(track, fit, x, y, 4), 0, total, true);
      expect(Math.abs(turn!.distanceM - total / 2)).toBeLessThan(1500);
      expect(mapCandidates(track, fit, -50, -50, 4)).toEqual([]);
      expect(chooseMapCandidate([], 0, total, true)).toBeNull();
    });

    it('a pick on the profile maps the fraction to route distance and back to a label', () => {
      const d = 0.433 * total;
      const info = trackPointInfo(track, d);
      expect(info.distanceM).toBeCloseTo(d, 6);
      expect(pointLabel(info)).toMatch(/^km 42\.3 · \d+ m · [+−]?\d\.\d %$/);
    });
  });

  it('a single pass is the only candidate, and a closer pass beats a farther one', () => {
    expect(
      chooseMapCandidate(
        [
          { distanceM: 100, boxDistance: 0.5 },
          { distanceM: 900, boxDistance: 3.6 },
        ],
        500,
        1000,
        false,
      )!.distanceM,
    ).toBe(100);
  });
});
