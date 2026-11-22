import { ByteReader, clamp } from './byteReader';
import type { SimulationParams } from './types';

// Pure encoders/decoders for the Bluetooth Fitness Machine Service (FTMS 1.0).
//
// Truncation policy (all parsers in this package): a parser never throws on
// short/malformed input. If not even the header (flags) can be read it returns
// null; otherwise it returns every field that was completely present, in spec
// order, and stops at the first field that does not fit. Fields after a
// truncation are absent, never garbage.

// ───────────────────────── Indoor Bike Data (0x2AD2) ─────────────────────────

export const IndoorBikeDataFlag = {
  /** Inverted: when CLEAR, Instantaneous Speed is present. */
  MoreData: 1 << 0,
  AverageSpeed: 1 << 1,
  InstantaneousCadence: 1 << 2,
  AverageCadence: 1 << 3,
  TotalDistance: 1 << 4,
  ResistanceLevel: 1 << 5,
  InstantaneousPower: 1 << 6,
  AveragePower: 1 << 7,
  ExpendedEnergy: 1 << 8,
  HeartRate: 1 << 9,
  MetabolicEquivalent: 1 << 10,
  ElapsedTime: 1 << 11,
  RemainingTime: 1 << 12,
} as const;

export interface IndoorBikeData {
  flags: number;
  /** km/h, 0.01 resolution. */
  speedKph?: number;
  averageSpeedKph?: number;
  /** rpm, 0.5 resolution. */
  cadenceRpm?: number;
  averageCadenceRpm?: number;
  /** metres (uint24). */
  distanceM?: number;
  /** Unitless, as sent (sint16). */
  resistanceLevel?: number;
  powerW?: number;
  averagePowerW?: number;
  /** kcal; undefined when the trainer sends "not available" (0xFFFF). */
  totalEnergyKcal?: number;
  energyPerHourKcal?: number;
  energyPerMinuteKcal?: number;
  heartRateBpm?: number;
  /** 0.1 resolution. */
  metabolicEquivalent?: number;
  elapsedS?: number;
  remainingS?: number;
}

/** Parses an Indoor Bike Data notification. See the truncation policy above. */
export function parseIndoorBikeData(view: DataView): IndoorBikeData | null {
  const r = new ByteReader(view);
  const flags = r.uint16();
  if (flags === undefined) return null;
  const out: IndoorBikeData = { flags };
  const has = (bit: number) => (flags & bit) !== 0;

  // Each step returns false when the field was present but truncated.
  const steps: Array<() => boolean> = [
    () => {
      if (has(IndoorBikeDataFlag.MoreData)) return true;
      const v = r.uint16();
      if (v === undefined) return false;
      out.speedKph = v / 100;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.AverageSpeed)) return true;
      const v = r.uint16();
      if (v === undefined) return false;
      out.averageSpeedKph = v / 100;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.InstantaneousCadence)) return true;
      const v = r.uint16();
      if (v === undefined) return false;
      out.cadenceRpm = v / 2;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.AverageCadence)) return true;
      const v = r.uint16();
      if (v === undefined) return false;
      out.averageCadenceRpm = v / 2;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.TotalDistance)) return true;
      const v = r.uint24();
      if (v === undefined) return false;
      out.distanceM = v;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.ResistanceLevel)) return true;
      const v = r.sint16();
      if (v === undefined) return false;
      out.resistanceLevel = v;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.InstantaneousPower)) return true;
      const v = r.sint16();
      if (v === undefined) return false;
      out.powerW = v;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.AveragePower)) return true;
      const v = r.sint16();
      if (v === undefined) return false;
      out.averagePowerW = v;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.ExpendedEnergy)) return true;
      if (r.remaining < 5) return false;
      const total = r.uint16()!;
      const perHour = r.uint16()!;
      const perMinute = r.uint8()!;
      if (total !== 0xffff) out.totalEnergyKcal = total;
      if (perHour !== 0xffff) out.energyPerHourKcal = perHour;
      if (perMinute !== 0xff) out.energyPerMinuteKcal = perMinute;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.HeartRate)) return true;
      const v = r.uint8();
      if (v === undefined) return false;
      out.heartRateBpm = v;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.MetabolicEquivalent)) return true;
      const v = r.uint8();
      if (v === undefined) return false;
      out.metabolicEquivalent = v / 10;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.ElapsedTime)) return true;
      const v = r.uint16();
      if (v === undefined) return false;
      out.elapsedS = v;
      return true;
    },
    () => {
      if (!has(IndoorBikeDataFlag.RemainingTime)) return true;
      const v = r.uint16();
      if (v === undefined) return false;
      out.remainingS = v;
      return true;
    },
  ];
  for (const step of steps) {
    if (!step()) break;
  }
  return out;
}

