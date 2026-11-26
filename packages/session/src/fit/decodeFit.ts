/**
 * A small FIT reader for one purpose: the track of a ride file (a friend's ride, another app's
 * export, our own `.fit`) to race as a ghost (docs/ghost.md). It reads the record messages
 * (time, position, distance, altitude) and the timer events, nothing else. Written from the
 * public FIT protocol description (file header, definition and data messages, compressed
 * timestamp headers, base types); no third-party code.
 *
 * Moving time: the time between two records counts while the timer runs (timer stop/start
 * events) unless the gap is long and the rider did not move (an auto-pause without events).
 */

const MESG_RECORD = 20;
const MESG_EVENT = 21;
const FIELD_TIMESTAMP = 253;
const RECORD_LAT = 0;
const RECORD_LON = 1;
const RECORD_ALTITUDE = 2;
const RECORD_DISTANCE = 5;
const RECORD_ENHANCED_ALTITUDE = 78;
const EVENT_EVENT = 0;
const EVENT_TYPE = 1;
const EVENT_TIMER = 0;
const EVENT_TYPE_START = 0;
const EVENT_TYPE_STOP = 1;
const EVENT_TYPE_STOP_ALL = 4;
const EVENT_TYPE_STOP_DISABLE_ALL = 9;

/** Largest file accepted (a 10-hour ride with every field at 1 Hz is far below this). */
export const MAX_FIT_BYTES = 32 * 1024 * 1024;
/** Records kept at most (≈ 2.3 days at 1 Hz); more are refused rather than truncated. */
export const MAX_FIT_RECORDS = 200_000;
/** A gap between records longer than this, without moving, is a pause. */
const PAUSE_GAP_S = 10;
/** Below this average speed over a long gap the rider is taken to have stood still. */
const MOVING_MPS = 1;

const SEMICIRCLE_DEG = 180 / 2 ** 31;

export interface FitTrackPoint {
  /** Moving time since the first record (s). */
  timeS: number;
  /** Degrees; absent when the record has no (valid) position. */
  lat?: number;
  lon?: number;
  /** Distance from the file (m), when present. */
  distanceM?: number;
  altitudeM?: number;
}

export type FitTrackResult =
  { ok: true; points: FitTrackPoint[]; withPosition: number } | { ok: false; reason: string };

interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}

interface Definition {
  global: number;
  littleEndian: boolean;
  fields: FieldDef[];
  /** Bytes of developer fields after the normal ones (skipped). */
  devBytes: number;
  size: number;
}

/** Reads one field value; null for the base type's invalid value or an unsupported size. */
function readValue(view: DataView, at: number, f: FieldDef, little: boolean): number | null {
  const t = f.baseType & 0x1f;
  switch (t) {
    case 0x00: // enum
    case 0x02: // uint8
    case 0x0a: // uint8z
    case 0x0d: {
      // byte
      if (f.size < 1) return null;
      const v = view.getUint8(at);
      return v === 0xff || (t === 0x0a && v === 0) ? null : v;
    }
    case 0x01: {
      if (f.size < 1) return null;
      const v = view.getInt8(at);
      return v === 0x7f ? null : v;
    }
    case 0x03: {
      if (f.size < 2) return null;
      const v = view.getInt16(at, little);
      return v === 0x7fff ? null : v;
    }
    case 0x04:
    case 0x0b: {
      if (f.size < 2) return null;
      const v = view.getUint16(at, little);
      return v === 0xffff || (t === 0x0b && v === 0) ? null : v;
    }
    case 0x05: {
      if (f.size < 4) return null;
      const v = view.getInt32(at, little);
      return v === 0x7fffffff ? null : v;
    }
    case 0x06:
    case 0x0c: {
      if (f.size < 4) return null;
      const v = view.getUint32(at, little);
      return v === 0xffffffff || (t === 0x0c && v === 0) ? null : v;
    }
    case 0x08: {
      if (f.size < 4) return null;
      const v = view.getFloat32(at, little);
      return Number.isFinite(v) ? v : null;
    }
    case 0x09: {
      if (f.size < 8) return null;
      const v = view.getFloat64(at, little);
      return Number.isFinite(v) ? v : null;
    }
    default:
      return null; // strings, 64-bit integers: not needed here
  }
}

interface RawRecord {
  ts: number;
  lat: number | null;
  lon: number | null;
  distanceM: number | null;
  altitudeM: number | null;
}

/**
 * The track of a FIT activity file: one point per record with a timestamp, with moving time,
 * and position/distance/altitude where present. Refuses files that are not FIT, are corrupt or
 * too large, or hold no records.
 */
