import { ByteReader } from './byteReader';

// Heart Rate Measurement (0x2A37). Truncation policy as in ftms.ts.

export const HeartRateFlag = {
  ValueFormatUint16: 1 << 0,
  SensorContactDetected: 1 << 1,
  SensorContactSupported: 1 << 2,
  EnergyExpended: 1 << 3,
  RrIntervals: 1 << 4,
} as const;

export interface HeartRateMeasurement {
  bpm: number;
  /** undefined when the sensor does not support contact detection. */
  sensorContact?: boolean;
  energyExpendedKj?: number;
  /** RR intervals in seconds (transmitted in 1/1024 s). */
  rrIntervalsS?: number[];
}

export function parseHeartRateMeasurement(view: DataView): HeartRateMeasurement | null {
  const r = new ByteReader(view);
  const flags = r.uint8();
  if (flags === undefined) return null;
  const bpm = flags & HeartRateFlag.ValueFormatUint16 ? r.uint16() : r.uint8();
  if (bpm === undefined) return null;
  const out: HeartRateMeasurement = { bpm };
  if (flags & HeartRateFlag.SensorContactSupported) {
    out.sensorContact = (flags & HeartRateFlag.SensorContactDetected) !== 0;
  }
  if (flags & HeartRateFlag.EnergyExpended) {
    const v = r.uint16();
    if (v === undefined) return out;
    out.energyExpendedKj = v;
  }
  if (flags & HeartRateFlag.RrIntervals) {
    const rr: number[] = [];
    for (let v = r.uint16(); v !== undefined; v = r.uint16()) rr.push(v / 1024);
    out.rrIntervalsS = rr;
  }
  return out;
}
