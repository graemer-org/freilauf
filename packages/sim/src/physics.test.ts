import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BIKE,
  MAX_BRAKE_DECEL_MPS2,
  resistingForce,
  steadyStateSpeed,
  stepBike,
} from './physics';

describe('physics', () => {
  it('gives a plausible flat speed for 200 W', () => {
    const kph = steadyStateSpeed(200, 0, DEFAULT_BIKE) * 3.6;
    expect(kph).toBeGreaterThan(30);
    expect(kph).toBeLessThan(36);
  });

  it('climbs slower and descends faster', () => {
    const flat = steadyStateSpeed(200, 0, DEFAULT_BIKE);
    expect(steadyStateSpeed(200, 8, DEFAULT_BIKE)).toBeLessThan(flat / 2);
    expect(steadyStateSpeed(200, -5, DEFAULT_BIKE)).toBeGreaterThan(flat * 1.4);
    expect(steadyStateSpeed(0, -5, DEFAULT_BIKE)).toBeGreaterThan(10);
    expect(steadyStateSpeed(0, 0, DEFAULT_BIKE)).toBe(0);
  });

  it('integration converges to the steady state and is step-size independent', () => {
    const run = (dt: number) => {
      let v = 0;
      let d = 0;
      for (let i = 0; i < Math.round(300 / dt); i++) {
        const s = stepBike(v, 250, 2, DEFAULT_BIKE, dt);
        v = s.speedMps;
        d += s.distanceM;
      }
      return { v, d };
    };
    const fine = run(0.1);
    const coarse = run(1);
    expect(fine.v).toBeCloseTo(steadyStateSpeed(250, 2, DEFAULT_BIKE), 2);
    expect(coarse.v).toBeCloseTo(fine.v, 2);
    expect(coarse.d).toBeCloseTo(fine.d, 0);
  });

  it('coasts down without power and never rolls backwards', () => {
    let v = 10;
    for (let i = 0; i < 600; i++) v = stepBike(v, 0, 5, DEFAULT_BIKE, 0.25).speedMps;
    expect(v).toBe(0);
    expect(stepBike(0, 0, 10, DEFAULT_BIKE, 1)).toEqual({ speedMps: 0, distanceM: 0 });
  });

  it('survives bad input', () => {
    expect(stepBike(5, Number.NaN, 0, DEFAULT_BIKE, 1).speedMps).toBeLessThan(5);
    expect(stepBike(5, 200, 0, DEFAULT_BIKE, -1)).toEqual({ speedMps: 5, distanceM: 0 });
    expect(stepBike(5, 200, 0, DEFAULT_BIKE, 3600).distanceM).toBeLessThan(100);
    expect(resistingForce(0, 0, DEFAULT_BIKE)).toBe(0);
  });

  describe('braking', () => {
    /** Rides from `kph` with `brake` applied until stopped (or 60 s), in 0.25 s steps. */
    const stop = (kph: number, brake: number, powerW = 0, grade = 0) => {
      let v = kph / 3.6;
      let d = 0;
      let t = 0;
      let minV = v;
      while (v > 0 && t < 60) {
        const s = stepBike(v, powerW, grade, DEFAULT_BIKE, 0.25, brake);
        v = s.speedMps;
        d += s.distanceM;
        t += 0.25;
        minV = Math.min(minV, v);
      }
      return { v, d, t, minV };
    };

    it('full brake stops from 30 km/h within a plausible distance and time', () => {
      const r = stop(30, 1);
      expect(r.v).toBe(0);
      // Pure braking alone would need v²/2a = 6.9 m; rolling and air drag shorten that a little.
      expect(r.d).toBeGreaterThan(5);
      expect(r.d).toBeLessThan(8);
      expect(r.t).toBeLessThanOrEqual(2);
      expect(MAX_BRAKE_DECEL_MPS2).toBe(5);
    });

    it('is proportional: half the brake takes about twice the distance', () => {
      const full = stop(30, 1).d;
      const half = stop(30, 0.5).d;
      expect(half / full).toBeGreaterThan(1.7);
      expect(half / full).toBeLessThan(2.1);
      // Much shorter than coasting, which takes far longer than 60 s from 30 km/h on the flat.
      expect(stop(30, 0).t).toBe(60);
    });

    it('never makes the speed negative, also while pedalling or on a climb', () => {
      expect(stop(30, 1, 0, 8).minV).toBe(0);
      expect(stepBike(0, 0, 0, DEFAULT_BIKE, 1, 1)).toEqual({ speedMps: 0, distanceM: 0 });
      // Pedalling hard against a full brake: the bike stays (nearly) still.
      let v = 8;
      for (let i = 0; i < 40; i++) {
        v = stepBike(v, 300, 0, DEFAULT_BIKE, 0.25, 1).speedMps;
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(v).toBeLessThan(1);
    });

    it('zero (or missing, or invalid) brake gives exactly the results from before', () => {
      for (const [v, p, g] of [
        [8, 200, 0],
        [3, 0, 5],
        [12, 350, -4],
      ] as const) {
        const before = stepBike(v, p, g, DEFAULT_BIKE, 0.25);
        expect(stepBike(v, p, g, DEFAULT_BIKE, 0.25, 0)).toEqual(before);
        expect(stepBike(v, p, g, DEFAULT_BIKE, 0.25, Number.NaN)).toEqual(before);
        expect(stepBike(v, p, g, DEFAULT_BIKE, 0.25, -1)).toEqual(before);
      }
      // Values above 1 are clamped to a full brake.
      expect(stepBike(8, 0, 0, DEFAULT_BIKE, 0.25, 5)).toEqual(
        stepBike(8, 0, 0, DEFAULT_BIKE, 0.25, 1),
      );
    });
  });
});
