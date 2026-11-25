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
