/**
 * What Freilauf publishes when it acts as a Bluetooth sensor for a watch: the
 * GATT services (with their constant characteristics) and, from the app's
 * live values, the measurement notifications. Pure and clock-injected; the
 * Electron main process sends the bytes to the native helper, which only
 * forwards them (docs/adr/0005-sensor-relay.md).
 *
 * Derivation:
 *  - Cadence → crank revolutions: integrated over time (cadence / 60 per
 *    second); a new crank event only when a whole turn completes. One crank
 *    counter feeds both the power meter and the speed/cadence sensor.
 *  - Virtual speed/distance → wheel revolutions: the app's cumulative ride
 *    distance divided by a fixed wheel circumference (WHEEL_CIRCUMFERENCE_M,
 *    2105 mm = 700×25C), so the distance the watch computes from the wheel
 *    count matches the app's distance; the event time of the last whole turn
 *    is interpolated inside the update interval. A distance that goes down
 *    (a new ride) or jumps implausibly is taken as a new base, so the counter
 *    never runs backwards.
 *  - Paused or idle ride: the app's distance does not move, so the wheel
 *    stops (no new wheel events, time held). Power, cadence and heart rate are
 *    passed on as measured, like a real power meter that does not know about
 *    the app's pause.
 *  - No live values (stale): power 0, no crank or wheel events, no heart rate.
 */
import { RevolutionCounter } from './revolutions';
import {
  BodySensorLocation,
  CscFeatureBit,
  CyclingPowerFeatureBit,
  FitnessMachineFeatureBit,
  ScControlOp,
  ScControlResult,
  SensorLocation,
  encodeBodySensorLocation,
  encodeCscFeature,
  encodeCscMeasurement,
  encodeCyclingPowerFeature,
  encodeCyclingPowerMeasurement,
  encodeFitnessMachineFeature,
  encodeHeartRateMeasurement,
  encodeIndoorBikeData,
  encodeScControlPointResponse,
  encodeSensorLocation,
  parseScControlPointRequest,
} from './encode';
import { uuid16 } from '../uuids';

/** Wheel circumference used to turn virtual distance into wheel revolutions (700×25C). */
export const WHEEL_CIRCUMFERENCE_M = 2.105;

/** The groups of values a rider can choose to share. */
export type RelayServiceKind = 'heartRate' | 'power' | 'speedCadence' | 'trainer';

export const RELAY_SERVICE_KINDS: readonly RelayServiceKind[] = [
  'heartRate',
  'power',
  'speedCadence',
  'trainer',
];

export const RelayUuid = {
  heartRateService: uuid16(0x180d),
  heartRateMeasurement: uuid16(0x2a37),
  bodySensorLocation: uuid16(0x2a38),
  cyclingPowerService: uuid16(0x1818),
  cyclingPowerMeasurement: uuid16(0x2a63),
  cyclingPowerFeature: uuid16(0x2a65),
  sensorLocation: uuid16(0x2a5d),
  cscService: uuid16(0x1816),
  cscMeasurement: uuid16(0x2a5b),
  cscFeature: uuid16(0x2a5c),
  scControlPoint: uuid16(0x2a55),
  ftmsService: uuid16(0x1826),
  ftmsFeature: uuid16(0x2acc),
  indoorBikeData: uuid16(0x2ad2),
} as const;

export const RELAY_SERVICE_UUID: Record<RelayServiceKind, string> = {
  heartRate: RelayUuid.heartRateService,
  power: RelayUuid.cyclingPowerService,
  speedCadence: RelayUuid.cscService,
  trainer: RelayUuid.ftmsService,
};

export type GattProperty = 'read' | 'notify' | 'indicate' | 'write';

export interface RelayCharacteristic {
  uuid: string;
  properties: GattProperty[];
  value: Uint8Array;
}

export interface RelayService {
  kind: RelayServiceKind;
  uuid: string;
  characteristics: RelayCharacteristic[];
}

/** One characteristic value to set (and notify/indicate). */
export interface RelayUpdate {
  service: string;
  characteristic: string;
  value: Uint8Array;
}

/** The live values the relay is fed from (the main window's ride snapshot). */
export interface RelayInput {
  heartRateBpm: number | null;
  powerW: number;
  cadenceRpm: number;
  /** Virtual speed, m/s. */
  speedMps: number;
  /** Cumulative ride distance, m. */
  distanceM: number;
}

