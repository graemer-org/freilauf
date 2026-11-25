import { describe, expect, it } from 'vitest';
import {
  CARB_KCAL_PER_G,
  EnergyAccumulator,
  FAT_FRACTION_CURVE,
  FAT_KCAL_PER_G,
  KCAL_PER_KJ_WORK,
  energyOfSamples,
  fatFractionAtFtp,
  fatFractionAtVo2,
  kcalFromWorkKj,
  keytelKcalPerMin,
  rideEnergy,
} from './energy';
import type { RideSample } from './types';

const sample = (i: number, powerW: number, heartRateBpm: number | null = null) => ({
  elapsedS: i + 1,
  powerW,
  heartRateBpm,
});
const steady = (n: number, powerW: number, hr: number | null = null) =>
  Array.from({ length: n }, (_, i) => sample(i, powerW, hr));

describe('power → kcal', () => {
  it('is work / (4.184 × 0.24)', () => {
    expect(KCAL_PER_KJ_WORK).toBeCloseTo(0.995857, 6);
    // 1000 kJ / 1.00416 = 995.857 kcal
    expect(kcalFromWorkKj(1000)).toBeCloseTo(995.857, 3);
    expect(kcalFromWorkKj(0)).toBe(0);
    expect(kcalFromWorkKj(-5)).toBe(0);
    expect(kcalFromWorkKj(Number.NaN)).toBe(0);
  });

  it('one hour at 200 W is 720 kJ ≈ 717 kcal', () => {
    const e = energyOfSamples(steady(3600, 200), { massKg: 75 });
    expect(e.kcalPower).toBeCloseTo(720 / 1.00416, 6);
    expect(e.kcal).toBe(e.kcalPower);
    expect(e.source).toBe('power');
    // No age/sex: no heart-rate estimate. No FTP: no split.
    expect(e.kcalHr).toBeNull();
    expect(e.fatG).toBeNull();
    expect(e.carbG).toBeNull();
  });
});

describe('Keytel et al. (2005), without VO2max', () => {
  it('men: (−55.0969 + 0.6309·HR + 0.1988·W + 0.2017·A) / 4.184', () => {
    // HR 140, 75 kg, 40 y: −55.0969 + 88.326 + 14.91 + 8.068 = 56.2071 kJ/min
    expect(keytelKcalPerMin(140, 75, 40, 'male')).toBeCloseTo(56.2071 / 4.184, 6);
    expect(keytelKcalPerMin(140, 75, 40, 'male')).toBeCloseTo(13.4338, 3);
  });

  it('women: (−20.4022 + 0.4472·HR − 0.1263·W + 0.074·A) / 4.184', () => {
    // HR 140, 60 kg, 30 y: −20.4022 + 62.608 − 7.578 + 2.22 = 36.8478 kJ/min
    expect(keytelKcalPerMin(140, 60, 30, 'female')).toBeCloseTo(36.8478 / 4.184, 6);
    expect(keytelKcalPerMin(140, 60, 30, 'female')).toBeCloseTo(8.8068, 3);
  });

  it('clamps negative values to 0', () => {
    // HR 40, 50 kg, 20 y (men): −55.0969 + 25.236 + 9.94 + 4.034 < 0
    expect(keytelKcalPerMin(40, 50, 20, 'male')).toBe(0);
  });

  it('needs heart rate, mass, age and a sex of female/male', () => {
    expect(keytelKcalPerMin(null, 75, 40, 'male')).toBeNull();
    expect(keytelKcalPerMin(0, 75, 40, 'male')).toBeNull();
    expect(keytelKcalPerMin(140, 75, null, 'male')).toBeNull();
    expect(keytelKcalPerMin(140, 75, 40, 'undisclosed')).toBeNull();
    expect(keytelKcalPerMin(140, 75, 40, null)).toBeNull();
    expect(keytelKcalPerMin(140, Number.NaN, 40, 'female')).toBeNull();
  });

  it('integrates per second and skips samples without heart rate', () => {
    const profile = { massKg: 75, ageYears: 40, sex: 'male' };
    const withGaps = Array.from({ length: 120 }, (_, i) => sample(i, 200, i < 60 ? 140 : null));
    const e = energyOfSamples(withGaps, profile);
    // 60 s with HR 140 = one minute at 13.4338 kcal/min; the other minute adds nothing.
    expect(e.kcalHr).toBeCloseTo(56.2071 / 4.184, 6);
    expect(energyOfSamples(steady(60, 200, null), profile).kcalHr).toBeNull();
  });
});

