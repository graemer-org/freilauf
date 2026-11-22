import { describe, expect, it } from 'vitest';
import {
  encodePause,
  encodeRequestControl,
  encodeReset,
  encodeSetIndoorBikeSimulation,
  encodeSetTargetPower,
  encodeSetTargetResistance,
  encodeStart,
  encodeStop,
  parseControlPointResponse,
  parseIndoorBikeData,
} from './ftms';
import { dataView, toHex } from './testing/fakeGatt';

describe('parseIndoorBikeData', () => {
  it('parses a KICKR-style speed + cadence + power packet', () => {
    // flags 0x0044: speed (More Data clear), cadence, power
    const d = parseIndoorBikeData(dataView('44 00 b8 0b b4 00 fa 00'));
    expect(d).toEqual({ flags: 0x44, speedKph: 30, cadenceRpm: 90, powerW: 250 });
  });

  it('parses every field when all flags are set', () => {
    const d = parseIndoorBikeData(
      dataView(
        'fe 1f' + // flags 0x1FFE
          ' c4 09' + // speed 25.00
          ' 60 09' + // avg speed 24.00
          ' aa 00' + // cadence 85
          ' a0 00' + // avg cadence 80
          ' 39 30 00' + // distance 12345 m
          ' 14 00' + // resistance 20
          ' d2 00' + // power 210
          ' c8 00' + // avg power 200
          ' 64 00 58 02 0a' + // energy 100 kcal, 600 kcal/h, 10 kcal/min
          ' 8c' + // HR 140
          ' 2d' + // MET 4.5
          ' 10 0e' + // elapsed 3600 s
          ' 3c 00', // remaining 60 s
      ),
    );
    expect(d).toEqual({
      flags: 0x1ffe,
      speedKph: 25,
      averageSpeedKph: 24,
      cadenceRpm: 85,
      averageCadenceRpm: 80,
      distanceM: 12345,
      resistanceLevel: 20,
      powerW: 210,
      averagePowerW: 200,
      totalEnergyKcal: 100,
      energyPerHourKcal: 600,
      energyPerMinuteKcal: 10,
      heartRateBpm: 140,
      metabolicEquivalent: 4.5,
      elapsedS: 3600,
      remainingS: 60,
    });
  });

  it('omits speed when More Data is set', () => {
    expect(parseIndoorBikeData(dataView('41 00 64 00'))).toEqual({ flags: 0x41, powerW: 100 });
  });

  it('parses negative power and resistance (sint16)', () => {
    expect(parseIndoorBikeData(dataView('61 00 fb ff f6 ff'))).toEqual({
      flags: 0x61,
      resistanceLevel: -5,
      powerW: -10,
    });
  });

  it('keeps field offsets right past distance (uint24) and energy (5 bytes)', () => {
    // flags 0x0950: speed, distance, power, expended energy, elapsed time
    const d = parseIndoorBikeData(dataView('50 09 e8 03 01 00 00 96 00 ff ff ff ff ff 05 00'));
    expect(d).toEqual({ flags: 0x950, speedKph: 10, distanceM: 1, powerW: 150, elapsedS: 5 });
  });

  it('returns the complete prefix for truncated packets', () => {
    expect(parseIndoorBikeData(dataView('44 00 b8 0b b4'))).toEqual({ flags: 0x44, speedKph: 30 });
    expect(parseIndoorBikeData(dataView('44 00'))).toEqual({ flags: 0x44 });
  });

  it('returns null when flags are missing', () => {
    expect(parseIndoorBikeData(dataView('44'))).toBeNull();
    expect(parseIndoorBikeData(dataView(''))).toBeNull();
  });

  it('respects the DataView byte offset', () => {
    const buf = Uint8Array.of(0xaa, 0xaa, 0x44, 0x00, 0xb8, 0x0b, 0xb4, 0x00, 0xfa, 0x00);
    const d = parseIndoorBikeData(new DataView(buf.buffer, 2));
    expect(d?.powerW).toBe(250);
  });
});

describe('control point encoders', () => {
  it('encodes simple commands', () => {
    expect(toHex(encodeRequestControl())).toBe('00');
    expect(toHex(encodeReset())).toBe('01');
    expect(toHex(encodeStart())).toBe('07');
    expect(toHex(encodeStop())).toBe('08 01');
    expect(toHex(encodePause())).toBe('08 02');
  });

  it('encodes target power as sint16 and clamps', () => {
    expect(toHex(encodeSetTargetPower(250))).toBe('05 fa 00');
    expect(toHex(encodeSetTargetPower(-5))).toBe('05 fb ff');
    expect(toHex(encodeSetTargetPower(1e6))).toBe('05 ff 7f');
    expect(toHex(encodeSetTargetPower(249.6))).toBe('05 fa 00');
  });

  it('encodes target resistance (uint8, 0.1) and clamps', () => {
    expect(toHex(encodeSetTargetResistance(5))).toBe('04 32');
    expect(toHex(encodeSetTargetResistance(100))).toBe('04 ff');
    expect(toHex(encodeSetTargetResistance(-1))).toBe('04 00');
  });

  it('encodes indoor bike simulation parameters', () => {
    expect(
      toHex(encodeSetIndoorBikeSimulation({ windSpeedMps: 0, gradePercent: 5, crr: 0.004, windResistanceKgM: 0.51 })),
    ).toBe('11 00 00 f4 01 28 33');
    expect(
      toHex(
        encodeSetIndoorBikeSimulation({ windSpeedMps: -2.5, gradePercent: -3.5, crr: 0.005, windResistanceKgM: 0.6 }),
      ),
    ).toBe('11 3c f6 a2 fe 32 3c');
  });

  it('clamps simulation parameters to representable ranges', () => {
    expect(
      toHex(encodeSetIndoorBikeSimulation({ windSpeedMps: 100, gradePercent: 500, crr: 1, windResistanceKgM: 10 })),
    ).toBe('11 ff 7f ff 7f ff ff');
    expect(
      toHex(encodeSetIndoorBikeSimulation({ windSpeedMps: -100, gradePercent: -500, crr: -1, windResistanceKgM: -1 })),
    ).toBe('11 00 80 00 80 00 00');
    expect(
      toHex(encodeSetIndoorBikeSimulation({ windSpeedMps: NaN, gradePercent: NaN, crr: NaN, windResistanceKgM: NaN })),
    ).toBe('11 00 00 00 00 00 00');
  });
});

describe('parseControlPointResponse', () => {
  it('parses responses with named results', () => {
    expect(parseControlPointResponse(dataView('80 11 01'))).toMatchObject({
      requestOpCode: 0x11,
      resultCode: 1,
      result: 'success',
    });
    expect(parseControlPointResponse(dataView('80 05 05'))?.result).toBe('controlNotPermitted');
    expect(parseControlPointResponse(dataView('80 04 03'))?.result).toBe('invalidParameter');
    expect(parseControlPointResponse(dataView('80 00 02'))?.result).toBe('opCodeNotSupported');
    expect(parseControlPointResponse(dataView('80 00 04'))?.result).toBe('operationFailed');
    expect(parseControlPointResponse(dataView('80 00 09'))?.result).toBe('unknown');
    expect(toHex(parseControlPointResponse(dataView('80 00 01 aa bb'))!.parameter)).toBe('aa bb');
  });

  it('returns null for non-responses and truncated input', () => {
    expect(parseControlPointResponse(dataView('81 00 01'))).toBeNull();
    expect(parseControlPointResponse(dataView('80 00'))).toBeNull();
    expect(parseControlPointResponse(dataView(''))).toBeNull();
  });
});