const CPS_FEATURES = CyclingPowerFeatureBit.CrankRevolutionData;
const CSC_FEATURES = CscFeatureBit.WheelRevolutionData | CscFeatureBit.CrankRevolutionData;
const FTMS_FEATURES =
  FitnessMachineFeatureBit.Cadence |
  FitnessMachineFeatureBit.TotalDistance |
  FitnessMachineFeatureBit.PowerMeasurement |
  FitnessMachineFeatureBit.HeartRateMeasurement;

/** The GATT services for the chosen kinds, in a stable order, with initial values. */
export function relayServices(kinds: readonly RelayServiceKind[]): RelayService[] {
  const out: RelayService[] = [];
  const want = (k: RelayServiceKind) => kinds.includes(k);
  if (want('heartRate')) {
    out.push({
      kind: 'heartRate',
      uuid: RelayUuid.heartRateService,
      characteristics: [
        {
          uuid: RelayUuid.heartRateMeasurement,
          properties: ['notify'],
          value: encodeHeartRateMeasurement({ bpm: 0, sensorContact: false }),
        },
        {
          uuid: RelayUuid.bodySensorLocation,
          properties: ['read'],
          value: encodeBodySensorLocation(BodySensorLocation.Chest),
        },
      ],
    });
  }
  if (want('power')) {
    out.push({
      kind: 'power',
      uuid: RelayUuid.cyclingPowerService,
      characteristics: [
        {
          uuid: RelayUuid.cyclingPowerMeasurement,
          properties: ['notify'],
          value: encodeCyclingPowerMeasurement({
            powerW: 0,
            crank: { cumulativeRevs: 0, lastEventTime1024: 0 },
          }),
        },
        {
          uuid: RelayUuid.cyclingPowerFeature,
          properties: ['read'],
          value: encodeCyclingPowerFeature(CPS_FEATURES),
        },
        {
          uuid: RelayUuid.sensorLocation,
          properties: ['read'],
          value: encodeSensorLocation(SensorLocation.RearHub),
        },
      ],
    });
  }
  if (want('speedCadence')) {
    out.push({
      kind: 'speedCadence',
      uuid: RelayUuid.cscService,
      characteristics: [
        {
          uuid: RelayUuid.cscMeasurement,
          properties: ['notify'],
          value: encodeCscMeasurement({
            wheel: { cumulativeRevs: 0, lastEventTime1024: 0 },
            crank: { cumulativeRevs: 0, lastEventTime1024: 0 },
          }),
        },
        {
          uuid: RelayUuid.cscFeature,
          properties: ['read'],
          value: encodeCscFeature(CSC_FEATURES),
        },
        {
          uuid: RelayUuid.sensorLocation,
          properties: ['read'],
          value: encodeSensorLocation(SensorLocation.RearWheel),
        },
        // Mandatory with wheel revolution data: lets a watch reset the wheel count.
        {
          uuid: RelayUuid.scControlPoint,
          properties: ['write', 'indicate'],
          value: new Uint8Array(0),
        },
      ],
    });
  }
  if (want('trainer')) {
    out.push({
      kind: 'trainer',
      uuid: RelayUuid.ftmsService,
      characteristics: [
        {
          uuid: RelayUuid.ftmsFeature,
          properties: ['read'],
          value: encodeFitnessMachineFeature(FTMS_FEATURES, 0),
        },
        {
          uuid: RelayUuid.indoorBikeData,
          properties: ['notify'],
          value: encodeIndoorBikeData({ speedKph: 0, cadenceRpm: 0, distanceM: 0, powerW: 0 }),
        },
      ],
    });
  }
  return out;
}

/** Largest plausible distance step between two updates (≈ 400 km/h at 4 Hz). */
const MAX_STEP_M = 30;

export class SensorRelayModel {
  readonly kinds: readonly RelayServiceKind[];
  readonly circumferenceM: number;
  readonly crank: RevolutionCounter;
  readonly wheel: RevolutionCounter;
  #lastDistanceM: number | null = null;
  #lastMs: number | null = null;
  #distanceBaseM = 0;

