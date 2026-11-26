import { describe, expect, it } from 'vitest';
import {
  GHOST_STEP_M,
  MAX_GHOST_POINTS,
  downsampleTrace,
  fullRouteTimeS,
  rideGhost,
  rideRouteInfo,
  timeAtDistance,
} from './ghost';
import type { RecordedRide, RideRoute, RideSample } from './types';

const START = Date.UTC(2026, 10, 1, 17);

/** A ride at a constant speed (m/s) along a route; `segmentAt(i)` for jumps. */
function ride(
  n: number,
  speed: number,
  route: RideRoute | undefined,
  segmentAt: (i: number) => number = () => 0,
): RecordedRide {
  const samples: RideSample[] = [];
  for (let i = 1; i <= n; i++) {
    const seg = segmentAt(i);
    samples.push({
      timestamp: START + i * 1000,
      elapsedS: i,
      powerW: 200,
      cadenceRpm: 90,
      heartRateBpm: null,
      speedMps: speed,
      distanceM: i * speed,
      gradePercent: 0,
      gear: 5,
      ...(seg > 0 ? { segment: seg } : {}),
    });
  }
  return {
    id: 'r',
    name: 'R',
    startedAt: START,
    riderMassKg: 75,
    samples,
    ...(route ? { route } : {}),
  };
}

const p2p = (offsetsM = [0]): RideRoute => ({
  id: 'route-a',
  lengthM: 1000,
  loop: false,
  offsetsM,
});
const loop = (offsetsM = [0]): RideRoute => ({ id: 'loop-a', lengthM: 1000, loop: true, offsetsM });

describe('downsampleTrace', () => {
  it('keeps a point every 5 m, the first and the last, and makes the trace monotone', () => {
    const pts = Array.from({ length: 101 }, (_, i) => ({ timeS: i, distanceM: i * 2 }));
    pts[50] = { timeS: 50, distanceM: 10 }; // a glitch backwards
    const t = downsampleTrace(pts);
    expect(t.distanceM[0]).toBe(0);
    expect(t.distanceM.at(-1)).toBe(200);
    for (let i = 1; i < t.distanceM.length; i++) {
      const gap = t.distanceM[i]! - t.distanceM[i - 1]!;
      if (i < t.distanceM.length - 1) expect(gap).toBeGreaterThanOrEqual(GHOST_STEP_M - 1e-9);
      else expect(gap).toBeGreaterThan(0);
      expect(t.timeS[i]!).toBeGreaterThanOrEqual(t.timeS[i - 1]!);
    }
  });

  it('bounds the size of very long rides', () => {
    const pts = Array.from({ length: 300_000 }, (_, i) => ({ timeS: i, distanceM: i * 9 }));
    const t = downsampleTrace(pts);
    expect(t.distanceM.length).toBeLessThanOrEqual(MAX_GHOST_POINTS);
    expect(t.distanceM.at(-1)).toBe(299_999 * 9);
  });
});

describe('timeAtDistance / fullRouteTimeS', () => {
  const pts = [
    { timeS: 0, distanceM: 0 },
    { timeS: 10, distanceM: 100 },
    { timeS: 30, distanceM: 200 },
  ];
  it('interpolates linearly and is null outside', () => {
    expect(timeAtDistance(pts, 150)).toBeCloseTo(20, 9);
    expect(timeAtDistance(pts, 250)).toBeNull();
  });
  it('point to point: start to finish only when both are covered', () => {
    expect(fullRouteTimeS(pts, { lengthM: 200, loop: false })).toBeCloseTo(30, 9);
    expect(fullRouteTimeS(pts, { lengthM: 300, loop: false })).toBeNull();
    expect(fullRouteTimeS(pts.slice(1), { lengthM: 200, loop: false })).toBeNull();
  });
  it('loop: the fastest full lap counted from the line', () => {
    const lapPts = [
      { timeS: 0, distanceM: 0 },
      { timeS: 100, distanceM: 1000 },
      { timeS: 180, distanceM: 2000 },
      { timeS: 200, distanceM: 2100 },
    ];
    expect(fullRouteTimeS(lapPts, { lengthM: 1000, loop: true })).toBeCloseTo(80, 9);
  });
});

describe('rideGhost', () => {
  it('a continuous ride along a point-to-point route: the whole route, ends at the finish', () => {
    const g = rideGhost(ride(150, 10, p2p()))!;
    expect(g.routeId).toBe('route-a');
    expect(g.fromM).toBe(0);
    expect(g.toM).toBe(1000); // past the finish the road is flat: not part of the route
    expect(g.fullTimeS).toBeCloseTo(100, 6);
    expect(g.parts).toBe(1);
    expect(
      timeAtDistance(
        g.trace.timeS.map((t, i) => ({ timeS: t, distanceM: g.trace.distanceM[i]! })),
        505,
      ),
    ).toBeCloseTo(50.5, 6);
  });

  it('a ride that started part-way: its part, but no full time', () => {
    const g = rideGhost(ride(40, 10, p2p([300])))!;
    expect(g.fromM).toBe(300);
    expect(g.toM).toBe(700);
    expect(g.fullTimeS).toBeNull();
  });

  it('a loop ridden for laps: continues across the line; the best lap counts', () => {
    const g = rideGhost(ride(250, 10, loop()))!;
    expect(g.toM).toBe(2500);
    expect(g.fullTimeS).toBeCloseTo(100, 6);
  });

  it('a ride with a jump: only the longest continuous part, never across the jump', () => {
    // 30 s from km 0 (300 m), then a jump to km 0.5 and 40 s more (400 m).
    const r = ride(70, 10, p2p([0, 500 - 300]), (i) => (i > 30 ? 1 : 0));
    const g = rideGhost(r)!;
    expect(g.parts).toBe(2);
    expect(g.fromM).toBeCloseTo(510, 6); // the first sample after the jump
    expect(g.toM).toBe(900);
    expect(g.fullTimeS).toBeNull();
    // Time keeps counting the ride's moving time: the part starts at 31 s.
    expect(g.trace.timeS[0]).toBe(31);
    expect(rideRouteInfo(r)).toMatchObject({ continuous: false, ghost: true, fullTimeS: null });
  });

  it('nothing for free rides, malformed route data or too short a part', () => {
    expect(rideGhost(ride(100, 10, undefined))).toBeNull();
    expect(rideGhost(ride(100, 10, { ...p2p(), lengthM: -1 }))).toBeNull();
    expect(rideGhost({ ...ride(100, 10, undefined), route: 'x' as never })).toBeNull();
    expect(rideGhost(ride(10, 10, p2p()))).toBeNull(); // 100 m
    expect(rideRouteInfo(ride(10, 10, p2p()))).toMatchObject({ ghost: false, fullTimeS: null });
  });
});