export function decodeFitTrack(bytes: Uint8Array): FitTrackResult {
  if (bytes.byteLength > MAX_FIT_BYTES) return { ok: false, reason: 'The file is too large.' };
  if (bytes.byteLength < 12) return { ok: false, reason: 'This is not a FIT file.' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint8(0);
  const magic = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11),
  );
  if ((headerSize !== 12 && headerSize !== 14) || magic !== '.FIT') {
    return { ok: false, reason: 'This is not a FIT file.' };
  }
  const dataSize = view.getUint32(4, true);
  const end = headerSize + dataSize;
  if (end > bytes.byteLength) return { ok: false, reason: 'The FIT file is cut short.' };

  const defs = new Map<number, Definition>();
  const records: RawRecord[] = [];
  const timer: { ts: number; running: boolean }[] = [];
  let lastTs: number | null = null;
  let at = headerSize;
  try {
    while (at < end) {
      const header = view.getUint8(at++);
      let local: number;
      let compressedTs: number | null = null;
      if (header & 0x80) {
        local = (header >> 5) & 0x03;
        const offset = header & 0x1f;
        if (lastTs !== null) {
          compressedTs = lastTs + ((offset - (lastTs & 0x1f)) & 0x1f);
        }
      } else if (header & 0x40) {
        local = header & 0x0f;
        const hasDev = (header & 0x20) !== 0;
        const little = view.getUint8(at + 1) === 0;
        const global = view.getUint16(at + 2, little);
        const n = view.getUint8(at + 4);
        at += 5;
        const fields: FieldDef[] = [];
        let size = 0;
        for (let i = 0; i < n; i++) {
          const f = {
            num: view.getUint8(at),
            size: view.getUint8(at + 1),
            baseType: view.getUint8(at + 2),
          };
          fields.push(f);
          size += f.size;
          at += 3;
        }
        let devBytes = 0;
        if (hasDev) {
          const nd = view.getUint8(at++);
          for (let i = 0; i < nd; i++) {
            devBytes += view.getUint8(at + 1);
            at += 3;
          }
        }
        defs.set(local, { global, littleEndian: little, fields, devBytes, size: size + devBytes });
        continue;
      } else {
        local = header & 0x0f;
      }
      const def = defs.get(local);
      if (!def) return { ok: false, reason: 'The FIT file is damaged (unknown message).' };
      if (at + def.size > end) return { ok: false, reason: 'The FIT file is cut short.' };
      let p = at;
      const values = new Map<number, number | null>();
      for (const f of def.fields) {
        values.set(f.num, readValue(view, p, f, def.littleEndian));
        p += f.size;
      }
      at += def.size;
      const ts: number | null = values.get(FIELD_TIMESTAMP) ?? compressedTs;
      if (typeof ts === 'number') lastTs = ts;
      if (def.global === MESG_RECORD && typeof ts === 'number') {
        if (records.length >= MAX_FIT_RECORDS) {
          return { ok: false, reason: 'The ride is too long to use as a ghost.' };
        }
        const lat = values.get(RECORD_LAT);
        const lon = values.get(RECORD_LON);
        const dist = values.get(RECORD_DISTANCE);
        const enh = values.get(RECORD_ENHANCED_ALTITUDE);
        const alt = values.get(RECORD_ALTITUDE);
        records.push({
          ts,
          lat: typeof lat === 'number' ? lat * SEMICIRCLE_DEG : null,
          lon: typeof lon === 'number' ? lon * SEMICIRCLE_DEG : null,
          distanceM: typeof dist === 'number' ? dist / 100 : null,
          altitudeM:
            typeof enh === 'number'
              ? enh / 5 - 500
              : typeof alt === 'number'
                ? alt / 5 - 500
                : null,
        });
      } else if (def.global === MESG_EVENT && typeof ts === 'number') {
        if (values.get(EVENT_EVENT) === EVENT_TIMER) {
          const type = values.get(EVENT_TYPE);
          if (type === EVENT_TYPE_START) timer.push({ ts, running: true });
          else if (
            type === EVENT_TYPE_STOP ||
            type === EVENT_TYPE_STOP_ALL ||
            type === EVENT_TYPE_STOP_DISABLE_ALL
          ) {
            timer.push({ ts, running: false });
          }
        }
      }
    }
  } catch {
    return { ok: false, reason: 'The FIT file is damaged.' };
  }
  if (records.length === 0) return { ok: false, reason: 'The file holds no recorded ride.' };

  // Records in time order (they normally are); timer events by time.
  records.sort((a, b) => a.ts - b.ts);
  timer.sort((a, b) => a.ts - b.ts);
  const points: FitTrackPoint[] = [];
  let moving = 0;
  let ev = 0;
  let running = true;
  let withPosition = 0;
  const valid = (v: number | null, lo: number, hi: number): v is number =>
    v !== null && Number.isFinite(v) && v >= lo && v <= hi;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (i > 0) {
      const prev = records[i - 1]!;
      // The time the timer ran between the two records (timer events may fall in between).
      while (ev < timer.length && timer[ev]!.ts <= prev.ts) running = timer[ev++]!.running;
      let run = 0;
      let from = prev.ts;
      while (ev < timer.length && timer[ev]!.ts <= r.ts) {
        const e = timer[ev++]!;
        if (running) run += e.ts - from;
        running = e.running;
        from = e.ts;
      }
      if (running) run += r.ts - from;
      const moved =
        prev.distanceM !== null && r.distanceM !== null ? r.distanceM - prev.distanceM : null;
      const standing = moved !== null ? moved / Math.max(1, run) < MOVING_MPS : true;
      if (run > 0 && (run <= PAUSE_GAP_S || !standing)) moving += run;
    }
    const point: FitTrackPoint = { timeS: moving };
    if (valid(r.lat, -90, 90) && valid(r.lon, -180, 180) && !(r.lat === 0 && r.lon === 0)) {
      point.lat = r.lat;
      point.lon = r.lon;
      withPosition++;
    }
    if (valid(r.distanceM, 0, 1e8)) point.distanceM = r.distanceM;
    if (valid(r.altitudeM, -500, 9000)) point.altitudeM = r.altitudeM;
    points.push(point);
  }
  return { ok: true, points, withPosition };
}
