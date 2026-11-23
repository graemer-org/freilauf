import type { RecordedRide } from '../types';
import { fitCrc } from './crc';
import type { MesgSpec } from './messages';
import {
  ACTIVITY,
  ACTIVITY_TYPE_MANUAL,
  DEVICE_INFO,
  EVENT,
  EVENT_ACTIVITY,
  EVENT_LAP,
  EVENT_SESSION,
  EVENT_TIMER,
  EVENT_TYPE_START,
  EVENT_TYPE_STOP,
  EVENT_TYPE_STOP_ALL,
  FILE_CREATOR,
  FILE_ID,
  FILE_TYPE_ACTIVITY,
  LAP,
  LAP_TRIGGER_SESSION_END,
  LAP_WITH_POSITION,
  MANUFACTURER_DEVELOPMENT,
  RECORD,
  RECORD_WITH_POSITION,
  SESSION,
  SESSION_WITH_POSITION,
  SESSION_TRIGGER_ACTIVITY_END,
  SPORT_CYCLING,
  SUB_SPORT_VIRTUAL_ACTIVITY,
} from './messages';
import type { RideSummary, RouteSummary } from './summary';
import { rideSummary, routeSummary, usableSamples } from './summary';
import { ByteWriter, toRaw } from './writer';

/** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
export const FIT_EPOCH_OFFSET_S = 631065600;

const HEADER_SIZE = 14;
const PROTOCOL_VERSION = 0x20; // 2.0
const PROFILE_VERSION = 21222; // 21.222
const SOFTWARE_VERSION = 100; // 1.00

/** Wall-clock gap (s) beyond recorded time that is treated as a pause. */
const PAUSE_THRESHOLD_S = 2;

export interface EncodeFitOptions {
  /**
   * Local time offset from UTC in minutes (e.g. +60 for CET), used for
   * `activity.local_timestamp`. Defaults to the runtime's offset at ride start.
   */
  utcOffsetMinutes?: number;
}

/** Unix epoch ms → FIT timestamp (s since 1989-12-31). `null` if not representable. */
export function toFitTimestamp(unixMs: number): number | null {
  if (!Number.isFinite(unixMs)) return null;
  const t = Math.floor(unixMs / 1000) - FIT_EPOCH_OFFSET_S;
  // Values below 0x10000000 mean "seconds since device power-on" in FIT.
  return t >= 0x10000000 && t <= 0xfffffffe ? t : null;
}

type Values = Readonly<Record<string, number | null | undefined>>;

class FitBuilder {
  readonly out = new ByteWriter(4096);
  private readonly locals = new Map<MesgSpec, number>();

  constructor() {
    for (let i = 0; i < HEADER_SIZE; i++) this.out.u8(0);
  }

  write(spec: MesgSpec, values: Values): void {
    let local = this.locals.get(spec);
    if (local === undefined) {
      local = this.locals.size;
      if (local > 15) throw new Error('FIT: too many local message types');
      this.locals.set(spec, local);
      this.define(spec, local);
    }
    const w = this.out;
    w.u8(local); // normal header, data message
    for (const field of spec.fields) {
      const v = values[field.name];
      const offset = field.offset ?? 0;
      w.raw(
        field.type,
        toRaw(field.type, typeof v === 'number' ? v + offset : v, field.scale ?? 1),
      );
    }
  }

  private define(spec: MesgSpec, local: number): void {
    const w = this.out;
    w.u8(0x40 | local); // normal header, definition message
    w.u8(0); // reserved
    w.u8(0); // architecture: little endian
    w.u16(spec.globalNum);
    w.u8(spec.fields.length);
    for (const field of spec.fields) {
      w.u8(field.num);
      w.u8(field.type.size);
      w.u8(field.type.id);
    }
  }

  finish(): Uint8Array {
    const w = this.out;
    const dataSize = w.length - HEADER_SIZE;
    const header = new ByteWriter(HEADER_SIZE);
    header.u8(HEADER_SIZE);
    header.u8(PROTOCOL_VERSION);
    header.u16(PROFILE_VERSION);
    header.u32(dataSize);
    for (const c of '.FIT') header.u8(c.charCodeAt(0));
    const head = header.bytes();
    header.u16(fitCrc(head, 0, 12));
    const full = header.bytes();
    const bytes = w.bytes();
    bytes.set(full, 0);
    const crc = fitCrc(bytes);
    const result = new Uint8Array(bytes.length + 2);
    result.set(bytes, 0);
    result[bytes.length] = crc & 0xff;
    result[bytes.length + 1] = (crc >> 8) & 0xff;
    return result;
  }
}

/** FNV-1a 32-bit hash; used to derive a stable, non-zero serial number from the ride id. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h === 0 ? 1 : h;
}

function summaryValues(s: RideSummary, start: number | null, end: number | null): Values {
  const hasSamples = s.sampleCount > 0;
  const orNull = (v: number): number | null => (hasSamples ? v : null);
  return {
    timestamp: end,
    messageIndex: 0,
    startTime: start,
    totalElapsedTime: s.elapsedS,
    totalTimerTime: s.durationS,
    totalDistance: s.distanceM,
    totalCalories: s.caloriesKcal,
    avgSpeed: s.avgSpeedMps,
    maxSpeed: s.maxSpeedMps,
    enhancedAvgSpeed: s.avgSpeedMps,
    enhancedMaxSpeed: s.maxSpeedMps,
    avgHeartRate: s.avgHeartRateBpm,
    maxHeartRate: s.maxHeartRateBpm,
    avgCadence: s.avgCadenceRpm > 0 ? s.avgCadenceRpm : orNull(0),
    maxCadence: orNull(s.maxCadenceRpm),
    avgPower: orNull(s.avgPowerW),
    maxPower: orNull(s.maxPowerW),
    totalWork: s.workKj * 1000,
    sport: SPORT_CYCLING,
    subSport: SUB_SPORT_VIRTUAL_ACTIVITY,
  };
}

/** Degrees → FIT semicircles (2³¹ per 180°). */
export function toSemicircles(degrees: number | null | undefined): number | null {
  if (degrees === null || degrees === undefined || !Number.isFinite(degrees)) return null;
  return Math.round((degrees * 2 ** 31) / 180);
}

