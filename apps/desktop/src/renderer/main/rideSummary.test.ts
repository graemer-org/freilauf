import { describe, expect, it } from 'vitest';
import type { RideFacts } from '@freilauf/community';
import type { RecordedRide } from '@freilauf/session';
import { summarizeRide } from './rideSummary';

function ride(id: string, watts: number[]): RecordedRide {
  return {
    id,
    name: 'Ride',
    startedAt: 0,
    riderMassKg: 75,
    samples: watts.map((powerW, i) => ({
      timestamp: i * 1000,
      elapsedS: i,
      powerW,
      cadenceRpm: 90,
      heartRateBpm: null,
      speedMps: 9,
      distanceM: i * 9,
      gradePercent: 0,
      gear: 12,
    })),
  };
}

function facts(rideId: string, best: Partial<RideFacts['best']>, points = 10): RideFacts {
  return {
    rideId,
    points,
    best: { p5s: null, p1m: null, p5m: null, p20m: null, ...best },
  } as RideFacts;
}

const base = { workoutName: null, routeName: null };

describe('summarizeRide', () => {
  it('takes time, distance and average power from the saved ride', () => {
    const s = summarizeRide({
      ...base,
      live: { elapsedS: 99, distanceM: 999 },
      ride: ride('r1', [100, 200, 300]),
      facts: facts('r1', {}, 7),
      previous: [],
    });
    expect(s).toMatchObject({ rideId: 'r1', durationS: 2, distanceM: 18, avgPowerW: 200 });
    expect(s.points).toBe(7);
    expect(s.bests).toEqual([]);
  });

  it('falls back to the live values for a ride that was not kept', () => {
    const s = summarizeRide({
      ...base,
      workoutName: 'Openers',
      live: { elapsedS: 6, distanceM: 40 },
      ride: null,
      facts: null,
      previous: [],
    });
    expect(s).toEqual({
      rideId: null,
      durationS: 6,
      distanceM: 40,
      avgPowerW: null,
      points: null,
      bests: [],
      workoutName: 'Openers',
      routeName: null,
      powerUpGainM: 0,
      energy: null,
    });
  });

  it('carries the power-up gain separately; distance stays the recorded one', () => {
    const s = summarizeRide({
      ...base,
      live: { elapsedS: 2, distanceM: 999 },
      ride: ride('r2', [200, 200]),
      facts: null,
      previous: [],
      powerUpGainM: 37.6,
    });
    expect(s.powerUpGainM).toBe(38);
    expect(s.distanceM).toBe(ride('r2', [200, 200]).samples.at(-1)!.distanceM);
    expect(
      summarizeRide({
        ...base,
        live: null,
        ride: null,
        facts: null,
        previous: [],
        powerUpGainM: Number.NaN,
      }).powerUpGainM,
    ).toBe(0);
  });

  it('reports only efforts that beat every earlier ride', () => {
    const s = summarizeRide({
      ...base,
      live: null,
      ride: ride('new', [250]),
      facts: facts('new', { p5s: 600, p1m: 380, p5m: 290, p20m: null }),
      previous: [
        facts('a', { p5s: 650, p1m: 300, p5m: null }),
        facts('b', { p5s: 500, p1m: 350, p5m: null }),
        facts('new', { p5s: 9999 }), // the ride itself never counts as "earlier"
      ],
    });
    expect(s.bests).toEqual([{ key: 'p1m', powerW: 380, previousW: 350 }]);
  });

  it('claims no personal bests on the first ride', () => {
    const s = summarizeRide({
      ...base,
      live: null,
      ride: ride('first', [250]),
      facts: facts('first', { p5s: 600 }),
      previous: [],
    });
    expect(s.bests).toEqual([]);
  });
});

describe('summarizeRide energy (docs/energy.md)', () => {
  const steady = (n: number, w: number, hr: number | null): RecordedRide => {
    const r = ride(
      'e1',
      Array.from({ length: n }, () => w),
    );
    r.samples = r.samples.map((s, i) => ({ ...s, elapsedS: i + 1, heartRateBpm: hr }));
    return r;
  };

  it('kcal from power, the heart-rate cross-check and the split', () => {
    // 1 h at 150 W = 540 kJ; FTP 300 stored with the ride → 70 % from fat.
    const r = { ...steady(3600, 150, 130), ftpW: 300 };
    const s = summarizeRide({
      ...base,
      live: null,
      ride: r,
      facts: null,
      previous: [],
      rider: { ageYears: 40, sex: 'male' },
    });
    const kcal = 540 / (4.184 * 0.24);
    expect(s.energy?.source).toBe('power');
    expect(s.energy?.kcal).toBeCloseTo(kcal, 6);
    expect(s.energy?.kcalPower).toBeCloseTo(kcal, 6);
    expect(s.energy?.kcalHr).toBeCloseTo(
      (60 * (-55.0969 + 0.6309 * 130 + 0.1988 * 75 + 0.2017 * 40)) / 4.184,
      6,
    );
    expect(s.energy?.fatG).toBeCloseTo((0.7 * kcal) / 9.4, 6);
    expect(s.energy?.carbG).toBeCloseTo((0.3 * kcal) / 4.1, 6);
  });

  it('no heart-rate estimate without age and sex; no split without FTP', () => {
    const s = summarizeRide({
      ...base,
      live: null,
      ride: steady(600, 200, 140),
      facts: null,
      previous: [],
      rider: { ageYears: null, sex: 'undisclosed' },
    });
    expect(s.energy?.kcal).toBeCloseTo(120 / 1.00416, 6);
    expect(s.energy?.kcalHr).toBeNull();
    expect(s.energy?.fatG).toBeNull();
    // The current FTP stands in for a ride recorded before rides stored it.
    const withFtp = summarizeRide({
      ...base,
      live: null,
      ride: steady(600, 200, 140),
      facts: null,
      previous: [],
      rider: { ftpW: 400 },
    });
    expect(withFtp.energy?.fatG).toBeCloseTo((0.7 * (120 / 1.00416)) / 9.4, 6);
  });

  it('heart rate only (no power): heart-rate kcal; neither: nothing', () => {
    const hrOnly = summarizeRide({
      ...base,
      live: null,
      ride: steady(600, 0, 140),
      facts: null,
      previous: [],
      rider: { ageYears: 30, sex: 'female' },
    });
    expect(hrOnly.energy?.source).toBe('heartRate');
    expect(hrOnly.energy?.kcalPower).toBeNull();
    expect(hrOnly.energy?.fatG).toBeNull();
    const none = summarizeRide({
      ...base,
      live: null,
      ride: steady(600, 0, null),
      facts: null,
      previous: [],
      rider: { ageYears: 30, sex: 'female' },
    });
    expect(none.energy).toBeNull();
  });
});