describe('fat share of energy', () => {
  it('stays within bounds and never rises with intensity', () => {
    let prev = Infinity;
    for (let x = 0; x <= 150; x += 0.5) {
      const f = fatFractionAtVo2(x);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(0.85);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
    expect(fatFractionAtVo2(Number.NaN)).toBe(FAT_FRACTION_CURVE[0]![1]);
  });

  it('crosses over (50 %) at moderate intensity and is ~0 above threshold', () => {
    // Crossover between 55 and 65 % VO2max: 0.55 → 0.40, so 0.5 at 58.3 %.
    expect(fatFractionAtVo2(55)).toBeGreaterThan(0.5);
    expect(fatFractionAtVo2(60)).toBeLessThan(0.5);
    // %VO2max = 0.8 × %FTP: 50 % FTP → 40 % VO2max, FTP → 80 %, 112.5 % FTP → 90 %.
    expect(fatFractionAtFtp(0.5)).toBeCloseTo(0.7, 9);
    expect(fatFractionAtFtp(1)).toBeCloseTo(0.125, 9);
    expect(fatFractionAtFtp(1.125)).toBe(0);
    expect(fatFractionAtFtp(2)).toBe(0);
    expect(fatFractionAtFtp(0)).toBe(0.85);
  });
});

describe('integration over a ride', () => {
  it('10 min at 50 % FTP: 70 % of the energy from fat', () => {
    const e = energyOfSamples(steady(600, 150), { massKg: 75, ftpW: 300 });
    const kcal = 90 / 1.00416; // 90 kJ
    expect(e.kcalPower).toBeCloseTo(kcal, 6);
    expect(e.fatKcal).toBeCloseTo(0.7 * kcal, 6);
    expect(e.fatG).toBeCloseTo((0.7 * kcal) / FAT_KCAL_PER_G, 6);
    expect(e.carbG).toBeCloseTo((0.3 * kcal) / CARB_KCAL_PER_G, 6);
    expect(e.fatG).toBeCloseTo(6.674, 3);
    expect(e.carbG).toBeCloseTo(6.558, 3);
  });

  it('a harder ride burns more carbohydrate and less fat', () => {
    const easy = energyOfSamples(steady(1800, 150), { massKg: 75, ftpW: 250 });
    const hard = energyOfSamples(steady(1800, 250), { massKg: 75, ftpW: 250 });
    expect(hard.carbG!).toBeGreaterThan(easy.carbG!);
    expect(hard.fatG!).toBeLessThan(easy.fatG!);
  });

  it('uses the 30 s trailing mean, so a one-second sprint barely moves the split', () => {
    const base = steady(120, 150);
    const sprint = base.map((s, i) => (i === 60 ? { ...s, powerW: 900 } : s));
    const a = energyOfSamples(base, { massKg: 75, ftpW: 300 });
    const b = energyOfSamples(sprint, { massKg: 75, ftpW: 300 });
    // The extra 750 J are mostly fat-free; nothing else changes much.
    expect(b.fatKcal! - a.fatKcal!).toBeGreaterThan(0);
    expect(b.fatKcal! - a.fatKcal!).toBeLessThan(kcalFromWorkKj(0.75) * 0.7);
  });

  it('falls back to heart rate when the ride has no power, and shows nothing without either', () => {
    const profile = { massKg: 75, ageYears: 40, sex: 'male', ftpW: 250 };
    const hrOnly = energyOfSamples(steady(60, 0, 140), profile);
    expect(hrOnly.source).toBe('heartRate');
    expect(hrOnly.kcalPower).toBeNull();
    expect(hrOnly.kcal).toBeCloseTo(13.4338, 3);
    expect(hrOnly.fatG).toBeNull();
    const nothing = energyOfSamples(steady(60, 0, null), profile);
    expect(nothing).toEqual({
      kcal: null,
      source: null,
      kcalPower: null,
      kcalHr: null,
      fatKcal: null,
      fatG: null,
      carbG: null,
    });
  });

  it('the accumulator fed live equals the recomputation, and gaps count at most 5 s', () => {
    const samples: Pick<RideSample, 'elapsedS' | 'powerW' | 'heartRateBpm'>[] = [];
    const acc = new EnergyAccumulator({ massKg: 70, ageYears: 35, sex: 'female', ftpW: 220 });
    let prev = 0;
    for (let i = 0; i < 900; i++) {
      const elapsedS = i === 500 ? prev + 30 : prev + 1; // one 30 s gap
      const s = { elapsedS, powerW: 100 + ((i * 37) % 200), heartRateBpm: 110 + (i % 40) };
      acc.add({ powerW: s.powerW, heartRateBpm: s.heartRateBpm, dtS: elapsedS - prev });
      samples.push(s);
      prev = elapsedS;
    }
    const recomputed = rideEnergy(
      { riderMassKg: 70, ftpW: 220, samples },
      { ageYears: 35, sex: 'female' },
    );
    expect(acc.totals()).toEqual(recomputed);
    const work = samples.reduce((a, s, i) => a + s.powerW * (i === 500 ? 5 : 1), 0) / 1000;
    expect(recomputed.kcalPower).toBeCloseTo(kcalFromWorkKj(work), 9);
    expect(recomputed.fatKcal! + recomputed.carbG! * CARB_KCAL_PER_G).toBeCloseTo(
      recomputed.kcalPower!,
      9,
    );
  });

  it("rideEnergy prefers the ride's FTP over the current one", () => {
    const ride = { riderMassKg: 75, ftpW: 300, samples: steady(600, 150) };
    expect(rideEnergy(ride, { ftpW: 150 }).fatKcal).toBeCloseTo(0.7 * (90 / 1.00416), 6);
    const { ftpW: _, ...old } = ride;
    expect(rideEnergy(old).fatKcal).toBeNull();
    expect(rideEnergy(old, { ftpW: 300 }).fatKcal).toBeCloseTo(0.7 * (90 / 1.00416), 6);
  });
});
