import { describe, expect, it } from 'vitest';
import { DEFAULT_BIKE, resistingForce, steadyStateSpeed, stepBike } from './physics';

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
});
