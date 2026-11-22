import { describe, expect, it } from 'vitest';
import { parseHeartRateMeasurement } from './heartRate';
import { dataView } from './testing/fakeGatt';

describe('parseHeartRateMeasurement', () => {
  it('parses uint8 and uint16 formats', () => {
    expect(parseHeartRateMeasurement(dataView('00 48'))).toEqual({ bpm: 72 });
    expect(parseHeartRateMeasurement(dataView('01 2c 01'))).toEqual({ bpm: 300 });
  });

  it('parses contact status and RR intervals', () => {
    expect(parseHeartRateMeasurement(dataView('16 50 00 04 00 02'))).toEqual({
      bpm: 80,
      sensorContact: true,
      rrIntervalsS: [1, 0.5],
    });
    expect(parseHeartRateMeasurement(dataView('04 50'))).toEqual({ bpm: 80, sensorContact: false });
  });

  it('skips energy expended before RR intervals', () => {
    expect(parseHeartRateMeasurement(dataView('18 50 34 12 00 04'))).toEqual({
      bpm: 80,
      energyExpendedKj: 0x1234,
      rrIntervalsS: [1],
    });
  });

  it('handles truncated input', () => {
    expect(parseHeartRateMeasurement(dataView('01 2c'))).toBeNull();
    expect(parseHeartRateMeasurement(dataView(''))).toBeNull();
    expect(parseHeartRateMeasurement(dataView('18 50 34'))).toEqual({ bpm: 80 });
    // odd trailing RR byte is ignored
    expect(parseHeartRateMeasurement(dataView('10 50 00 04 00'))).toEqual({ bpm: 80, rrIntervalsS: [1] });
  });
});
