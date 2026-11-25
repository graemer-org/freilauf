import { describe, expect, it } from 'vitest';
import { CadenceFromCrankRevs, parseCyclingPowerMeasurement } from '../cyclingPower';
import { SpeedFromWheelRevs, parseCscMeasurement } from '../cyclingSpeedCadence';
import { parseIndoorBikeData } from '../ftms';
import { parseHeartRateMeasurement } from '../heartRate';
import { dataView } from '../testing/fakeGatt';
import { fromRelayHex, toRelayHex } from './encode';
import type { RelayInput, RelayUpdate } from './sensorRelayModel';
import {
  RELAY_SERVICE_KINDS,
  RelayUuid,
  SensorRelayModel,
  WHEEL_CIRCUMFERENCE_M,
  relayServices,
} from './sensorRelayModel';

const pick = (updates: RelayUpdate[], characteristic: string) =>
  updates.find((u) => u.characteristic === characteristic);

describe('relayServices', () => {
  it('builds the standard services with their constant values', () => {
    const all = relayServices(RELAY_SERVICE_KINDS);
    expect(all.map((s) => [s.kind, s.uuid.slice(4, 8)])).toEqual([
      ['heartRate', '180d'],
      ['power', '1818'],
      ['speedCadence', '1816'],
      ['trainer', '1826'],
    ]);
    const chars = Object.fromEntries(
      all.flatMap((s) =>
        s.characteristics.map((c) => [
          `${s.uuid.slice(4, 8)}/${c.uuid.slice(4, 8)}`,
          [c.properties.join('+'), toRelayHex(c.value)],
        ]),
      ),
    );
    expect(chars).toMatchObject({
      '180d/2a37': ['notify', '0400'],
      '180d/2a38': ['read', '01'],
      '1818/2a63': ['notify', '2000000000000000'],
      '1818/2a65': ['read', '08000000'],
      '1818/2a5d': ['read', '0d'],
      '1816/2a5b': ['notify', '0300000000000000000000'],
      '1816/2a5c': ['read', '0300'],
      '1816/2a5d': ['read', '0c'],
      '1816/2a55': ['write+indicate', ''],
      '1826/2acc': ['read', '0644000000000000'],
    });
    expect(relayServices(['power']).map((s) => s.kind)).toEqual(['power']);
    expect(relayServices([])).toEqual([]);
  });
});

/** Simulates the app: speed integrates into distance, sampled at 4 Hz. */
function ride(
  model: SensorRelayModel,
  seconds: number,
  input: (tS: number) => Omit<RelayInput, 'distanceM'> & { moving?: boolean },
  startMs = 0,
  startDistanceM = 0,
) {
  let distanceM = startDistanceM;
  const out: { tMs: number; updates: RelayUpdate[]; distanceM: number }[] = [];
  for (let tMs = startMs; tMs <= startMs + seconds * 1000; tMs += 250) {
    const i = input(tMs / 1000);
    if (tMs > startMs && i.moving !== false) distanceM += i.speedMps * 0.25;
    out.push({ tMs, updates: model.update(tMs, { ...i, distanceM }), distanceM });
  }
  return out;
}

