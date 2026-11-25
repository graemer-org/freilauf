/** FIT profile subset (global message numbers, field numbers, enums) used by the encoder. */
import type { BaseType } from './writer';
import { ENUM, SINT32, UINT8, UINT16, UINT32, UINT32Z } from './writer';

export interface FieldSpec {
  readonly name: string;
  readonly num: number;
  readonly type: BaseType;
  readonly scale?: number;
  /** FIT offset in physical units: raw = (value + offset) × scale. */
  readonly offset?: number;
}

export interface MesgSpec {
  readonly globalNum: number;
  readonly fields: readonly FieldSpec[];
}

const f = (
  name: string,
  num: number,
  type: BaseType,
  scale?: number,
  offset?: number,
): FieldSpec =>
  offset !== undefined
    ? { name, num, type, scale: scale ?? 1, offset }
    : scale === undefined
      ? { name, num, type }
      : { name, num, type, scale };

// Common field numbers.
const TIMESTAMP = 253;
const MESSAGE_INDEX = 254;

export const FILE_ID: MesgSpec = {
  globalNum: 0,
  fields: [
    f('type', 0, ENUM),
    f('manufacturer', 1, UINT16),
    f('product', 2, UINT16),
    f('serialNumber', 3, UINT32Z),
    f('timeCreated', 4, UINT32),
  ],
};

export const FILE_CREATOR: MesgSpec = {
  globalNum: 49,
  fields: [f('softwareVersion', 0, UINT16)],
};

export const DEVICE_INFO: MesgSpec = {
  globalNum: 23,
  fields: [
    f('timestamp', TIMESTAMP, UINT32),
    f('deviceIndex', 0, UINT8),
    f('manufacturer', 2, UINT16),
    f('serialNumber', 3, UINT32Z),
    f('product', 4, UINT16),
    f('softwareVersion', 5, UINT16, 100),
  ],
};

export const EVENT: MesgSpec = {
  globalNum: 21,
  fields: [
    f('timestamp', TIMESTAMP, UINT32),
    f('event', 0, ENUM),
    f('eventType', 1, ENUM),
    f('eventGroup', 4, UINT8),
  ],
};

export const RECORD: MesgSpec = {
  globalNum: 20,
  fields: [
    f('timestamp', TIMESTAMP, UINT32),
    f('distance', 5, UINT32, 100),
    f('speed', 6, UINT16, 1000),
    f('enhancedSpeed', 73, UINT32, 1000),
    f('power', 7, UINT16),
    f('cadence', 4, UINT8),
    f('heartRate', 3, UINT8),
  ],
};

/**
 * Rides that followed a route also carry position and altitude. A separate definition, so
 * rides without positions encode exactly as before.
 */
export const RECORD_WITH_POSITION: MesgSpec = {
  globalNum: 20,
  fields: [
    ...RECORD.fields,
    f('positionLat', 0, SINT32),
    f('positionLong', 1, SINT32),
    f('altitude', 2, UINT16, 5, 500),
    f('enhancedAltitude', 78, UINT32, 5, 500),
  ],
};

/** Position/altitude summary fields of lap (19) and session (18), by field number. */
const positionFields = (n: {
  startPositionLat: number;
  startPositionLong: number;
  endPositionLat: number;
  endPositionLong: number;
  totalAscent: number;
  totalDescent: number;
  necLat: number;
  necLong: number;
  swcLat: number;
  swcLong: number;
  enhancedAvgAltitude: number;
  enhancedMinAltitude: number;
  enhancedMaxAltitude: number;
}): FieldSpec[] => [
  f('startPositionLat', n.startPositionLat, SINT32),
  f('startPositionLong', n.startPositionLong, SINT32),
  f('endPositionLat', n.endPositionLat, SINT32),
  f('endPositionLong', n.endPositionLong, SINT32),
  f('totalAscent', n.totalAscent, UINT16),
  f('totalDescent', n.totalDescent, UINT16),
  f('necLat', n.necLat, SINT32),
  f('necLong', n.necLong, SINT32),
  f('swcLat', n.swcLat, SINT32),
  f('swcLong', n.swcLong, SINT32),
  f('enhancedAvgAltitude', n.enhancedAvgAltitude, UINT32, 5, 500),
  f('enhancedMinAltitude', n.enhancedMinAltitude, UINT32, 5, 500),
  f('enhancedMaxAltitude', n.enhancedMaxAltitude, UINT32, 5, 500),
];

