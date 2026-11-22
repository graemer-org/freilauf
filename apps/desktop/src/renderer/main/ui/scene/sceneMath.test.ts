import { describe, expect, it } from 'vitest';
import {
  GRADE_EXAGGERATION,
  LATERAL_MAX_RATE,
  MAX_VISUAL_SLOPE,
  ProfileHistory,
  SCENE_GROUP_RANGE_M,
  WHEEL_RADIUS_M,
  crankRate,
  describeScene,
  easeToward,
  formatGrade,
  groupOffset,
  hash01,
  integrateAngle,
  leanFor,
  parallaxOffset,
  placeRiders,
  profileRange,
  standingTarget,
  steeringInput,
  stepLateral,
  tuckTarget,
  valueNoise,
  visualAngle,
  visualSlope,
  wheelRate,
} from './sceneMath';

const deg = (rad: number): number => (rad * 180) / Math.PI;

describe('easeToward', () => {
  it('closes 63 % of the gap per time constant, independent of frame rate', () => {
    expect(easeToward(0, 10, 1, 1)).toBeCloseTo(10 * (1 - Math.exp(-1)), 6);
    let a = 0;
    for (let i = 0; i < 60; i++) a = easeToward(a, 10, 1 / 60, 1);
    let b = 0;
    for (let i = 0; i < 144; i++) b = easeToward(b, 10, 1 / 144, 1);
    expect(a).toBeCloseTo(b, 6);
  });

  it('jumps with tau 0, holds with dt 0, recovers from NaN', () => {
    expect(easeToward(3, 7, 0.016, 0)).toBe(7);
    expect(easeToward(3, 7, 0, 1)).toBe(3);
    expect(easeToward(Number.NaN, 7, 0.016, 1)).toBe(7);
  });

  it('never overshoots', () => {
    expect(easeToward(0, 1, 100, 0.1)).toBeLessThanOrEqual(1);
  });
});

describe('gradient exaggeration', () => {
  it('makes 3 % clearly visible', () => {
    expect(deg(visualAngle(3))).toBeGreaterThan(4.5);
    expect(deg(visualAngle(3))).toBeLessThan(6);
  });

  it('is near-linear for small gradients and odd-symmetric', () => {
    expect(visualSlope(1)).toBeCloseTo(0.01 * GRADE_EXAGGERATION, 3);
    expect(visualSlope(-6)).toBeCloseTo(-visualSlope(6), 12);
    expect(visualSlope(0)).toBe(0);
  });

  it('is monotonic and bounded so a wall does not look absurd', () => {
    let prev = -Infinity;
    for (let g = -20; g <= 25; g += 0.5) {
      const s = visualSlope(g);
      expect(s).toBeGreaterThan(prev);
      expect(Math.abs(s)).toBeLessThan(MAX_VISUAL_SLOPE);
      prev = s;
    }
    expect(deg(visualAngle(15))).toBeLessThan(18);
    expect(deg(visualAngle(15))).toBeGreaterThan(12);
  });

  it('treats non-finite input as flat', () => {
    expect(visualSlope(Number.NaN)).toBe(0);
  });

  it('formats the slope label with a sign and one decimal', () => {
    expect(formatGrade(4.5)).toBe('+4.5 %');
    expect(formatGrade(-2)).toBe('−2.0 %');
    expect(formatGrade(0.02)).toBe('0.0 %');
  });
});

describe('wheel and crank integration', () => {
  it('turns the wheel once per circumference travelled', () => {
    const circumference = 2 * Math.PI * WHEEL_RADIUS_M;
    // 1 s at a speed of one circumference per second = one full turn.
    let a = 0;
    for (let i = 0; i < 60; i++) a = integrateAngle(a, wheelRate(circumference), 1 / 60);
    expect(Math.min(a, 2 * Math.PI - a)).toBeCloseTo(0, 6);
    expect(wheelRate(-3)).toBe(0);
  });

  it('turns the cranks at cadence and stops at 0 rpm', () => {
    expect(crankRate(60)).toBeCloseTo(2 * Math.PI, 9);
    expect(integrateAngle(1, crankRate(0), 1)).toBe(1);
  });

  it('wraps into [0, 2π) both ways', () => {
    expect(integrateAngle(6, 1, 1)).toBeCloseTo(7 - 2 * Math.PI, 9);
    const back = integrateAngle(0.5, -1, 1);
    expect(back).toBeGreaterThanOrEqual(0);
    expect(back).toBeCloseTo(2 * Math.PI - 0.5, 9);
  });
});

