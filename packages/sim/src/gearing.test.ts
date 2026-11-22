import type { SimulationParams } from '@freilauf/devices';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEAR_RATIOS,
  DEFAULT_PHYSICAL_RATIO,
  SoftwareShifter,
  effectiveSimulation,
} from './gearing';
import { DEFAULT_BIKE, GRAVITY, resistingForce, windResistanceKgM } from './physics';

const options = { bike: DEFAULT_BIKE };

/** What an ideal trainer does with simulation parameters at flywheel speed v. */
function trainerForce(p: SimulationParams, v: number, massKg: number): number {
  const theta = Math.atan(p.gradePercent / 100);
  return (
    massKg * GRAVITY * (Math.sin(theta) + p.crr * Math.cos(theta)) + p.windResistanceKgM * v * v
  );
}

describe('effectiveSimulation', () => {
  it('passes the road through unchanged in the physical gear', () => {
    const p = effectiveSimulation(DEFAULT_PHYSICAL_RATIO, 3, options);
    expect(p.gradePercent).toBeCloseTo(3, 6);
    expect(p.crr).toBeCloseTo(DEFAULT_BIKE.crr, 6);
    expect(p.windResistanceKgM).toBeCloseTo(windResistanceKgM(DEFAULT_BIKE), 6);
  });

  it.each([
    [0.75, 8],
    [1.53, 4],
    [3.24, 0],
    [4.24, -2],
    [5.49, 1],
  ])('matches crank torque of the virtual bike (ratio %f, grade %f%%)', (ratio, grade) => {
    const r = ratio / DEFAULT_PHYSICAL_RATIO;
    const p = effectiveSimulation(ratio, grade, options);
    for (const cadenceSpeed of [3, 6, 9]) {
      // Same cadence: trainer flywheel at v_t, virtual bike at r·v_t. Same power required.
      const trainerPower = trainerForce(p, cadenceSpeed, DEFAULT_BIKE.totalMassKg) * cadenceSpeed;
      const virtualSpeed = r * cadenceSpeed;
      const virtualPower = resistingForce(virtualSpeed, grade, DEFAULT_BIKE) * virtualSpeed;
      // Small-angle approximation + field clamping allow a few percent.
      expect(Math.abs(trainerPower - virtualPower)).toBeLessThan(
        Math.max(3, Math.abs(virtualPower) * 0.03),
      );
    }
  });

  it('harder gears feel harder, monotonically', () => {
    const grades = DEFAULT_GEAR_RATIOS.map((r) => effectiveSimulation(r, 2, options).gradePercent);
    for (let i = 1; i < grades.length; i++) expect(grades[i]!).toBeGreaterThan(grades[i - 1]!);
  });

  it('stays within FTMS field limits and the configured grade clamp', () => {
    const p = effectiveSimulation(5.49, 20, options);
    expect(p.gradePercent).toBe(25);
    expect(p.crr).toBeLessThanOrEqual(0.0254);
    expect(p.windResistanceKgM).toBeLessThanOrEqual(2.54);
    expect(effectiveSimulation(5.49, -20, options).gradePercent).toBe(-15);
  });

  it('compensates for a trainer that assumes a different mass', () => {
    const p = effectiveSimulation(DEFAULT_PHYSICAL_RATIO, 5, { ...options, trainerMassKg: 100 });
    const force = trainerForce(p, 0, 100);
    expect(force).toBeCloseTo(DEFAULT_BIKE.totalMassKg * GRAVITY * (0.05 + DEFAULT_BIKE.crr), 0);
  });
});

describe('SoftwareShifter', () => {
  function setup() {
    const sent: SimulationParams[] = [];
    const shifter = new SoftwareShifter(async (p) => void sent.push(p), options);
    return { sent, shifter };
  }

  it('starts in a middle gear and clamps at both ends', () => {
    const { shifter } = setup();
    expect(shifter.gearCount).toBe(24);
    expect(shifter.gear).toBe(12);
    expect(shifter.shift(100)).toBe(24);
    expect(shifter.shift(1)).toBe(24);
    expect(shifter.shift(-100)).toBe(1);
    expect(shifter.ratio).toBe(0.75);
  });

  it('sends new parameters on every shift and gradient change, and emits the gear', () => {
    const { sent, shifter } = setup();
    const gears: number[] = [];
    shifter.onGear((g) => gears.push(g));
    shifter.shift(1);
    shifter.setGradient(4);
    shifter.setGradient(4); // unchanged → no write
    shifter.shift(-1);
    expect(gears).toEqual([13, 12]);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.gradePercent).toBeCloseTo(4, 6);
    shifter.shift(-1);
    expect(sent[3]!.gradePercent).toBeLessThan(sent[2]!.gradePercent);
  });

  it('does not write when already at the limit', () => {
    const { sent, shifter } = setup();
    shifter.setGear(24);
    const n = sent.length;
    shifter.shift(1);
    expect(sent).toHaveLength(n);
  });

  it('reports write failures instead of throwing', async () => {
    const errors: unknown[] = [];
    const shifter = new SoftwareShifter(() => Promise.reject(new Error('gone')), options);
    shifter.onError((e) => errors.push(e));
    expect(() => shifter.shift(1)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });

  it('resync re-sends the current state', () => {
    const { sent, shifter } = setup();
    shifter.setGradient(2);
    shifter.resync();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });
});