/** Summary fields shared (by name) between lap and session. */
const summaryFields = (n: {
  sport: number;
  subSport: number;
  totalCalories: number;
  totalFatCalories: number;
  avgSpeed: number;
  maxSpeed: number;
  avgHeartRate: number;
  maxHeartRate: number;
  avgCadence: number;
  maxCadence: number;
  avgPower: number;
  maxPower: number;
  totalWork: number;
  enhancedAvgSpeed: number;
  enhancedMaxSpeed: number;
}): FieldSpec[] => [
  f('timestamp', TIMESTAMP, UINT32),
  f('messageIndex', MESSAGE_INDEX, UINT16),
  f('event', 0, ENUM),
  f('eventType', 1, ENUM),
  f('startTime', 2, UINT32),
  f('totalElapsedTime', 7, UINT32, 1000),
  f('totalTimerTime', 8, UINT32, 1000),
  f('totalDistance', 9, UINT32, 100),
  f('totalCalories', n.totalCalories, UINT16),
  f('totalFatCalories', n.totalFatCalories, UINT16),
  f('avgSpeed', n.avgSpeed, UINT16, 1000),
  f('maxSpeed', n.maxSpeed, UINT16, 1000),
  f('enhancedAvgSpeed', n.enhancedAvgSpeed, UINT32, 1000),
  f('enhancedMaxSpeed', n.enhancedMaxSpeed, UINT32, 1000),
  f('avgHeartRate', n.avgHeartRate, UINT8),
  f('maxHeartRate', n.maxHeartRate, UINT8),
  f('avgCadence', n.avgCadence, UINT8),
  f('maxCadence', n.maxCadence, UINT8),
  f('avgPower', n.avgPower, UINT16),
  f('maxPower', n.maxPower, UINT16),
  f('totalWork', n.totalWork, UINT32),
  f('sport', n.sport, ENUM),
  f('subSport', n.subSport, ENUM),
];

export const LAP: MesgSpec = {
  globalNum: 19,
  fields: [
    ...summaryFields({
      sport: 25,
      subSport: 39,
      totalCalories: 11,
      totalFatCalories: 12,
      avgSpeed: 13,
      maxSpeed: 14,
      avgHeartRate: 15,
      maxHeartRate: 16,
      avgCadence: 17,
      maxCadence: 18,
      avgPower: 19,
      maxPower: 20,
      totalWork: 41,
      enhancedAvgSpeed: 110,
      enhancedMaxSpeed: 111,
    }),
    f('lapTrigger', 24, ENUM),
    f('normalizedPower', 33, UINT16),
  ],
};

export const SESSION: MesgSpec = {
  globalNum: 18,
  fields: [
    ...summaryFields({
      sport: 5,
      subSport: 6,
      totalCalories: 11,
      totalFatCalories: 13,
      avgSpeed: 14,
      maxSpeed: 15,
      avgHeartRate: 16,
      maxHeartRate: 17,
      avgCadence: 18,
      maxCadence: 19,
      avgPower: 20,
      maxPower: 21,
      totalWork: 48,
      enhancedAvgSpeed: 124,
      enhancedMaxSpeed: 125,
    }),
    f('firstLapIndex', 25, UINT16),
    f('numLaps', 26, UINT16),
    f('trigger', 28, ENUM),
    f('normalizedPower', 34, UINT16),
  ],
};

export const LAP_WITH_POSITION: MesgSpec = {
  globalNum: 19,
  fields: [
    ...LAP.fields,
    ...positionFields({
      startPositionLat: 3,
      startPositionLong: 4,
      endPositionLat: 5,
      endPositionLong: 6,
      totalAscent: 21,
      totalDescent: 22,
      necLat: 27,
      necLong: 28,
      swcLat: 29,
      swcLong: 30,
      enhancedAvgAltitude: 112,
      enhancedMinAltitude: 113,
      enhancedMaxAltitude: 114,
    }),
  ],
};

export const SESSION_WITH_POSITION: MesgSpec = {
  globalNum: 18,
  fields: [
    ...SESSION.fields,
    ...positionFields({
      startPositionLat: 3,
      startPositionLong: 4,
      endPositionLat: 38,
      endPositionLong: 39,
      totalAscent: 22,
      totalDescent: 23,
      necLat: 29,
      necLong: 30,
      swcLat: 31,
      swcLong: 32,
      enhancedAvgAltitude: 126,
      enhancedMinAltitude: 127,
      enhancedMaxAltitude: 128,
    }),
  ],
};

export const ACTIVITY: MesgSpec = {
  globalNum: 34,
  fields: [
    f('timestamp', TIMESTAMP, UINT32),
    f('totalTimerTime', 0, UINT32, 1000),
    f('numSessions', 1, UINT16),
    f('type', 2, ENUM),
    f('event', 3, ENUM),
    f('eventType', 4, ENUM),
    f('localTimestamp', 5, UINT32),
  ],
};

// Enum values (FIT profile).
export const FILE_TYPE_ACTIVITY = 4;
export const MANUFACTURER_DEVELOPMENT = 255;
export const SPORT_CYCLING = 2;
export const SUB_SPORT_VIRTUAL_ACTIVITY = 58;
export const EVENT_TIMER = 0;
export const EVENT_LAP = 9;
export const EVENT_SESSION = 8;
export const EVENT_ACTIVITY = 26;
export const EVENT_TYPE_START = 0;
export const EVENT_TYPE_STOP = 1;
export const EVENT_TYPE_STOP_ALL = 4;
export const LAP_TRIGGER_MANUAL = 0;
export const LAP_TRIGGER_SESSION_END = 7;
export const SESSION_TRIGGER_ACTIVITY_END = 0;
export const ACTIVITY_TYPE_MANUAL = 0;