describe('parallax', () => {
  it('derives offsets from distance only, slower for far layers', () => {
    expect(parallaxOffset(100, 1, 7)).toBeCloseTo(100 % 7, 9);
    expect(parallaxOffset(100, 0.1, 1000)).toBeCloseTo(10, 9);
    expect(parallaxOffset(-1, 1, 5)).toBeCloseTo(4, 9);
  });

  it('hash and noise are deterministic, seeded and in range', () => {
    expect(hash01(42, 1)).toBe(hash01(42, 1));
    expect(hash01(42, 1)).not.toBe(hash01(42, 2));
    for (let i = -50; i < 50; i++) {
      const h = hash01(i, 3);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      const n = valueNoise(i * 0.37, 9);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
    expect(valueNoise(12.25, 4)).toBe(valueNoise(12.25, 4));
    // Continuous: tiny steps give tiny changes.
    expect(Math.abs(valueNoise(3.5, 1) - valueNoise(3.5001, 1))).toBeLessThan(1e-3);
  });
});

describe('ProfileHistory', () => {
  it('integrates elevation from distance and gradient', () => {
    const h = new ProfileHistory(100, 5);
    h.add(0, 5);
    for (let d = 1; d <= 100; d++) h.add(d, 5);
    expect(h.currentElevationM).toBeCloseTo(5, 6);
    expect(h.currentDistanceM).toBe(100);
    expect(h.length).toBe(21); // 0, 5, …, 100
    expect(h.distAt(0)).toBe(0);
    expect(h.elevAt(h.length - 1)).toBeCloseTo(5, 6);
    expect(h.climbedM()).toBeCloseTo(5, 6);
  });

  it('uses the trapezoid rule across a gradient change', () => {
    const h = new ProfileHistory();
    h.add(0, 0);
    h.add(10, 10);
    expect(h.currentElevationM).toBeCloseTo(0.5, 9);
  });

  it('stays bounded and keeps the newest points', () => {
    const h = new ProfileHistory(50, 5);
    for (let d = 0; d <= 5000; d += 2.5) h.add(d, d > 2500 ? -3 : 3);
    expect(h.length).toBe(50);
    expect(h.distAt(h.length - 1)).toBe(5000);
    expect(h.distAt(0)).toBe(5000 - 49 * 5);
    for (let i = 1; i < h.length; i++) expect(h.distAt(i)).toBeGreaterThan(h.distAt(i - 1));
  });

  it('restarts when the distance goes back (a new ride) and ignores junk', () => {
    const h = new ProfileHistory();
    for (let d = 0; d <= 200; d += 10) h.add(d, 4);
    h.add(Number.NaN, 4);
    expect(h.currentDistanceM).toBe(200);
    h.add(0, 0);
    expect(h.length).toBe(1);
    expect(h.currentElevationM).toBe(0);
  });

  it('does not count descents as climbing', () => {
    const h = new ProfileHistory();
    for (let d = 0; d <= 100; d += 5) h.add(d, 4);
    for (let d = 105; d <= 200; d += 5) h.add(d, -4);
    expect(h.climbedM()).toBeCloseTo(4, 6);
    // 100 m up at 4 %, a 5 m transition at 0 % mean, 95 m down at 4 %.
    expect(h.currentElevationM).toBeCloseTo(0.2, 6);
  });

  it('plots flat roads flat (minimum vertical span)', () => {
    const r = profileRange(10, 10.5);
    expect(r.max - r.min).toBeGreaterThanOrEqual(24);
    expect((r.max + r.min) / 2).toBeCloseTo(10.25, 9);
    const big = profileRange(0, 100);
    expect(big.min).toBeLessThan(0);
    expect(big.max).toBeGreaterThan(100);
  });
});

describe('lateral steering', () => {
  const run = (input: number, seconds: number, speed = 8, start = 0) => {
    const s = { pos: start, vel: 0 };
    for (let i = 0; i < seconds * 60; i++) stepLateral(s, input, 1 / 60, speed);
    return s;
  };

  it('drifts while steering and holds the line when released', () => {
    const s = run(1, 0.5);
    expect(s.pos).toBeGreaterThan(0.2);
    for (let i = 0; i < 120; i++) stepLateral(s, 0, 1 / 60, 8);
    const held = s.pos;
    for (let i = 0; i < 60; i++) stepLateral(s, 0, 1 / 60, 8);
    expect(s.pos).toBeCloseTo(held, 3);
  });

  it('eases in instead of jumping', () => {
    const s = { pos: 0, vel: 0 };
    stepLateral(s, 1, 1 / 60, 8);
    expect(s.vel).toBeLessThan(LATERAL_MAX_RATE * 0.2);
  });

  it('stops at the lane edges', () => {
    expect(run(1, 10).pos).toBe(1);
    const left = run(-1, 10);
    expect(left.pos).toBe(-1);
    expect(left.vel).toBe(0);
  });

  it('does not move a stationary bike; instant mode skips easing', () => {
    expect(run(1, 2, 0).pos).toBe(0);
    const s = { pos: 0, vel: 0 };
    stepLateral(s, -1, 0.1, 8, true);
    expect(s.vel).toBe(-LATERAL_MAX_RATE);
  });

  it('combines paddles and keys, treating undefined paddles as 0', () => {
    expect(steeringInput(undefined, false, false)).toBe(0);
    expect(steeringInput(undefined, true, false)).toBe(-1);
    expect(steeringInput(0.4, false, true)).toBe(1);
    expect(steeringInput(-0.3, false, false)).toBe(-0.3);
    expect(steeringInput(Number.NaN, false, true)).toBe(1);
  });

  it('leans into the drift, bounded', () => {
    expect(leanFor(0)).toBe(0);
    expect(leanFor(0.5)).toBeGreaterThan(0);
    expect(leanFor(-50)).toBe(-0.2);
  });
});

describe('posture', () => {
  it('stands on steep climbs at low cadence only while pedalling', () => {
    expect(standingTarget(9, 60, true)).toBe(1);
    expect(standingTarget(9, 90, true)).toBe(0);
    expect(standingTarget(3, 60, true)).toBe(0);
    expect(standingTarget(9, 60, false)).toBe(0);
    expect(standingTarget(9, 0, true)).toBe(0);
  });

  it('tucks at high speed or when coasting downhill', () => {
    expect(tuckTarget(8, 0, 90)).toBe(0);
    expect(tuckTarget(16, 0, 90)).toBe(1);
    expect(tuckTarget(13, 0, 90)).toBeCloseTo(0.5, 9);
    expect(tuckTarget(9, -5, 0)).toBe(1);
  });
});

describe('group placement', () => {
  const rider = (peerId: string, gapM: number) => ({
    peerId,
    name: peerId,
    gapM,
    speedMps: 8,
    cadenceRpm: 85,
    stale: false,
  });

  it('compresses gaps monotonically into (−1, 1)', () => {
    let prev = -Infinity;
    for (let g = -300; g <= 300; g += 5) {
      const o = groupOffset(g);
      expect(o).toBeGreaterThan(prev);
      expect(Math.abs(o)).toBeLessThan(1);
      prev = o;
    }
    expect(groupOffset(0)).toBe(0);
    expect(groupOffset(100)).toBeGreaterThan(0.9);
    expect(groupOffset(Number.NaN)).toBe(0);
  });

  it('puts riders within range on the road, others only on the profile', () => {
    const placed = placeRiders([
      rider('near', 10),
      rider('far', 250),
      rider('edge', -SCENE_GROUP_RANGE_M),
      rider('bad', Number.NaN),
    ]);
    expect(placed.map((p) => p.id)).toEqual(['far', 'edge', 'near']);
    expect(placed.find((p) => p.id === 'near')?.onRoad).toBe(true);
    expect(placed.find((p) => p.id === 'edge')?.onRoad).toBe(true);
    expect(placed.find((p) => p.id === 'far')?.onRoad).toBe(false);
    expect(placed.find((p) => p.id === 'near')?.offset).toBeGreaterThan(0);
  });
});

describe('describeScene', () => {
  it('states gradient, speed and cadence in words', () => {
    expect(describeScene('riding', 4.5, 8.33, 88.4)).toBe(
      'Climbing at 4.5 percent, 30 kilometres per hour, cadence 88 rpm.',
    );
    expect(describeScene('paused', -2, 0, 0)).toBe(
      'Paused. Descending at 2.0 percent, 0 kilometres per hour, cadence 0 rpm.',
    );
    expect(describeScene('idle', 0, 0, 0)).toMatch(/^Ride not started\. Flat road/);
  });
});