// ───────────────────────── Control Point (0x2AD9) ─────────────────────────

export const FtmsOpCode = {
  RequestControl: 0x00,
  Reset: 0x01,
  SetTargetSpeed: 0x02,
  SetTargetInclination: 0x03,
  SetTargetResistanceLevel: 0x04,
  SetTargetPower: 0x05,
  SetTargetHeartRate: 0x06,
  StartOrResume: 0x07,
  StopOrPause: 0x08,
  SetIndoorBikeSimulation: 0x11,
  ResponseCode: 0x80,
} as const;
export type FtmsOpCode = (typeof FtmsOpCode)[keyof typeof FtmsOpCode];

export const FtmsResultCode = {
  Success: 0x01,
  OpCodeNotSupported: 0x02,
  InvalidParameter: 0x03,
  OperationFailed: 0x04,
  ControlNotPermitted: 0x05,
} as const;

export type FtmsResult =
  | 'success'
  | 'opCodeNotSupported'
  | 'invalidParameter'
  | 'operationFailed'
  | 'controlNotPermitted'
  | 'unknown';

const RESULT_NAMES: Record<number, FtmsResult> = {
  [FtmsResultCode.Success]: 'success',
  [FtmsResultCode.OpCodeNotSupported]: 'opCodeNotSupported',
  [FtmsResultCode.InvalidParameter]: 'invalidParameter',
  [FtmsResultCode.OperationFailed]: 'operationFailed',
  [FtmsResultCode.ControlNotPermitted]: 'controlNotPermitted',
};

export function encodeRequestControl(): Uint8Array {
  return Uint8Array.of(FtmsOpCode.RequestControl);
}

export function encodeReset(): Uint8Array {
  return Uint8Array.of(FtmsOpCode.Reset);
}

/** Resistance level is uint8 with 0.1 resolution in FTMS 1.0 → clamped to 0 … 25.5. */
export function encodeSetTargetResistance(level: number): Uint8Array {
  const raw = Math.round(clamp(level, 0, 25.5) * 10);
  return Uint8Array.of(FtmsOpCode.SetTargetResistanceLevel, raw);
}

/** Target power, sint16 watts; clamped to the representable range. */
export function encodeSetTargetPower(watts: number): Uint8Array {
  const raw = Math.round(clamp(watts, -32768, 32767));
  const out = new Uint8Array(3);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, FtmsOpCode.SetTargetPower);
  dv.setInt16(1, raw, true);
  return out;
}

export function encodeStart(): Uint8Array {
  return Uint8Array.of(FtmsOpCode.StartOrResume);
}

export const StopOrPause = { Stop: 0x01, Pause: 0x02 } as const;

export function encodeStop(): Uint8Array {
  return Uint8Array.of(FtmsOpCode.StopOrPause, StopOrPause.Stop);
}

export function encodePause(): Uint8Array {
  return Uint8Array.of(FtmsOpCode.StopOrPause, StopOrPause.Pause);
}

/**
 * Set Indoor Bike Simulation Parameters (0x11). Each value is rounded to its
 * resolution and clamped to the field's representable range:
 * wind speed sint16 0.001 m/s (±32.767), grade sint16 0.01 % (±327.67),
 * crr uint8 0.0001 (0 … 0.0255), cw uint8 0.01 kg/m (0 … 2.55).
 */
export function encodeSetIndoorBikeSimulation(params: SimulationParams): Uint8Array {
  const wind = Math.round(clamp(params.windSpeedMps * 1000, -32768, 32767));
  const grade = Math.round(clamp(params.gradePercent * 100, -32768, 32767));
  const crr = Math.round(clamp(params.crr * 10000, 0, 255));
  const cw = Math.round(clamp(params.windResistanceKgM * 100, 0, 255));
  const out = new Uint8Array(7);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, FtmsOpCode.SetIndoorBikeSimulation);
  dv.setInt16(1, wind, true);
  dv.setInt16(3, grade, true);
  dv.setUint8(5, crr);
  dv.setUint8(6, cw);
  return out;
}

export interface ControlPointResponse {
  requestOpCode: number;
  resultCode: number;
  result: FtmsResult;
  /** Any response parameter bytes after the result code. */
  parameter: Uint8Array;
}

/** Parses a control point indication; null if it is not a well-formed 0x80 response. */
export function parseControlPointResponse(view: DataView): ControlPointResponse | null {
  if (view.byteLength < 3 || view.getUint8(0) !== FtmsOpCode.ResponseCode) return null;
  const resultCode = view.getUint8(2);
  return {
    requestOpCode: view.getUint8(1),
    resultCode,
    result: RESULT_NAMES[resultCode] ?? 'unknown',
    parameter: new Uint8Array(view.buffer, view.byteOffset + 3, view.byteLength - 3).slice(),
  };
}
