// Pure encoders for the characteristics Freilauf publishes when it acts as a
// Bluetooth sensor for a watch ("share with my watch", docs/watch-relay.md,
// docs/adr/0005-sensor-relay.md). Each one is the inverse of the parser of
// the same characteristic in this package and is round-trip tested against it.
// All multi-byte fields are little-endian, as GATT requires.

import { CyclingPowerFlag } from '../cyclingPower';
import type { CrankRevolutionData } from '../cyclingPower';
import { CscFlag } from '../cyclingSpeedCadence';
import { HeartRateFlag } from '../heartRate';
import { IndoorBikeDataFlag } from '../ftms';

class ByteWriter {
  private readonly bytes: number[] = [];
  uint8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  uint16(v: number): this {
    return this.uint8(v).uint8(v >>> 8);
  }
  sint16(v: number): this {
    return this.uint16(v < 0 ? v + 0x10000 : v);
  }
  uint24(v: number): this {
    return this.uint16(v).uint8(v >>> 16);
  }
  uint32(v: number): this {
    return this.uint16(v).uint16(v >>> 16);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

const clampInt = (v: number, min: number, max: number): number =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : 0;

/** Wheel revolution data of the CSC Measurement: uint32 count, uint16 time in 1/1024 s. */
export interface WheelRevolutionData1024 {
  cumulativeRevs: number;
  lastEventTime1024: number;
}

/** Wheel revolution data of the Cycling Power Measurement: uint32 count, uint16 time in 1/2048 s. */
export interface WheelRevolutionData2048 {
  cumulativeRevs: number;
  lastEventTime2048: number;
}

// ───────────────────────── Heart Rate (0x180D) ─────────────────────────

/**
 * Heart Rate Measurement (0x2A37). uint8 format up to 255 bpm, uint16 above.
 * `sensorContact` sets "contact supported" and the detected bit; omit it to
 * leave both clear.
 */
export function encodeHeartRateMeasurement(m: {
  bpm: number;
  sensorContact?: boolean;
}): Uint8Array {
  const bpm = clampInt(m.bpm, 0, 0xffff);
  let flags = 0;
  if (bpm > 0xff) flags |= HeartRateFlag.ValueFormatUint16;
  if (m.sensorContact !== undefined) {
    flags |= HeartRateFlag.SensorContactSupported;
    if (m.sensorContact) flags |= HeartRateFlag.SensorContactDetected;
  }
  const w = new ByteWriter().uint8(flags);
  return (bpm > 0xff ? w.uint16(bpm) : w.uint8(bpm)).done();
}

/** Body Sensor Location (0x2A38). */
export const BodySensorLocation = { Other: 0, Chest: 1, Wrist: 2 } as const;

export function encodeBodySensorLocation(location: number): Uint8Array {
  return Uint8Array.of(location & 0xff);
}

// ───────────────────────── Cycling Power (0x1818) ─────────────────────────

/** Cycling Power Measurement (0x2A63): instantaneous power, optional wheel and crank data. */
export function encodeCyclingPowerMeasurement(m: {
  powerW: number;
  wheel?: WheelRevolutionData2048;
  crank?: CrankRevolutionData;
}): Uint8Array {
  let flags = 0;
  if (m.wheel) flags |= CyclingPowerFlag.WheelRevolutionData;
  if (m.crank) flags |= CyclingPowerFlag.CrankRevolutionData;
  const w = new ByteWriter().uint16(flags).sint16(clampInt(m.powerW, -32768, 32767));
  if (m.wheel) w.uint32(m.wheel.cumulativeRevs >>> 0).uint16(m.wheel.lastEventTime2048);
  if (m.crank) w.uint16(m.crank.cumulativeRevs).uint16(m.crank.lastEventTime1024);
  return w.done();
}

/** Cycling Power Feature (0x2A65) bits (uint32). */
export const CyclingPowerFeatureBit = {
  PedalPowerBalance: 1 << 0,
  AccumulatedTorque: 1 << 1,
  WheelRevolutionData: 1 << 2,
  CrankRevolutionData: 1 << 3,
} as const;

export function encodeCyclingPowerFeature(bits: number): Uint8Array {
  return new ByteWriter().uint32(bits >>> 0).done();
}

/** Sensor Location (0x2A5D), shared by the Cycling Power and CSC services. */
export const SensorLocation = {
  Other: 0,
  FrontWheel: 4,
  LeftCrank: 5,
  RightCrank: 6,
  FrontHub: 9,
  RearDropout: 10,
  Chainstay: 11,
  RearWheel: 12,
  RearHub: 13,
} as const;

export function encodeSensorLocation(location: number): Uint8Array {
  return Uint8Array.of(location & 0xff);
}

// ─────────────────── Cycling Speed and Cadence (0x1816) ───────────────────

/** CSC Measurement (0x2A5B): wheel and/or crank revolution data. */
export function encodeCscMeasurement(m: {
  wheel?: WheelRevolutionData1024;
  crank?: CrankRevolutionData;
}): Uint8Array {
  let flags = 0;
  if (m.wheel) flags |= CscFlag.WheelRevolutionData;
  if (m.crank) flags |= CscFlag.CrankRevolutionData;
  const w = new ByteWriter().uint8(flags);
  if (m.wheel) w.uint32(m.wheel.cumulativeRevs >>> 0).uint16(m.wheel.lastEventTime1024);
  if (m.crank) w.uint16(m.crank.cumulativeRevs).uint16(m.crank.lastEventTime1024);
  return w.done();
}

/** CSC Feature (0x2A5C) bits (uint16). */
export const CscFeatureBit = {
  WheelRevolutionData: 1 << 0,
  CrankRevolutionData: 1 << 1,
  MultipleSensorLocations: 1 << 2,
} as const;

export function encodeCscFeature(bits: number): Uint8Array {
  return new ByteWriter().uint16(bits).done();
}

/** SC Control Point (0x2A55) op codes and the response a sensor indicates. */
export const ScControlOp = {
  SetCumulativeValue: 0x01,
  StartSensorCalibration: 0x02,
  UpdateSensorLocation: 0x03,
  RequestSupportedSensorLocations: 0x04,
  ResponseCode: 0x10,
} as const;

export const ScControlResult = {
  Success: 0x01,
  OpCodeNotSupported: 0x02,
  InvalidParameter: 0x03,
  OperationFailed: 0x04,
} as const;

export type ScControlRequest =
  { op: 'setCumulativeValue'; value: number } | { op: 'other'; opCode: number } | { op: 'invalid' };

export function parseScControlPointRequest(bytes: Uint8Array): ScControlRequest {
  if (bytes.length === 0) return { op: 'invalid' };
  if (bytes[0] === ScControlOp.SetCumulativeValue) {
    if (bytes.length < 5) return { op: 'invalid' };
    const value = (bytes[1]! | (bytes[2]! << 8) | (bytes[3]! << 16) | (bytes[4]! << 24)) >>> 0;
    return { op: 'setCumulativeValue', value };
  }
  return { op: 'other', opCode: bytes[0]! };
}

export function encodeScControlPointResponse(requestOpCode: number, result: number): Uint8Array {
  return Uint8Array.of(ScControlOp.ResponseCode, requestOpCode & 0xff, result & 0xff);
}

// ───────────────────────── FTMS (0x1826), read-only ─────────────────────────

/**
 * Indoor Bike Data (0x2AD2) with instantaneous speed, cadence, total
 * distance, power and (when known) heart rate.
 */
export function encodeIndoorBikeData(m: {
  speedKph: number;
  cadenceRpm: number;
  distanceM: number;
  powerW: number;
  heartRateBpm?: number | null;
}): Uint8Array {
  let flags =
    IndoorBikeDataFlag.InstantaneousCadence |
    IndoorBikeDataFlag.TotalDistance |
    IndoorBikeDataFlag.InstantaneousPower;
  const hr = m.heartRateBpm ?? null;
  if (hr !== null) flags |= IndoorBikeDataFlag.HeartRate;
  const w = new ByteWriter()
    .uint16(flags) // MoreData clear: instantaneous speed present
    .uint16(clampInt(m.speedKph * 100, 0, 0xffff))
    .uint16(clampInt(m.cadenceRpm * 2, 0, 0xffff))
    .uint24(clampInt(m.distanceM, 0, 0xffffff))
    .sint16(clampInt(m.powerW, -32768, 32767));
  if (hr !== null) w.uint8(clampInt(hr, 0, 0xff));
  return w.done();
}

/** Fitness Machine Feature (0x2ACC) bits of the first uint32 (machine features). */
export const FitnessMachineFeatureBit = {
  Cadence: 1 << 1,
  TotalDistance: 1 << 2,
  HeartRateMeasurement: 1 << 10,
  PowerMeasurement: 1 << 14,
} as const;

/** Fitness Machine Feature: machine features, then target-setting features (none: read-only). */
export function encodeFitnessMachineFeature(machineBits: number, targetBits = 0): Uint8Array {
  return new ByteWriter()
    .uint32(machineBits >>> 0)
    .uint32(targetBits >>> 0)
    .done();
}

/** Lowercase hex, the form the sensor-relay helper protocol carries bytes in. */
export function toRelayHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromRelayHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new RangeError(`bad hex ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
