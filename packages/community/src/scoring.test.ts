import { describe, expect, it } from 'vitest';
import {
  POINTS_PER_RIDE_CAP,
  SCORING_VERSION,
  bestAverage,
  normalizedPower,
  pointsFor,
  rideFacts,
  validateRideFacts,
} from './scoring';
import { CET, HOUR, T0, facts, samples } from './testkit';

describe('rideFacts', () => {
  it('computes the hand-worked 1 h example', () => {
    // 1 h at a steady 200 W with FTP 250 at 10 m/s on a 5 % grade.
    const f = facts({ id: 'r1', start: T0, seconds: 3600, powerW: 200, gradePercent: 5 });
    expect(f).toMatchObject({
      rideId: 'r1',
      source: 'freilauf',
      scoringVersion: SCORING_VERSION,
      movingS: 3600,
      distanceM: 36_000,
      elevationGainM: 1800, // 36 km × 5 %
      energyKj: 720, // 200 W × 3600 s
      avgPowerW: 200,
      normalizedPowerW: 200,
      intensityFactor: 0.8,
      ftpW: 250,
      points: 64, // 1 h × 0.8² × 100
      avgSpeedMps: 10,
      groupRide: false,
      dayKey: '2026-11-18',
      weekKey: '2026-W47',
      monthKey: '2026-11',
    });
    expect(f.best).toEqual({ p5s: 200, p1m: 200, p5m: 200, p20m: 200 });
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.best)).toBe(true);
  });

  it('scores 45 min at FTP as 75 points and a hard hour above an easy one', () => {
    expect(facts({ id: 'a', start: T0, seconds: 2700, powerW: 250 }).points).toBe(75);
    const easy = facts({ id: 'b', start: T0, seconds: 3600, powerW: 150 }); // IF 0.6 → 36
    const hard = facts({ id: 'c', start: T0, seconds: 3600, powerW: 225 }); // IF 0.9 → 81
    expect([easy.points, hard.points]).toEqual([36, 81]);
  });

  it('is relative to FTP: equal relative effort scores equally', () => {
    const strong = facts({ id: 's', start: T0, seconds: 3600, powerW: 300, ftpW: 375 });
    const weak = facts({ id: 'w', start: T0, seconds: 3600, powerW: 160, ftpW: 200 });
    expect(strong.points).toBe(weak.points);
    expect(strong.points).toBe(64);
  });

  it('caps the intensity factor used for points at 1.3', () => {
    // FTP set far too low: IF 4.0 is used as 1.3 → 1 h × 1.69 × 100.
    const f = facts({ id: 'x', start: T0, seconds: 3600, powerW: 400, ftpW: 100 });
    expect(f.intensityFactor).toBe(4);
    expect(f.points).toBe(169);
  });

  it('caps points per ride at 400', () => {
    const f = facts({ id: 'long', start: T0, seconds: 6 * 3600, powerW: 250 }); // raw 600
    expect(f.points).toBe(POINTS_PER_RIDE_CAP);
    expect(pointsFor(6 * 3600, 1)).toBe(400);
    expect(pointsFor(3600, 1)).toBe(100);
    expect(pointsFor(3600, null)).toBe(0);
    expect(pointsFor(-5, 1)).toBe(0);
  });

  it('scores 0 without a plausible FTP', () => {
    for (const ftpW of [0, -1, Number.NaN, 5, 5000]) {
      const f = facts({ id: 'n', start: T0, seconds: 600, powerW: 200, ftpW });
      expect(f.points).toBe(0);
      expect(f.intensityFactor).toBeNull();
      expect(f.ftpW).toBeNull();
    }
  });

  it('computes normalised power with 30 s rolling averages', () => {
    // Reference: brute force.
    const power = Array.from({ length: 600 }, (_, i) => (Math.floor(i / 60) % 2 === 0 ? 100 : 300));
    let acc = 0;
    let n = 0;
    for (let i = 29; i < power.length; i++) {
      const w = power.slice(i - 29, i + 1);
      acc += (w.reduce((a, b) => a + b, 0) / 30) ** 4;
      n++;
    }
    expect(normalizedPower(power)).toBeCloseTo((acc / n) ** 0.25, 9);
    expect(normalizedPower(power)).toBeGreaterThan(200); // > average power
    expect(normalizedPower([100, 200])).toBe(150); // < 30 s: average
    expect(normalizedPower([])).toBe(0);
  });

  it('finds best efforts for 5 s / 1 min / 5 min / 20 min', () => {
    const f = facts({
      id: 'b',
      start: T0,
      seconds: 1800,
      powerW: (i) => (i >= 100 && i < 105 ? 800 : i >= 200 && i < 500 ? 300 : 150),
    });
    expect(f.best.p5s).toBe(800);
    expect(f.best.p1m).toBe(300); // 60 s inside the 300 W block beat the sprint window (204 W)
    expect(f.best.p5m).toBe(300);
    // 20 min window containing the 5 min block and the sprint.
    expect(f.best.p20m).toBe(190); // (300×300 + 5×800 + 895×150) / 1200
    expect(bestAverage([1, 2, 3], 5)).toBeNull();
    const short = facts({ id: 's', start: T0, seconds: 100, powerW: 100 });
    expect(short.best).toEqual({ p5s: 100, p1m: 100, p5m: null, p20m: null });
  });

  it('excludes pauses, caps sample gaps and ignores distance glitches', () => {
    const s = samples({ id: 'g', start: T0, seconds: 100, powerW: 100, gradePercent: 10 });
    // A 10-minute gap after sample 50 (resumed recording): contributes at most 5 s.
    const shifted = s.map((x, i) => (i > 50 ? { ...x, elapsedS: x.elapsedS + 600 } : x));
    // A distance glitch (jump of 5 km in one second) is ignored, the series continues after it.
    const glitched = shifted.map((x, i) => (i >= 80 ? { ...x, distanceM: x.distanceM + 5000 } : x));
    const f = rideFacts({ rideId: 'g', samples: glitched, ftpW: 250, utcOffsetMin: CET });
    expect(f?.movingS).toBe(99 + 5);
    expect(f?.energyKj).toBe(Math.round((104 * 100) / 1000));
    // 100 s × 10 m/s, minus the glitch step (10 m) and the gap step lost no distance (10 m in 5 s ok).
    expect(f?.distanceM).toBe(990);
    expect(f?.elevationGainM).toBe(99);
  });

  it('a jump along the route (position and altitude step, distance continuous) adds no climbing', () => {
    // A recorded route ride: 200 s at 10 m/s on 3 %; after 100 s the rider jumps 40 km ahead to
    // a point 500 m higher. The samples carry the new altitude, the ridden distance runs on.
    const s = samples({ id: 'j', start: T0, seconds: 200, powerW: 200, gradePercent: 3 }).map(
      (x, i) => ({
        ...x,
        altitudeM: i <= 100 ? 300 + i * 0.3 : 800 + (i - 100) * 0.3,
        lat: i <= 100 ? 47 : 47.4,
        lon: 11,
        segment: i <= 100 ? 0 : 1,
      }),
    );
    const f = rideFacts({ rideId: 'j', samples: s, ftpW: 250, utcOffsetMin: CET });
    expect(f?.distanceM).toBe(2000);
    // 2000 m ridden × 3 % = 60 m; the 500 m across the jump counts nothing.
    expect(f?.elevationGainM).toBe(60);
    expect(f).toEqual(
      rideFacts({
        rideId: 'j',
        samples: samples({ id: 'j', start: T0, seconds: 200, powerW: 200, gradePercent: 3 }),
        ftpW: 250,
        utcOffsetMin: CET,
      }),
    );
  });

  it('counts stopped samples as not moving and descents as no climbing', () => {
    const s = samples({
      id: 'z',
      start: T0,
      seconds: 120,
      powerW: 0,
      speedMps: 0,
      gradePercent: -5,
    });
    const f = rideFacts({ rideId: 'z', samples: s, ftpW: 250, utcOffsetMin: CET });
    expect(f).toMatchObject({
      movingS: 0,
      distanceM: 0,
      elevationGainM: 0,
      points: 0,
      avgSpeedMps: 0,
    });
  });

  it('places a late-evening ride on the local day, and flags group rides', () => {
    // 23:30 local (CET) = 22:30 UTC.
    const start = Date.UTC(2026, 10, 22, 22, 30);
    const f = facts({ id: 'late', start, seconds: 3600, powerW: 200, group: true });
    expect(f.dayKey).toBe('2026-11-22');
    expect(f.weekKey).toBe('2026-W47');
    expect(f.groupRide).toBe(true);
    // Same instant in UTC+2 is already Monday.
    expect(facts({ id: 'late2', start, seconds: 60, powerW: 200, offset: 120 }).weekKey).toBe(
      '2026-W48',
    );
  });

  it('survives garbage samples and refuses unplaceable rides', () => {
    const bad = [
      null,
      {
        timestamp: T0,
        elapsedS: 0,
        powerW: Number.NaN,
        speedMps: Infinity,
        distanceM: -5,
        gradePercent: 1e9,
      },
      {
        timestamp: T0 + 1000,
        elapsedS: 1,
        powerW: 1e9,
        speedMps: 5,
        distanceM: 5,
        gradePercent: 1e9,
      },
    ] as never[];
    const f = rideFacts({ rideId: 'x', samples: bad, ftpW: 250, utcOffsetMin: CET });
    expect(f?.avgPowerW).toBeLessThanOrEqual(2500);
    expect(f?.elevationGainM).toBe(4); // 10 m at the 40 % grade clamp
    expect(rideFacts({ rideId: '', samples: [], ftpW: 250, utcOffsetMin: 0 })).toBeNull();
    expect(rideFacts({ rideId: 'y', samples: [], ftpW: 250, utcOffsetMin: 0 })).toBeNull();
    expect(
      rideFacts({ rideId: 'y', startedAt: T0, samples: [], ftpW: 250, utcOffsetMin: 0 })?.movingS,
    ).toBe(0);
  });
});

