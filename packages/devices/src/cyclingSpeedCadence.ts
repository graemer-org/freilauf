import { ByteReader } from './byteReader';
import type { CrankRevolutionData } from './cyclingPower';

// CSC Measurement (0x2A5B), Cycling Speed and Cadence Service (0x1816).
// Truncation policy as in ftms.ts: null if the flags cannot be read, otherwise
// every complete field.

export const CscFlag = {
  WheelRevolutionData: 1 << 0,
  CrankRevolutionData: 1 << 1,
} as const;

export interface CscMeasurement {
  flags: number;
  /** Cumulative wheel revolutions (uint32, wraps) and last wheel event time (uint16, 1/1024 s). */
  wheel?: { cumulativeRevs: number; lastEventTime1024: number };
  crank?: CrankRevolutionData;
}

export function parseCscMeasurement(view: DataView): CscMeasurement | null {
  const r = new ByteReader(view);
  const flags = r.uint8();
  if (flags === undefined) return null;
  const out: CscMeasurement = { flags };
  if (flags & CscFlag.WheelRevolutionData) {
    if (r.remaining < 6) return out;
    out.wheel = { cumulativeRevs: r.uint32()!, lastEventTime1024: r.uint16()! };
  }
  if (flags & CscFlag.CrankRevolutionData) {
    if (r.remaining < 4) return out;
    out.crank = { cumulativeRevs: r.uint16()!, lastEventTime1024: r.uint16()! };
  }
  return out;
}

/**
 * Speed from successive wheel revolution samples (m/s), the way a watch or
 * bike computer derives it. Handles uint32 count and uint16 event-time
 * wraparound; undefined until two samples with a new wheel event arrived, 0
 * once no new event came for `staleAfterMs`.
 */
export class SpeedFromWheelRevs {
  private last: { cumulativeRevs: number; lastEventTime1024: number } | undefined;
  private lastEventAtMs = 0;
  private mps: number | undefined;
  readonly circumferenceM: number;
  private readonly staleAfterMs: number;

  constructor(options: { circumferenceM: number; staleAfterMs?: number }) {
    this.circumferenceM = options.circumferenceM;
    this.staleAfterMs = options.staleAfterMs ?? 3000;
  }

  update(
    sample: { cumulativeRevs: number; lastEventTime1024: number },
    nowMs: number,
  ): number | undefined {
    const prev = this.last;
    this.last = sample;
    if (!prev) {
      this.lastEventAtMs = nowMs;
      return this.current(nowMs);
    }
    const dRevs = (sample.cumulativeRevs - prev.cumulativeRevs) >>> 0;
    const dTicks = (sample.lastEventTime1024 - prev.lastEventTime1024) & 0xffff;
    if (dRevs !== 0 && dTicks !== 0) {
      this.mps = (dRevs * this.circumferenceM * 1024) / dTicks;
      this.lastEventAtMs = nowMs;
    }
    return this.current(nowMs);
  }

  current(nowMs: number): number | undefined {
    if (this.mps === undefined) return undefined;
    return nowMs - this.lastEventAtMs > this.staleAfterMs ? 0 : this.mps;
  }
}
