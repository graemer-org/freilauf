import { describe, expect, it } from 'vitest';
import { SpeedFromWheelRevs, parseCscMeasurement } from './cyclingSpeedCadence';
import { dataView } from './testing/fakeGatt';

describe('parseCscMeasurement', () => {
  it('parses wheel and crank data', () => {
    expect(parseCscMeasurement(dataView('03 0a 00 00 00 00 04 05 00 00 08'))).toEqual({
      flags: 3,
      wheel: { cumulativeRevs: 10, lastEventTime1024: 0x400 },
      crank: { cumulativeRevs: 5, lastEventTime1024: 0x800 },
    });
  });

  it('stops at the first truncated field', () => {
    expect(parseCscMeasurement(dataView(''))).toBeNull();
    expect(parseCscMeasurement(dataView('03 0a 00 00'))).toEqual({ flags: 3 });
    expect(parseCscMeasurement(dataView('03 0a 00 00 00 00 04 05 00'))).toEqual({
      flags: 3,
      wheel: { cumulativeRevs: 10, lastEventTime1024: 0x400 },
    });
  });
});

describe('SpeedFromWheelRevs', () => {
  it('derives speed, handles wrap, holds and decays', () => {
    const s = new SpeedFromWheelRevs({ circumferenceM: 2, staleAfterMs: 1000 });
    expect(s.update({ cumulativeRevs: 0xffffffff, lastEventTime1024: 0xfc00 }, 0)).toBeUndefined();
    // 5 turns × 2 m in 1 s (0xfc00 → 0x0000 wraps) = 10 m/s
    expect(s.update({ cumulativeRevs: 4, lastEventTime1024: 0x0000 }, 1000)).toBe(10);
    expect(s.update({ cumulativeRevs: 4, lastEventTime1024: 0x0000 }, 1500)).toBe(10);
    expect(s.update({ cumulativeRevs: 4, lastEventTime1024: 0x0000 }, 2500)).toBe(0);
  });
});