function positionValues(r: RouteSummary): Values {
  return {
    startPositionLat: toSemicircles(r.startLat),
    startPositionLong: toSemicircles(r.startLon),
    endPositionLat: toSemicircles(r.endLat),
    endPositionLong: toSemicircles(r.endLon),
    totalAscent: r.ascentM,
    totalDescent: r.descentM,
    necLat: toSemicircles(r.maxLat),
    necLong: toSemicircles(r.maxLon),
    swcLat: toSemicircles(r.minLat),
    swcLong: toSemicircles(r.minLon),
    enhancedAvgAltitude: r.avgAltitudeM,
    enhancedMinAltitude: r.minAltitudeM,
    enhancedMaxAltitude: r.maxAltitudeM,
  };
}

/**
 * Encodes a recorded ride as a FIT activity file (cycling / virtual_activity),
 * following Garmin's recommended message order for activity files:
 * file_id, file_creator, device_info, event(timer start), record…, event(timer stop_all),
 * lap, session, activity.
 *
 * Samples with a non-finite timestamp are skipped; other non-finite values are written
 * as the field's invalid value and out-of-range values are clamped.
 */
export function encodeFit(ride: RecordedRide, options: EncodeFitOptions = {}): Uint8Array {
  const samples = usableSamples(ride);
  const summary = rideSummary(ride);
  const start = toFitTimestamp(summary.startTime);
  const end = toFitTimestamp(summary.endTime);
  // Rides along a route carry positions: then records, lap and session get position fields.
  // Without positions the output is byte-for-byte what it was before routes existed.
  const route = routeSummary(samples);

  const b = new FitBuilder();
  const serial = hash32(ride.id);

  b.write(FILE_ID, {
    type: FILE_TYPE_ACTIVITY,
    manufacturer: MANUFACTURER_DEVELOPMENT,
    product: 0,
    serialNumber: serial,
    timeCreated: start,
  });
  b.write(FILE_CREATOR, { softwareVersion: SOFTWARE_VERSION });
  b.write(DEVICE_INFO, {
    timestamp: start,
    deviceIndex: 0, // creator
    manufacturer: MANUFACTURER_DEVELOPMENT,
    serialNumber: serial,
    product: 0,
    softwareVersion: SOFTWARE_VERSION / 100,
  });

  b.write(EVENT, { timestamp: start, event: EVENT_TIMER, eventType: EVENT_TYPE_START, eventGroup: 0 });

  let prev: (typeof samples)[number] | undefined;
  for (const s of samples) {
    if (prev && Number.isFinite(s.elapsedS) && Number.isFinite(prev.elapsedS)) {
      const wallS = (s.timestamp - prev.timestamp) / 1000;
      const recS = s.elapsedS - prev.elapsedS;
      if (wallS - recS > PAUSE_THRESHOLD_S) {
        b.write(EVENT, {
          timestamp: toFitTimestamp(prev.timestamp),
          event: EVENT_TIMER,
          eventType: EVENT_TYPE_STOP,
          eventGroup: 0,
        });
        b.write(EVENT, {
          timestamp: toFitTimestamp(s.timestamp),
          event: EVENT_TIMER,
          eventType: EVENT_TYPE_START,
          eventGroup: 0,
        });
      }
    }
    b.write(route ? RECORD_WITH_POSITION : RECORD, {
      ...(route
        ? {
            positionLat: toSemicircles(s.lat),
            positionLong: toSemicircles(s.lon),
            altitude: s.altitudeM,
            enhancedAltitude: s.altitudeM,
          }
        : {}),
      timestamp: toFitTimestamp(s.timestamp),
      distance: s.distanceM,
      speed: s.speedMps,
      enhancedSpeed: s.speedMps,
      power: s.powerW,
      cadence: s.cadenceRpm,
      heartRate: s.heartRateBpm,
    });
    prev = s;
  }

  b.write(EVENT, { timestamp: end, event: EVENT_TIMER, eventType: EVENT_TYPE_STOP_ALL, eventGroup: 0 });

  const totals = { ...summaryValues(summary, start, end), ...(route ? positionValues(route) : {}) };
  b.write(route ? LAP_WITH_POSITION : LAP, {
    ...totals,
    event: EVENT_LAP,
    eventType: EVENT_TYPE_STOP,
    lapTrigger: LAP_TRIGGER_SESSION_END,
  });
  b.write(route ? SESSION_WITH_POSITION : SESSION, {
    ...totals,
    event: EVENT_SESSION,
    eventType: EVENT_TYPE_STOP,
    firstLapIndex: 0,
    numLaps: 1,
    trigger: SESSION_TRIGGER_ACTIVITY_END,
  });

  const offsetMin =
    options.utcOffsetMinutes ?? (Number.isFinite(summary.endTime) ? -new Date(summary.endTime).getTimezoneOffset() : 0);
  b.write(ACTIVITY, {
    timestamp: end,
    totalTimerTime: summary.durationS,
    numSessions: 1,
    type: ACTIVITY_TYPE_MANUAL,
    event: EVENT_ACTIVITY,
    eventType: EVENT_TYPE_STOP,
    localTimestamp: end === null ? null : end + Math.round((Number.isFinite(offsetMin) ? offsetMin : 0) * 60),
  });

  return b.finish();
}