describe('SensorRelayModel', () => {
  it('a watch-like receiver gets back HR, power, cadence, speed and distance', () => {
    const model = new SensorRelayModel(RELAY_SERVICE_KINDS);
    const cadence = new CadenceFromCrankRevs();
    const speed = new SpeedFromWheelRevs({ circumferenceM: WHEEL_CIRCUMFERENCE_M });
    let last = { hr: 0, power: 0, rpm: 0 as number | undefined, mps: 0 as number | undefined };
    let lastCsc = null as ReturnType<typeof parseCscMeasurement>;
    const samples = ride(model, 120, () => ({
      heartRateBpm: 142,
      powerW: 230,
      cadenceRpm: 88,
      speedMps: 9.2,
    }));
    for (const { tMs, updates } of samples) {
      const hr = parseHeartRateMeasurement(
        dataView(pick(updates, RelayUuid.heartRateMeasurement)!.value),
      )!;
      const cp = parseCyclingPowerMeasurement(
        dataView(pick(updates, RelayUuid.cyclingPowerMeasurement)!.value),
      )!;
      lastCsc = parseCscMeasurement(dataView(pick(updates, RelayUuid.cscMeasurement)!.value));
      last = {
        hr: hr.bpm,
        power: cp.powerW,
        rpm: cadence.update(cp.crank!, tMs),
        mps: speed.update(lastCsc!.wheel!, tMs),
      };
      expect(lastCsc!.crank).toEqual(cp.crank); // one crank counter for both services
    }
    expect(last.hr).toBe(142);
    expect(last.power).toBe(230);
    expect(last.rpm).toBeCloseTo(88, 0);
    expect(last.mps).toBeCloseTo(9.2, 1);
    const appDistance = samples.at(-1)!.distanceM;
    const watchDistance = lastCsc!.wheel!.cumulativeRevs * WHEEL_CIRCUMFERENCE_M;
    expect(appDistance - watchDistance).toBeGreaterThanOrEqual(0);
    expect(appDistance - watchDistance).toBeLessThan(WHEEL_CIRCUMFERENCE_M);
    const ftms = parseIndoorBikeData(
      dataView(pick(samples.at(-1)!.updates, RelayUuid.indoorBikeData)!.value),
    )!;
    expect(ftms.distanceM).toBe(Math.round(appDistance));
    expect(ftms.speedKph).toBeCloseTo(33.12, 2);
  });

  it('pause: the wheel stops (count and time held) while power and cadence carry on', () => {
    const model = new SensorRelayModel(['power', 'speedCadence']);
    const samples = ride(model, 30, (t) => ({
      heartRateBpm: null,
      powerW: 150,
      cadenceRpm: 80,
      speedMps: 8,
      moving: t < 10 || t >= 20,
    }));
    const csc = (i: number) =>
      parseCscMeasurement(dataView(pick(samples[i]!.updates, RelayUuid.cscMeasurement)!.value))!;
    const at10 = csc(41); // 10.25 s
    const at19 = csc(79);
    expect(at19.wheel).toEqual(at10.wheel);
    expect(at19.crank!.cumulativeRevs).toBeGreaterThan(at10.crank!.cumulativeRevs);
    const end = csc(samples.length - 1);
    expect(end.wheel!.cumulativeRevs).toBeGreaterThan(at19.wheel!.cumulativeRevs);
    // No HR strap: no heart-rate notification.
    expect(pick(samples[5]!.updates, RelayUuid.heartRateMeasurement)).toBeUndefined();
  });

  it('a new ride (distance back to 0) never runs the wheel counter backwards', () => {
    const model = new SensorRelayModel(['speedCadence']);
    const first = ride(model, 20, () => ({
      heartRateBpm: null,
      powerW: 0,
      cadenceRpm: 0,
      speedMps: 10,
    }));
    const revs = (u: RelayUpdate[]) =>
      parseCscMeasurement(dataView(pick(u, RelayUuid.cscMeasurement)!.value))!.wheel!
        .cumulativeRevs;
    const before = revs(first.at(-1)!.updates);
    const second = ride(
      model,
      10,
      () => ({ heartRateBpm: null, powerW: 0, cadenceRpm: 0, speedMps: 10 }),
      20_250,
      0,
    );
    const after = second.map((s) => revs(s.updates));
    for (const r of after) expect(r).toBeGreaterThanOrEqual(before);
    expect(after.at(-1)! - before).toBeGreaterThanOrEqual(
      Math.floor(100 / WHEEL_CIRCUMFERENCE_M) - 1,
    );
    expect(model.relayedDistanceM).toBeCloseTo(300, 0);
  });

  it('stale input: power 0, nothing turns', () => {
    const model = new SensorRelayModel(['power', 'heartRate']);
    model.update(0, { heartRateBpm: 100, powerW: 200, cadenceRpm: 90, speedMps: 5, distanceM: 0 });
    model.update(250, {
      heartRateBpm: 100,
      powerW: 200,
      cadenceRpm: 90,
      speedMps: 5,
      distanceM: 1,
    });
    const a = parseCyclingPowerMeasurement(
      dataView(pick(model.update(500, null), RelayUuid.cyclingPowerMeasurement)!.value),
    )!;
    const b = model.update(5000, null);
    expect(pick(b, RelayUuid.heartRateMeasurement)).toBeUndefined();
    const cp = parseCyclingPowerMeasurement(
      dataView(pick(b, RelayUuid.cyclingPowerMeasurement)!.value),
    )!;
    expect(cp.powerW).toBe(0);
    expect(cp.crank).toEqual(a.crank);
  });

  it('answers the SC control point: Set Cumulative Value resets the wheel count', () => {
    const model = new SensorRelayModel(['speedCadence']);
    ride(model, 10, () => ({ heartRateBpm: null, powerW: 0, cadenceRpm: 0, speedMps: 10 }));
    const reply = model.handleWrite(
      RelayUuid.cscService,
      RelayUuid.scControlPoint,
      fromRelayHex('0100000000'),
    );
    expect(reply.map((r) => toRelayHex(r.value))).toEqual(['100101']);
    expect(model.wheel.cumulativeRevs).toBe(0);
    expect(
      toRelayHex(
        model.handleWrite(RelayUuid.cscService, RelayUuid.scControlPoint, fromRelayHex('04'))[0]!
          .value,
      ),
    ).toBe('100402');
    expect(
      model.handleWrite(
        RelayUuid.heartRateService,
        RelayUuid.heartRateMeasurement,
        fromRelayHex('00'),
      ),
    ).toEqual([]);
  });
});
