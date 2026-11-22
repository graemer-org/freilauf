import { describe, expect, it } from 'vitest';
import { Decoder, Stream } from '@garmin/fitsdk';
import type { RecordedRide, RideSample } from '../types';
import { encodeFit, toFitTimestamp, FIT_EPOCH_OFFSET_S } from './encodeFit';
import { rideSummary } from './summary';

const START = Date.UTC(2026, 10, 22, 17, 0, 0);

function makeRide(n: number, sample?: (i: number) => Partial<RideSample>): RecordedRide {
  const samples: RideSample[] = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const speed = 8 + (i % 7) * 0.25;
    dist += speed;
    samples.push({
      timestamp: START + (i + 1) * 1000,
      elapsedS: i + 1,
      powerW: 150 + (i % 50),
      cadenceRpm: 85 + (i % 10),
      heartRateBpm: i % 4 === 0 ? null : 120 + (i % 30),
      speedMps: speed,
      distanceM: dist,
      gradePercent: 0,
      gear: 5,
      ...sample?.(i),
    });
  }
  return { id: 'ride-1', name: 'Test', startedAt: START, riderMassKg: 75, samples };
}

function decode(bytes: Uint8Array) {
  const stream = Stream.fromByteArray(bytes);
  expect(Decoder.isFIT(stream)).toBe(true);
  const decoder = new Decoder(stream);
  expect(decoder.checkIntegrity()).toBe(true);
  const { messages, errors } = decoder.read({ convertTypesToStrings: true, convertDateTimesToDates: true });
  expect(errors).toEqual([]);
  return messages;
}

const fitDate = (unixMs: number) => new Date(Math.floor(unixMs / 1000) * 1000);

describe('toFitTimestamp', () => {
  it('converts from the Unix epoch to the FIT epoch', () => {
    expect(toFitTimestamp(Date.UTC(1989, 11, 31) + 0x10000000 * 1000)).toBe(0x10000000);
    expect(toFitTimestamp(START)).toBe(START / 1000 - FIT_EPOCH_OFFSET_S);
    expect(toFitTimestamp(Number.NaN)).toBeNull();
  });
});

