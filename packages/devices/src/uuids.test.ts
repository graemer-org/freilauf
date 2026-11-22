import { describe, expect, it } from 'vitest';
import { FTMS_CONTROL_POINT, FTMS_SERVICE, HEART_RATE_MEASUREMENT, uuid16 } from './uuids';

describe('uuid16', () => {
  it('expands to the Bluetooth base UUID', () => {
    expect(uuid16(0x1826)).toBe('00001826-0000-1000-8000-00805f9b34fb');
    expect(FTMS_SERVICE).toBe('00001826-0000-1000-8000-00805f9b34fb');
    expect(FTMS_CONTROL_POINT).toBe('00002ad9-0000-1000-8000-00805f9b34fb');
    expect(HEART_RATE_MEASUREMENT).toBe('00002a37-0000-1000-8000-00805f9b34fb');
    expect(uuid16(0xabc)).toBe('00000abc-0000-1000-8000-00805f9b34fb');
  });

  it('rejects out-of-range values', () => {
    expect(() => uuid16(0x10000)).toThrow(RangeError);
    expect(() => uuid16(-1)).toThrow(RangeError);
  });
});