describe('validateRideFacts', () => {
  const f = facts({ id: 'v', start: T0, seconds: 3600, powerW: 200 });

  it('round-trips through JSON', () => {
    expect(validateRideFacts(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it('rejects tampered or inconsistent facts', () => {
    const j = JSON.parse(JSON.stringify(f));
    for (const patch of [
      { points: 9999 },
      { movingS: -1 },
      { movingS: 1.5 },
      { dayKey: '2026-11-19' },
      { weekKey: '2026-W01' },
      { source: 'strava' },
      { scoringVersion: 0 },
      { best: { p5s: 'x', p1m: null, p5m: null, p20m: null } },
      { groupRide: 'yes' },
      { startedAt: Number.NaN },
    ]) {
      expect(validateRideFacts({ ...j, ...patch })).toBeNull();
    }
    expect(validateRideFacts(null)).toBeNull();
    expect(validateRideFacts([])).toBeNull();
  });

  it('marks backfilled facts and keeps the marker through storage', () => {
    const b = rideFacts({
      rideId: 'old',
      startedAt: T0,
      samples: samples({ id: 'old', start: T0, seconds: 600, powerW: 200 }),
      ftpW: 250,
      utcOffsetMin: CET,
      backfilled: true,
    });
    expect(b?.backfilled).toBe(true);
    expect(b?.groupRide).toBe(false);
    expect(validateRideFacts(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect('backfilled' in f).toBe(false);
    expect(validateRideFacts({ ...JSON.parse(JSON.stringify(f)), backfilled: 'yes' })).toBeNull();
    expect(validateRideFacts({ ...JSON.parse(JSON.stringify(f)), backfilled: false })).toBeNull();
  });

  it('keeps facts of a later scoring version as they are', () => {
    const j = { ...JSON.parse(JSON.stringify(f)), scoringVersion: 2, points: 77 };
    expect(validateRideFacts(j)?.points).toBe(77);
  });
});

it('uses an hour constant consistent with the formula', () => {
  expect(HOUR).toBe(3_600_000);
});
