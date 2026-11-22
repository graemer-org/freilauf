import type { Uuid } from './types';

/** Expands a 16-bit SIG-assigned number to the full Bluetooth base UUID (lowercase). */
export function uuid16(n: number): Uuid {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new RangeError(`uuid16: ${n} is not a 16-bit value`);
  }
  return `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

export const FTMS_SERVICE = uuid16(0x1826);
export const FTMS_INDOOR_BIKE_DATA = uuid16(0x2ad2);
export const FTMS_CONTROL_POINT = uuid16(0x2ad9);
export const FTMS_STATUS = uuid16(0x2ada);
export const FTMS_FEATURE = uuid16(0x2acc);

export const CYCLING_POWER_SERVICE = uuid16(0x1818);
export const CYCLING_POWER_MEASUREMENT = uuid16(0x2a63);

export const HEART_RATE_SERVICE = uuid16(0x180d);
export const HEART_RATE_MEASUREMENT = uuid16(0x2a37);

export const BATTERY_SERVICE = uuid16(0x180f);
export const BATTERY_LEVEL = uuid16(0x2a19);
