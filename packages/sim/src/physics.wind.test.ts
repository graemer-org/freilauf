/**
 * Wind in the bike physics (docs/adr/0012-historical-wind.md): the head/tail component at the
 * rider's height acts on the air speed; the trainer gets it scaled for the virtual gear.
 */
import type { SimulationParams } from '@freilauf/devices';
import { describe, expect, it } from 'vitest';
import { SoftwareShifter, effectiveSimulation } from './gearing';
import {
  DEFAULT_BIKE,
  MAX_HEADWIND_MPS,
  resistingForce,
  steadyStateSpeed,
  stepBike,
  windResistanceKgM,
} from './physics';

/** 20 km/h at 10 m, reduced to rider height in open terrain (× 0.65). */
const HEAD = (20 / 3.6) * 0.65;

describe('wind in the physics', () => {
  it('slows a headwind and speeds a tailwind at the same power', () => {
    const calm = steadyStateSpeed(200, 0, DEFAULT_BIKE);
    const head = steadyStateSpeed(200, 0, DEFAULT_BIKE, HEAD);
    const tail = steadyStateSpeed(200, 0, DEFAULT_BIKE, -HEAD);
    expect(head).toBeLessThan(calm);
    expect(tail).toBeGreaterThan(calm);
    // The numbers in the ADR: 34.3 → 26.6 km/h into, 42.9 km/h with it.
    expect(calm * 3.6).toBeCloseTo(34.3, 1);
    expect(head * 3.6).toBeCloseTo(26.6, 1);
    expect(tail * 3.6).toBeCloseTo(42.9, 1);
    // 10 km at 200 W: about five minutes longer into the wind.
    expect(10_000 / head - 10_000 / calm).toBeGreaterThan(280);
    expect(10_000 / head - 10_000 / calm).toBeLessThan(320);
    // Headwind costs more than the tailwind gives back (an out-and-back is slower).
    expect(10_000 / head + 10_000 / tail).toBeGreaterThan(20_000 / calm);
  });

  it('changes nothing without wind', () => {
    for (const v of [0, 3, 9.5]) {
      expect(resistingForce(v, 2, DEFAULT_BIKE, 0)).toBe(resistingForce(v, 2, DEFAULT_BIKE));
    }
    const a = stepBike(8, 250, 1, DEFAULT_BIKE, 1);
    const b = stepBike(8, 250, 1, DEFAULT_BIKE, 1, 0, 0);
    expect(b).toEqual(a);
  });

  it('acts on the air speed: a tailwind faster than the bike pushes, nothing at a standstill', () => {
    const k = windResistanceKgM(DEFAULT_BIKE);
    const rolling = DEFAULT_BIKE.totalMassKg * 9.80665 * DEFAULT_BIKE.crr;
    expect(resistingForce(2, 0, DEFAULT_BIKE, -5)).toBeCloseTo(rolling - k * 9, 6);
    expect(resistingForce(0, 0, DEFAULT_BIKE, 8)).toBe(0);
    // Coasting with a strong tailwind on the flat: the bike keeps rolling.
    expect(stepBike(3, 0, 0, DEFAULT_BIKE, 2, 0, -9).speedMps).toBeGreaterThan(3);
  });

  it('caps the wind at ± MAX_HEADWIND_MPS', () => {
    expect(resistingForce(8, 0, DEFAULT_BIKE, 50)).toBe(
      resistingForce(8, 0, DEFAULT_BIKE, MAX_HEADWIND_MPS),
    );
    expect(resistingForce(8, 0, DEFAULT_BIKE, Number.NaN)).toBe(resistingForce(8, 0, DEFAULT_BIKE));
  });
});

describe('wind for the trainer', () => {
  it('sends the head wind divided by the gear ratio over the physical one', () => {
    const plain = effectiveSimulation(2.4, 3, { bike: DEFAULT_BIKE, physicalRatio: 2.4 });
    expect(plain.windSpeedMps).toBe(0);
    const same = effectiveSimulation(2.4, 3, { bike: DEFAULT_BIKE, physicalRatio: 2.4 }, 4);
    expect(same.windSpeedMps).toBe(4);
    expect(same.gradePercent).toBe(plain.gradePercent);
    const high = effectiveSimulation(4.8, 0, { bike: DEFAULT_BIKE, physicalRatio: 2.4 }, 4);
    expect(high.windSpeedMps).toBe(2);
    expect(effectiveSimulation(2.4, 0, { bike: DEFAULT_BIKE }, -30).windSpeedMps).toBe(
      -MAX_HEADWIND_MPS,
    );
  });

  it('resyncs the trainer when the wind changes, not when it stays', async () => {
    const sent: SimulationParams[] = [];
    const s = new SoftwareShifter(async (p) => void sent.push(p), {
      bike: DEFAULT_BIKE,
      physicalRatio: 2.4,
    });
    s.setGear(s.gearCount); // any gear
    sent.length = 0;
    s.setHeadwind(3);
    s.setHeadwind(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.windSpeedMps).toBeCloseTo(3 / (s.ratio / 2.4), 2);
    s.setHeadwind(0);
    expect(sent.at(-1)!.windSpeedMps).toBe(0);
  });
});