  constructor(
    kinds: readonly RelayServiceKind[],
    options: {
      circumferenceM?: number;
      crank?: RevolutionCounter;
      wheel?: RevolutionCounter;
    } = {},
  ) {
    this.kinds = [...kinds];
    this.circumferenceM = options.circumferenceM ?? WHEEL_CIRCUMFERENCE_M;
    this.crank = options.crank ?? new RevolutionCounter({ ticksPerSecond: 1024, countBits: 16 });
    this.wheel = options.wheel ?? new RevolutionCounter({ ticksPerSecond: 1024, countBits: 32 });
  }

  /** Distance fed into the wheel counter so far, m (the sum of accepted distance steps). */
  get relayedDistanceM(): number {
    return this.#distanceBaseM;
  }

  /**
   * Advances the counters to `nowMs` and returns the notifications to send.
   * `input` null means "no fresh live values".
   */
  update(nowMs: number, input: RelayInput | null): RelayUpdate[] {
    const dtS = this.#lastMs === null ? 0 : Math.max(0, (nowMs - this.#lastMs) / 1000);
    this.#lastMs = nowMs;
    const cadence = input && input.cadenceRpm > 0 ? input.cadenceRpm : 0;
    const powerW = input ? input.powerW : 0;
    // Gaps longer than a few seconds (the app was busy, the helper restarted): no turns.
    const gap = dtS > 3;
    this.crank.advance(nowMs, gap ? 0 : (cadence / 60) * dtS);

    let stepM = 0;
    if (input && Number.isFinite(input.distanceM)) {
      const prev = this.#lastDistanceM;
      this.#lastDistanceM = input.distanceM;
      if (prev !== null) {
        const d = input.distanceM - prev;
        if (d > 0 && d <= MAX_STEP_M && !gap) stepM = d;
      }
    }
    this.#distanceBaseM += stepM;
    this.wheel.advance(nowMs, stepM / this.circumferenceM);

    const crank = {
      cumulativeRevs: this.crank.cumulativeRevs,
      lastEventTime1024: this.crank.lastEventTime,
    };
    const out: RelayUpdate[] = [];
    if (this.kinds.includes('heartRate') && input && input.heartRateBpm !== null) {
      out.push({
        service: RelayUuid.heartRateService,
        characteristic: RelayUuid.heartRateMeasurement,
        value: encodeHeartRateMeasurement({ bpm: input.heartRateBpm, sensorContact: true }),
      });
    }
    if (this.kinds.includes('power')) {
      out.push({
        service: RelayUuid.cyclingPowerService,
        characteristic: RelayUuid.cyclingPowerMeasurement,
        value: encodeCyclingPowerMeasurement({ powerW: Math.max(0, powerW), crank }),
      });
    }
    if (this.kinds.includes('speedCadence')) {
      out.push({
        service: RelayUuid.cscService,
        characteristic: RelayUuid.cscMeasurement,
        value: encodeCscMeasurement({
          wheel: {
            cumulativeRevs: this.wheel.cumulativeRevs,
            lastEventTime1024: this.wheel.lastEventTime,
          },
          crank,
        }),
      });
    }
    if (this.kinds.includes('trainer')) {
      out.push({
        service: RelayUuid.ftmsService,
        characteristic: RelayUuid.indoorBikeData,
        value: encodeIndoorBikeData({
          speedKph: input ? Math.max(0, input.speedMps) * 3.6 : 0,
          cadenceRpm: cadence,
          distanceM: this.#distanceBaseM,
          powerW: Math.max(0, powerW),
          heartRateBpm: input?.heartRateBpm ?? null,
        }),
      });
    }
    return out;
  }

  /**
   * A central wrote to a characteristic. Returns the indication to send back
   * (SC Control Point responses), or nothing.
   */
  handleWrite(service: string, characteristic: string, value: Uint8Array): RelayUpdate[] {
    if (service !== RelayUuid.cscService || characteristic !== RelayUuid.scControlPoint) return [];
    const req = parseScControlPointRequest(value);
    let opCode = value[0] ?? 0;
    let result: number = ScControlResult.OpCodeNotSupported;
    if (req.op === 'setCumulativeValue') {
      this.wheel.setCount(req.value);
      opCode = ScControlOp.SetCumulativeValue;
      result = ScControlResult.Success;
    } else if (req.op === 'invalid') {
      result =
        value.length === 0 ? ScControlResult.OpCodeNotSupported : ScControlResult.InvalidParameter;
    }
    return [
      {
        service,
        characteristic,
        value: encodeScControlPointResponse(opCode, result),
      },
    ];
  }
}
