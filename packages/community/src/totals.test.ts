import { describe, expect, it } from 'vitest';
import type { RideFacts } from './scoring';
import { DAY, HOUR, T0, facts } from './testkit';
import {
  aggregate,
  averageSpeedMps,
  bestEfforts,
  emptyLedger,
  ledgerAdd,
  ledgerFromFacts,
  ledgerRemove,
  ledgerTotals,
} from './totals';
import { seededRandom } from './util';

describe('aggregate', () => {
  const rides = [
    facts({ id: 'a', start: T0, seconds: 3600, powerW: 200, gradePercent: 2 }), // Wed W47
    facts({ id: 'b', start: T0 + DAY, seconds: 1800, powerW: 250, group: true }), // Thu W47
    facts({ id: 'c', start: T0 + 7 * DAY, seconds: 3600, powerW: 225 }), // Wed W48
  ];

  it('sums a week', () => {
    const t = aggregate(rides, '2026-W47');
    expect(t).toMatchObject({
      key: '2026-W47',
      rides: 2,
      movingS: 5400,
      distanceM: 54_000,
      elevationGainM: 720,
      energyKj: 720 + 450,
      points: 64 + 50,
      groupRides: 1,
      rideDays: 2,
    });
    expect(t.best.p20m).toBe(250);
    expect(averageSpeedMps(t)).toBe(10);
  });

  it('sums a month and keeps month best efforts', () => {
    const t = aggregate(rides, '2026-11');
    expect(t.rides).toBe(3);
    expect(t.points).toBe(64 + 50 + 81);
    expect(bestEfforts(rides, '2026-11')).toEqual({ p5s: 250, p1m: 250, p5m: 250, p20m: 250 });
    expect(aggregate(rides, '2026-10').rides).toBe(0);
  });

  it('caps points per day at 500', () => {
    const day = [
      facts({ id: 'x', start: T0, seconds: 6 * 3600, powerW: 250 }), // 400 (ride cap)
      facts({ id: 'y', start: T0 + 7 * HOUR, seconds: 3 * 3600, powerW: 250 }), // 300
      facts({ id: 'z', start: T0 + DAY, seconds: 3600, powerW: 250 }), // 100, next day
    ];
    const t = aggregate(day, '2026-W47');
    expect(t.points).toBe(500 + 100);
    expect(t.rideDays).toBe(2);
  });
});

describe('ledger', () => {
  it('adds, replaces and removes rides', () => {
    const a = facts({ id: 'a', start: T0, seconds: 3600, powerW: 200 });
    let l = ledgerAdd(emptyLedger(), a);
    expect(ledgerTotals(l, '2026-W47').points).toBe(64);
    // Replacing a ride by id does not double count.
    l = ledgerAdd(l, facts({ id: 'a', start: T0, seconds: 3600, powerW: 250 }));
    expect(ledgerTotals(l, '2026-W47')).toMatchObject({ rides: 1, points: 100 });
    l = ledgerRemove(l, 'a');
    expect(l.periods).toEqual({});
    expect(ledgerRemove(l, 'missing')).toBe(l);
  });

  it('recomputes best efforts after a removal', () => {
    const l = ledgerFromFacts([
      facts({ id: 'hi', start: T0, seconds: 1300, powerW: 300 }),
      facts({ id: 'lo', start: T0 + DAY, seconds: 1300, powerW: 200 }),
    ]);
    expect(ledgerTotals(l, '2026-11').best.p20m).toBe(300);
    expect(ledgerTotals(ledgerRemove(l, 'hi'), '2026-11').best.p20m).toBe(200);
  });

  it('matches a full recompute after random adds and deletes (property test)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rnd = seededRandom(seed);
      const pool: RideFacts[] = [];
      for (let i = 0; i < 40; i++) {
        pool.push(
          facts({
            id: `r${i}`,
            start: T0 + Math.floor(rnd() * 60) * DAY + Math.floor(rnd() * 24) * HOUR,
            seconds: 60 + Math.floor(rnd() * 3 * 3600),
            powerW: 80 + Math.floor(rnd() * 300),
            ftpW: 150 + Math.floor(rnd() * 200),
            gradePercent: Math.floor(rnd() * 8) - 2,
            offset: [60, 120, -300, 0, 330][Math.floor(rnd() * 5)] ?? 0,
            group: rnd() < 0.3,
          }),
        );
      }
      let ledger = emptyLedger();
      const live = new Map<string, RideFacts>();
      for (let step = 0; step < 120; step++) {
        const f = pool[Math.floor(rnd() * pool.length)] as RideFacts;
        if (live.has(f.rideId) && rnd() < 0.5) {
          ledger = ledgerRemove(ledger, f.rideId);
          live.delete(f.rideId);
        } else {
          ledger = ledgerAdd(ledger, f);
          live.set(f.rideId, f);
        }
      }
      const remaining = [...live.values()];
      const keys = new Set(pool.flatMap((f) => [f.weekKey, f.monthKey]));
      for (const key of keys) {
        expect(ledgerTotals(ledger, key)).toEqual(aggregate(remaining, key));
      }
      expect(ledger).toEqual(ledgerFromFacts(remaining));
    }
  });
});
