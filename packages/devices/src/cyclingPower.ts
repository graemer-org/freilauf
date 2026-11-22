import { ByteReader } from './byteReader';

// Cycling Power Measurement (0x2A63). Truncation policy as in ftms.ts: null if
// flags + instantaneous power cannot be read, otherwise every complete field.

export const CyclingPowerFlag = {
  PedalPowerBalance: 1 << 0,
  // bit 1: pedal power balance reference (no field)
  AccumulatedTorque: 1 << 2,
  // bit 3: accumulated torque source (no field)
  WheelRevolutionData: 1 << 4,
  CrankRevolutionData: 1 << 5,
  ExtremeForceMagnitudes: 1 << 6,
  ExtremeTorqueMagnitudes: 1 << 7,
  ExtremeAngles: 1 << 8,
  TopDeadSpotAngle: 1 << 9,
  BottomDeadSpotAngle: 1 << 10,
  AccumulatedEnergy: 1 << 11,
  // bit 12: offset compensation indicator (no field)
} as const;

export interface CrankRevolutionData {
  /** uint16, wraps. */
  cumulativeRevs: number;
  /** uint16 in 1/1024 s, wraps every 64 s. */
  lastEventTime1024: number;
}

export interface CyclingPowerMeasurement {
  flags: number;
  powerW: number;
  /** Percent, 0.5 resolution. */
  pedalPowerBalancePercent?: number;
  wheel?: { cumulativeRevs: number; lastEventTime2048: number };
  crank?: CrankRevolutionData;
}

export function parseCyclingPowerMeasurement(view: DataView): CyclingPowerMeasurement | null {
  const r = new ByteReader(view);
  const flags = r.uint16();
  const powerW = r.sint16();
  if (flags === undefined || powerW === undefined) return null;
  const out: CyclingPowerMeasurement = { flags, powerW };
  const has = (bit: number) => (flags & bit) !== 0;

  if (has(CyclingPowerFlag.PedalPowerBalance)) {
    const v = r.uint8();
    if (v === undefined) return out;
    if (v !== 0xff) out.pedalPowerBalancePercent = v / 2;
  }
  if (has(CyclingPowerFlag.AccumulatedTorque) && !r.skip(2)) return out;
  if (has(CyclingPowerFlag.WheelRevolutionData)) {
    if (r.remaining < 6) return out;
    out.wheel = { cumulativeRevs: r.uint32()!, lastEventTime2048: r.uint16()! };
  }
  if (has(CyclingPowerFlag.CrankRevolutionData)) {
    if (r.remaining < 4) return out;
    out.crank = { cumulativeRevs: r.uint16()!, lastEventTime1024: r.uint16()! };
  }
  // The remaining optional fields (extreme magnitudes/angles, dead spots,
  // accumulated energy) come after crank data and are not needed.
  return out;
}

/**
 * Derives cadence from successive crank revolution samples. Handles uint16
 * wraparound of both counters. When samples keep arriving without a new crank
 * event, the last cadence is held for `staleAfterMs` and then reported as 0.
 */
export class CadenceFromCrankRevs {
  private last: CrankRevolutionData | undefined;
  private lastEventAtMs = 0;
  private rpm: number | undefined;
  private readonly staleAfterMs: number;

  constructor(options: { staleAfterMs?: number } = {}) {
    this.staleAfterMs = options.staleAfterMs ?? 3000;
  }

  /** Feeds a sample; returns the current cadence (undefined until two events are seen). */
  update(sample: CrankRevolutionData, nowMs: number): number | undefined {
    const prev = this.last;
    this.last = sample;
    if (!prev) {
      this.lastEventAtMs = nowMs;
      return this.current(nowMs);
    }
    const dRevs = (sample.cumulativeRevs - prev.cumulativeRevs) & 0xffff;
    const dTicks = (sample.lastEventTime1024 - prev.lastEventTime1024) & 0xffff;
    if (dTicks !== 0 && dRevs !== 0) {
      this.rpm = (dRevs * 60 * 1024) / dTicks;
      this.lastEventAtMs = nowMs;
    } else if (dTicks !== 0 || dRevs !== 0) {
      // Inconsistent sample (one counter moved, the other did not): treat as a new
      // reference point without producing a value.
      this.lastEventAtMs = nowMs;
    }
    return this.current(nowMs);
  }

  /** Cadence as of `nowMs`, applying the staleness decay. */
  current(nowMs: number): number | undefined {
    if (this.rpm === undefined) return undefined;
    return nowMs - this.lastEventAtMs > this.staleAfterMs ? 0 : this.rpm;
  }

  reset(): void {
    this.last = undefined;
    this.rpm = undefined;
    this.lastEventAtMs = 0;
  }
}
