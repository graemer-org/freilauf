import { describe, expect, it } from 'vitest';
import { CadenceFromCrankRevs, parseCyclingPowerMeasurement } from './cyclingPower';
import { dataView } from './testing/fakeGatt';

describe('parseCyclingPowerMeasurement', () => {
  it('parses power only', () => {
    expect(parseCyclingPowerMeasurement(dataView('00 00 c8 00'))).toEqual({ flags: 0, powerW: 200 });
  });

  it('parses crank revolution data', () => {
    expect(parseCyclingPowerMeasurement(dataView('20 00 c8 00 0a 00 00 04'))).toEqual({
      flags: 0x20,
      powerW: 200,
      crank: { cumulativeRevs: 10, lastEventTime1024: 1024 },
    });
  });

  it('skips balance, torque and wheel data before crank data', () => {
    // flags 0x0035: balance, accumulated torque, wheel, crank
    const m = parseCyclingPowerMeasurement(dataView('35 00 2c 01 64 10 00 01 00 00 00 00 08 05 00 00 02'));
    expect(m).toEqual({
      flags: 0x35,
      powerW: 300,
      pedalPowerBalancePercent: 50,
      wheel: { cumulativeRevs: 1, lastEventTime2048: 2048 },
      crank: { cumulativeRevs: 5, lastEventTime1024: 512 },
    });
  });

  it('ignores trailing optional fields after crank data', () => {
    // crank + extreme force magnitudes + accumulated energy
    const m = parseCyclingPowerMeasurement(dataView('60 08 64 00 03 00 00 01 10 00 f0 ff 07 00'));
    expect(m?.crank).toEqual({ cumulativeRevs: 3, lastEventTime1024: 256 });
  });

  it('handles negative power and truncated input', () => {
    expect(parseCyclingPowerMeasurement(dataView('00 00 ff ff'))?.powerW).toBe(-1);
    expect(parseCyclingPowerMeasurement(dataView('20 00 c8 00 0a 00 00'))).toEqual({ flags: 0x20, powerW: 200 });
    expect(parseCyclingPowerMeasurement(dataView('20 00 c8'))).toBeNull();
  });
});

describe('CadenceFromCrankRevs', () => {
  it('derives rpm from successive events', () => {
    const c = new CadenceFromCrankRevs();
    expect(c.update({ cumulativeRevs: 10, lastEventTime1024: 0 }, 0)).toBeUndefined();
    // 1 rev in 0.75 s → 80 rpm
    expect(c.update({ cumulativeRevs: 11, lastEventTime1024: 768 }, 750)).toBeCloseTo(80);
    // 2 revs in 1.5 s → 80 rpm
    expect(c.update({ cumulativeRevs: 13, lastEventTime1024: 2304 }, 2250)).toBeCloseTo(80);
  });

  it('handles uint16 wraparound of both counters', () => {
    const c = new CadenceFromCrankRevs();
    c.update({ cumulativeRevs: 0xffff, lastEventTime1024: 0xfc00 }, 0);
    // 2 revs, 2048 ticks = 2 s → 60 rpm
    expect(c.update({ cumulativeRevs: 0x0001, lastEventTime1024: 0x0400 }, 2000)).toBeCloseTo(60);
  });

  it('holds the value without new events, then decays to 0 after ~3 s', () => {
    const c = new CadenceFromCrankRevs();
    c.update({ cumulativeRevs: 1, lastEventTime1024: 0 }, 0);
    expect(c.update({ cumulativeRevs: 2, lastEventTime1024: 683 }, 667)).toBeCloseTo(90, 0);
    const same = { cumulativeRevs: 2, lastEventTime1024: 683 };
    expect(c.update(same, 1667)).toBeCloseTo(90, 0);
    expect(c.update(same, 3600)).toBeCloseTo(90, 0);
    expect(c.update(same, 3700)).toBe(0);
    expect(c.current(10_000)).toBe(0);
    // pedalling resumes
    expect(c.update({ cumulativeRevs: 3, lastEventTime1024: 683 + 1024 }, 10_500)).toBeCloseTo(60);
  });

  it('reset() forgets history', () => {
    const c = new CadenceFromCrankRevs();
    c.update({ cumulativeRevs: 1, lastEventTime1024: 0 }, 0);
    c.update({ cumulativeRevs: 2, lastEventTime1024: 1024 }, 1000);
    c.reset();
    expect(c.current(1000)).toBeUndefined();
  });
});