describe('encodeFit', () => {
  it('writes a valid activity with round-tripped records', () => {
    const ride = makeRide(600);
    const msgs = decode(encodeFit(ride));

    expect(msgs.fileIdMesgs?.[0]).toMatchObject({
      type: 'activity',
      manufacturer: 'development',
      product: 0,
      timeCreated: fitDate(START),
    });
    expect(msgs.fileIdMesgs?.[0]?.serialNumber).toBeGreaterThan(0);

    const events = msgs.eventMesgs ?? [];
    expect(events[0]).toMatchObject({ event: 'timer', eventType: 'start', timestamp: fitDate(START) });
    expect(events[events.length - 1]).toMatchObject({ event: 'timer', eventType: 'stopAll' });

    const records = msgs.recordMesgs ?? [];
    expect(records).toHaveLength(600);
    ride.samples.forEach((s, i) => {
      const r = records[i]!;
      expect(r.timestamp).toEqual(fitDate(s.timestamp));
      expect(r.power).toBe(s.powerW);
      expect(r.cadence).toBe(s.cadenceRpm);
      if (s.heartRateBpm === null) expect(r.heartRate).toBeUndefined();
      else expect(r.heartRate).toBe(s.heartRateBpm);
      expect(r.speed).toBeCloseTo(s.speedMps, 3);
      expect(r.enhancedSpeed).toBeCloseTo(s.speedMps, 3);
      expect(r.distance).toBeCloseTo(s.distanceM, 2);
      expect(r.positionLat).toBeUndefined();
    });

    const sum = rideSummary(ride);
    const session = msgs.sessionMesgs?.[0];
    expect(msgs.sessionMesgs).toHaveLength(1);
    expect(session).toMatchObject({
      sport: 'cycling',
      subSport: 'virtualActivity',
      startTime: fitDate(START),
      totalElapsedTime: 600,
      totalTimerTime: 600,
      numLaps: 1,
      maxPower: 199,
      maxCadence: 94,
      maxHeartRate: sum.maxHeartRateBpm,
      avgHeartRate: Math.round(sum.avgHeartRateBpm!),
      avgPower: Math.round(sum.avgPowerW),
      totalWork: Math.round(sum.workKj * 1000),
      totalCalories: Math.round(sum.caloriesKcal),
    });
    expect(session?.totalDistance).toBeCloseTo(sum.distanceM, 2);
    expect(session?.avgSpeed).toBeCloseTo(sum.avgSpeedMps, 3);
    expect(session?.maxSpeed).toBeCloseTo(9.5, 3);

    expect(msgs.lapMesgs).toHaveLength(1);
    expect(msgs.lapMesgs?.[0]).toMatchObject({
      startTime: fitDate(START),
      totalTimerTime: 600,
      sport: 'cycling',
      subSport: 'virtualActivity',
    });
    expect(msgs.activityMesgs?.[0]).toMatchObject({
      numSessions: 1,
      type: 'manual',
      event: 'activity',
      eventType: 'stop',
      totalTimerTime: 600,
    });
  });

  it('orders messages as recommended for activity files', () => {
    const bytes = encodeFit(makeRide(3));
    const nums: number[] = [];
    const decoder = new Decoder(Stream.fromByteArray(bytes));
    decoder.read({ mesgListener: (mesgNum: number) => nums.push(mesgNum) });
    const firstRecord = nums.indexOf(20);
    expect(nums.slice(0, 4)).toEqual([0, 49, 23, 21]); // file_id, file_creator, device_info, timer start
    expect(nums.slice(firstRecord - 1, firstRecord)).toEqual([21]); // timer start before records
    expect(nums.slice(-4)).toEqual([21, 19, 18, 34]); // stop_all, lap, session, activity
  });

  it('omits heart-rate summary fields when no HR was recorded', () => {
    const msgs = decode(encodeFit(makeRide(10, () => ({ heartRateBpm: null }))));
    expect(msgs.sessionMesgs?.[0]?.avgHeartRate).toBeUndefined();
    expect(msgs.sessionMesgs?.[0]?.maxHeartRate).toBeUndefined();
    expect(msgs.recordMesgs?.every((r) => r.heartRate === undefined)).toBe(true);
  });

  it('clamps out-of-range values and writes non-finite values as invalid', () => {
    const msgs = decode(
      encodeFit(
        makeRide(4, (i) =>
          i === 0
            ? { powerW: 100000, cadenceRpm: 400, heartRateBpm: 300, speedMps: -3 }
            : i === 1
              ? { powerW: Number.NaN, cadenceRpm: Number.POSITIVE_INFINITY, heartRateBpm: Number.NaN }
              : {},
        ),
      ),
    );
    const [r0, r1] = msgs.recordMesgs ?? [];
    expect(r0).toMatchObject({ power: 0xfffe, cadence: 0xfe, heartRate: 0xfe, speed: 0 });
    expect(r1?.power).toBeUndefined();
    expect(r1?.cadence).toBeUndefined();
    expect(r1?.heartRate).toBeUndefined();
    expect(msgs.recordMesgs).toHaveLength(4);
  });

  it('skips samples without a usable timestamp', () => {
    const msgs = decode(encodeFit(makeRide(5, (i) => (i === 2 ? { timestamp: Number.NaN } : {}))));
    expect(msgs.recordMesgs).toHaveLength(4);
  });

  it('emits timer stop/start around pauses', () => {
    // 10 s wall-clock gap after sample 4, elapsed time continues normally.
    const ride = makeRide(8, (i) => (i >= 5 ? { timestamp: START + (i + 11) * 1000 } : {}));
    const msgs = decode(encodeFit(ride));
    const types = (msgs.eventMesgs ?? []).map((e) => e.eventType);
    expect(types).toEqual(['start', 'stop', 'start', 'stopAll']);
    expect(msgs.sessionMesgs?.[0]).toMatchObject({ totalTimerTime: 8, totalElapsedTime: 18 });
  });

  it('encodes an empty ride as a valid, decodable file', () => {
    const ride: RecordedRide = { id: 'x', name: 'Empty', startedAt: START, riderMassKg: 70, samples: [] };
    const msgs = decode(encodeFit(ride));
    expect(msgs.recordMesgs ?? []).toHaveLength(0);
    expect(msgs.sessionMesgs?.[0]).toMatchObject({
      sport: 'cycling',
      subSport: 'virtualActivity',
      totalTimerTime: 0,
      totalElapsedTime: 0,
      totalDistance: 0,
    });
    expect(msgs.activityMesgs).toHaveLength(1);
  });

  it('handles a 2 h ride quickly and compactly', () => {
    const ride = makeRide(7200);
    const t0 = Date.now();
    const bytes = encodeFit(ride);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(500);
    // 7200 records × (1 header + 22 data bytes) plus a few hundred bytes of overhead.
    expect(bytes.length).toBeLessThan(7200 * 23 + 2000);
    const msgs = decode(bytes);
    expect(msgs.recordMesgs).toHaveLength(7200);
    expect(msgs.sessionMesgs?.[0]?.totalTimerTime).toBe(7200);
  });
});

describe('rideSummary', () => {
  it('aggregates duration, distance, power, HR and work', () => {
    const s = rideSummary(makeRide(100, () => ({ powerW: 200 })));
    expect(s.durationS).toBe(100);
    expect(s.avgPowerW).toBe(200);
    expect(s.maxPowerW).toBe(200);
    expect(s.workKj).toBeCloseTo(20, 6);
    expect(s.caloriesKcal).toBeCloseTo(20, 6);
    expect(s.avgHeartRateBpm).not.toBeNull();
    expect(s.distanceM).toBeGreaterThan(0);
  });

  it('is all zeros / null for an empty ride', () => {
    const s = rideSummary({ id: 'x', name: '', startedAt: START, riderMassKg: 70, samples: [] });
    expect(s).toMatchObject({ durationS: 0, distanceM: 0, avgPowerW: 0, workKj: 0, avgHeartRateBpm: null, sampleCount: 0 });
  });
});
