import { describe, expect, it } from 'vitest';
import { CrcCalculator } from '@garmin/fitsdk';
import { fitCrc } from './crc';

describe('fitCrc', () => {
  it('matches the CRC-16/ARC check value for "123456789"', () => {
    const bytes = new Uint8Array([...'123456789'].map((c) => c.charCodeAt(0)));
    expect(fitCrc(bytes)).toBe(0xbb3d);
  });

  it('is 0 for empty input and can be continued', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(fitCrc(new Uint8Array())).toBe(0);
    expect(fitCrc(bytes, 3, 6, fitCrc(bytes, 0, 3))).toBe(fitCrc(bytes));
  });

  it('agrees with the Garmin SDK', () => {
    const bytes = new Uint8Array(257).map((_, i) => (i * 37) & 0xff);
    expect(fitCrc(bytes)).toBe(CrcCalculator.calculateCRC(bytes, 0, bytes.length));
  });
});
