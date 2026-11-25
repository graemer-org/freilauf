import { describe, expect, it } from 'vitest';
import { Decoder, Stream } from '@garmin/fitsdk';
import type { RecordedRide, RideSample } from '../types';
import { encodeFit, toFitTimestamp, FIT_EPOCH_OFFSET_S } from './encodeFit';
import { normalizedPower, rideSummary, splitAtJumps } from './summary';

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
  const { messages, errors } = decoder.read({
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
  });
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
    expect(events[0]).toMatchObject({
      event: 'timer',
      eventType: 'start',
      timestamp: fitDate(START),
    });
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
              ? {
                  powerW: Number.NaN,
                  cadenceRpm: Number.POSITIVE_INFINITY,
                  heartRateBpm: Number.NaN,
                }
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
    const ride: RecordedRide = {
      id: 'x',
      name: 'Empty',
      startedAt: START,
      riderMassKg: 70,
      samples: [],
    };
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

describe('encodeFit with positions (route rides)', () => {
  const lat0 = 47.123456;
  const lon0 = -11.654321;
  const withPos = (n: number) =>
    makeRide(n, (i) => ({
      lat: lat0 + i * 1e-5,
      lon: lon0 - i * 2e-5,
      altitudeM: i < n / 2 ? 600 + i * 0.5 : 600 + (n - i) * 0.5,
    }));

  it('writes record positions within centimetres and altitude with scale 5 / offset 500', () => {
    const ride = withPos(300);
    const msgs = decode(encodeFit(ride));
    const records = msgs.recordMesgs ?? [];
    expect(records).toHaveLength(300);
    const semi = 180 / 2 ** 31;
    ride.samples.forEach((s, i) => {
      const r = records[i]!;
      const lat = (r.positionLat as number) * semi;
      const lon = (r.positionLong as number) * semi;
      // 1 semicircle ≈ 0.9 cm; allow 2 cm.
      expect(Math.abs(lat - s.lat!) * 111_320).toBeLessThan(0.02);
      expect(Math.abs(lon - s.lon!) * 111_320 * Math.cos((lat0 * Math.PI) / 180)).toBeLessThan(
        0.02,
      );
      // Resolution 0.2 m (scale 5): within half of it.
      expect(Math.abs((r.altitude as number) - s.altitudeM!)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(Math.abs((r.enhancedAltitude as number) - s.altitudeM!)).toBeLessThanOrEqual(
        0.1 + 1e-9,
      );
      expect(r.power).toBe(s.powerW); // the usual fields are unchanged
    });
  });

  it('fills start/end position, bounding box, ascent and descent in lap and session', () => {
    const ride = withPos(400);
    const msgs = decode(encodeFit(ride));
    const semi = 180 / 2 ** 31;
    for (const m of [msgs.sessionMesgs?.[0], msgs.lapMesgs?.[0]]) {
      expect(m).toBeDefined();
      expect((m!.startPositionLat as number) * semi).toBeCloseTo(lat0, 6);
      expect((m!.startPositionLong as number) * semi).toBeCloseTo(lon0, 6);
      expect((m!.endPositionLat as number) * semi).toBeCloseTo(lat0 + 399e-5, 6);
      expect((m!.necLat as number) * semi).toBeCloseTo(lat0 + 399e-5, 6);
      expect((m!.swcLong as number) * semi).toBeCloseTo(lon0 - 399 * 2e-5, 6);
      expect(m!.totalAscent).toBeCloseTo(100, -1);
      expect(m!.totalDescent).toBeCloseTo(100, -1);
      expect(m!.enhancedMaxAltitude).toBeCloseTo(700, 0);
      expect(m!.subSport).toBe('virtualActivity');
    }
  });

  it('negative coordinates and the antimeridian side encode correctly', () => {
    const msgs = decode(
      encodeFit(makeRide(3, () => ({ lat: -33.9, lon: 179.99, altitudeM: -20 }))),
    );
    const r = msgs.recordMesgs![0]!;
    expect((r.positionLat as number) * (180 / 2 ** 31)).toBeCloseTo(-33.9, 6);
    expect((r.positionLong as number) * (180 / 2 ** 31)).toBeCloseTo(179.99, 6);
    expect(r.enhancedAltitude).toBeCloseTo(-20, 1);
  });

  it('rides without positions keep the old record layout (no position fields)', () => {
    const plain = encodeFit(makeRide(50));
    const msgs = decode(plain);
    expect(msgs.recordMesgs?.[0]?.positionLat).toBeUndefined();
    expect(msgs.sessionMesgs?.[0]?.startPositionLat).toBeUndefined();
    expect(msgs.sessionMesgs?.[0]?.totalAscent).toBeUndefined();
    // Positioned records are 18 bytes larger (4 + 4 + 2 + 4 + … per record).
    expect(encodeFit(withPos(50)).length).toBeGreaterThan(plain.length + 50 * 14);
  });
});

describe('rideSummary', () => {
  it('aggregates duration, distance, power, HR and work', () => {
    const s = rideSummary(makeRide(100, () => ({ powerW: 200 })));
    expect(s.durationS).toBe(100);
    expect(s.avgPowerW).toBe(200);
    expect(s.maxPowerW).toBe(200);
    expect(s.workKj).toBeCloseTo(20, 6);
    // 20 kJ / (4.184 × 0.24) — docs/energy.md
    expect(s.caloriesKcal).toBeCloseTo(20 / 1.00416, 6);
    expect(s.fatCaloriesKcal).toBeNull(); // no FTP stored with the ride
    expect(s.avgHeartRateBpm).not.toBeNull();
    expect(s.distanceM).toBeGreaterThan(0);
  });

  it('is all zeros / null for an empty ride', () => {
    const s = rideSummary({ id: 'x', name: '', startedAt: START, riderMassKg: 70, samples: [] });
    expect(s).toMatchObject({
      durationS: 0,
      distanceM: 0,
      avgPowerW: 0,
      workKj: 0,
      avgHeartRateBpm: null,
      sampleCount: 0,
    });
  });
});

describe('encodeFit with jumps along the route (route segments)', () => {
  const semi = 180 / 2 ** 31;
  /**
   * Segments of 100 samples each; every segment climbs 50 m from its own base far from the
   * previous one (a jump of several km and hundreds of metres of elevation in between).
   */
  const jumped = (bases: { lat: number; lon: number; alt: number }[]) =>
    makeRide(bases.length * 100, (i) => {
      const k = Math.floor(i / 100);
      const j = i % 100;
      const b = bases[k]!;
      return {
        lat: b.lat + j * 1e-5,
        lon: b.lon,
        altitudeM: b.alt + j * 0.5,
        ...(k > 0 ? { segment: k } : {}),
      };
    });
  const A = { lat: 47.1, lon: -11.6, alt: 600 };
  const B = { lat: 47.3, lon: -11.6, alt: 900 }; // ~22 km north, 300 m higher
  const C = { lat: 47.0, lon: -11.6, alt: 400 }; // back south, 500 m lower

  it('one jump: two laps that start and end where the road was ridden', () => {
    const ride = jumped([A, B]);
    const msgs = decode(encodeFit(ride));
    const laps = msgs.lapMesgs ?? [];
    expect(laps).toHaveLength(2);
    expect(msgs.sessionMesgs?.[0]?.numLaps).toBe(2);
    expect(laps.map((l) => l.lapTrigger)).toEqual(['manual', 'sessionEnd']);
    expect(laps.map((l) => l.messageIndex)).toEqual([0, 1]);
    const [l0, l1] = laps as [Record<string, unknown>, Record<string, unknown>];
    expect((l0.startPositionLat as number) * semi).toBeCloseTo(A.lat, 6);
    expect((l0.endPositionLat as number) * semi).toBeCloseTo(A.lat + 99e-5, 6);
    expect((l1.startPositionLat as number) * semi).toBeCloseTo(B.lat, 6);
    expect((l1.endPositionLat as number) * semi).toBeCloseTo(B.lat + 99e-5, 6);
    // Each lap's box covers only its own road: no lap spans the gap.
    expect((l0.necLat as number) * semi).toBeLessThan(A.lat + 0.01);
    expect((l1.swcLat as number) * semi).toBeGreaterThan(B.lat - 0.01);
    // Ascent: what was ridden (2 × ~50 m), not the 300 m across the jump.
    expect(l0.totalAscent).toBeCloseTo(50, -1);
    expect(l1.totalAscent).toBeCloseTo(50, -1);
    const session = msgs.sessionMesgs![0]!;
    expect(session.totalAscent).toBeCloseTo(100, -1);
    expect(session.totalDescent).toBe(0);
    // The session spans both legs (start of the first, end of the last, box over all).
    expect((session.startPositionLat as number) * semi).toBeCloseTo(A.lat, 6);
    expect((session.endPositionLat as number) * semi).toBeCloseTo(B.lat + 99e-5, 6);
    expect((session.necLat as number) * semi).toBeCloseTo(B.lat + 99e-5, 6);
    expect(session.enhancedMaxAltitude).toBeCloseTo(949.5, 0);
    // Time, distance and work keep counting what was ridden: the laps add up to the session.
    const sum = (k: string) =>
      laps.reduce((a, l) => a + ((l as Record<string, unknown>)[k] as number), 0);
    expect(sum('totalTimerTime')).toBeCloseTo(session.totalTimerTime as number, 3);
    expect(sum('totalElapsedTime')).toBeCloseTo(session.totalElapsedTime as number, 3);
    expect(sum('totalDistance')).toBeCloseTo(session.totalDistance as number, 1);
    expect(Math.abs(sum('totalWork') - (session.totalWork as number))).toBeLessThanOrEqual(2);
    expect(l1.startTime).toEqual(l0.timestamp); // lap 2 starts where lap 1 ended
    // Records: distance is continuous across the jump; the position restarts.
    const records = msgs.recordMesgs ?? [];
    expect(records).toHaveLength(200);
    expect(records[100]!.distance as number).toBeGreaterThan(records[99]!.distance as number);
    expect((records[100]!.distance as number) - (records[99]!.distance as number)).toBeLessThan(10);
    expect((records[100]!.positionLat as number) * semi).toBeCloseTo(B.lat, 6);
    // No timer stop/start at the jump: the ride did not pause.
    expect((msgs.eventMesgs ?? []).map((e) => e.eventType)).toEqual(['start', 'stopAll']);
  });

  it('several jumps: one lap per segment, totals only from ridden road', () => {
    const ride = jumped([A, B, C, A]);
    const bytes = encodeFit(ride);
    const msgs = decode(bytes);
    const laps = msgs.lapMesgs ?? [];
    expect(laps).toHaveLength(4);
    expect(laps.map((l) => l.lapTrigger)).toEqual(['manual', 'manual', 'manual', 'sessionEnd']);
    for (const l of laps) {
      expect(l.totalAscent).toBeCloseTo(50, -1);
      expect(l.totalDescent).toBe(0);
      expect(l.totalTimerTime).toBe(100);
      expect(l.subSport).toBe('virtualActivity');
    }
    expect(msgs.sessionMesgs?.[0]).toMatchObject({ numLaps: 4, totalTimerTime: 400 });
    expect(msgs.sessionMesgs?.[0]?.totalAscent).toBeCloseTo(200, -1);
    expect(msgs.sessionMesgs?.[0]?.totalDescent).toBe(0);
    // Message order: stop_all, the laps, session, activity.
    const nums: number[] = [];
    new Decoder(Stream.fromByteArray(bytes)).read({ mesgListener: (n: number) => nums.push(n) });
    expect(nums.slice(-7)).toEqual([21, 19, 19, 19, 19, 18, 34]);
  });

  it('a ride without jumps still has exactly one lap', () => {
    const msgs = decode(encodeFit(jumped([A])));
    expect(msgs.lapMesgs).toHaveLength(1);
    expect(msgs.lapMesgs?.[0]?.lapTrigger).toBe('sessionEnd');
  });
  /** Samples of one segment: `n` seconds at `speed` m/s from `base`, continuing time/distance of `prev`. */
  function leg(
    prev: RideSample | undefined,
    n: number,
    o: {
      base: { lat: number; lon: number; alt: number };
      segment: number;
      speed: number;
      pauseS?: number;
    },
  ): RideSample[] {
    const out: RideSample[] = [];
    let t = prev ? prev.timestamp + (o.pauseS ?? 0) * 1000 : START;
    let e = prev?.elapsedS ?? 0;
    let d = prev?.distanceM ?? 0;
    let travelled = 0;
    for (let i = 0; i < n; i++) {
      t += 1000;
      e += 1;
      d += o.speed;
      out.push({
        timestamp: t,
        elapsedS: e,
        powerW: o.speed > 0 ? 180 : 0,
        cadenceRpm: o.speed > 0 ? 85 : 0,
        heartRateBpm: 120,
        speedMps: o.speed,
        distanceM: d,
        gradePercent: 0,
        gear: 5,
        lat: o.base.lat + travelled / 111_000,
        lon: o.base.lon,
        altitudeM: o.base.alt + travelled * 0.01,
        ...(o.segment > 0 ? { segment: o.segment } : {}),
      });
      travelled += o.speed;
    }
    return out;
  }
  const rideOf = (samples: RideSample[]): RecordedRide => ({
    id: 'ride-j',
    name: 'Jumps',
    startedAt: START,
    riderMassKg: 75,
    samples,
  });

  it('a jump before any distance was ridden does not make a 1 s lap (the ride of 2026-11-25)', () => {
    // Start, pause after one second, move the start point while paused, resume ~7 min later.
    const before = leg(undefined, 1, { base: A, segment: 0, speed: 0 });
    const after = leg(before[0], 300, { base: B, segment: 1, speed: 8, pauseS: 413 });
    const ride = rideOf([...before, ...after]);
    expect(splitAtJumps(ride.samples)).toHaveLength(1);
    const msgs = decode(encodeFit(ride));
    const laps = msgs.lapMesgs ?? [];
    expect(laps).toHaveLength(1);
    const lap = laps[0]!;
    const session = msgs.sessionMesgs![0]!;
    expect(lap.lapTrigger).toBe('sessionEnd');
    expect(session.numLaps).toBe(1);
    expect(lap.totalTimerTime).toBe(301);
    expect(session.totalTimerTime).toBe(301);
    expect(lap.startTime).toEqual(session.startTime);
    // Positions: where the riding began, after the jump; nothing from the unridden start point.
    for (const m of [lap, session]) {
      expect((m.startPositionLat as number) * semi).toBeCloseTo(B.lat, 6);
      expect((m.swcLat as number) * semi).toBeGreaterThan(B.lat - 1e-6);
      expect(m.enhancedMinAltitude as number).toBeGreaterThanOrEqual(B.alt - 0.2);
      expect(m.enhancedMaxAltitude as number).toBeLessThan(B.alt + 30);
      expect(m.totalAscent as number).toBeLessThan(30);
    }
    // Every sample is still recorded; the pre-jump one has no position.
    const records = msgs.recordMesgs ?? [];
    expect(records).toHaveLength(301);
    expect(records[0]!.positionLat).toBeUndefined();
    expect(records[0]!.enhancedAltitude).toBeUndefined();
    expect(records[0]!.heartRate).toBe(120);
    expect((records[1]!.positionLat as number) * semi).toBeCloseTo(B.lat, 6);
    // The pause is still marked.
    expect((msgs.eventMesgs ?? []).map((e) => e.eventType)).toEqual([
      'start',
      'stop',
      'start',
      'stopAll',
    ]);
  });

  it('a jump mid-ride still makes two laps', () => {
    const first = leg(undefined, 120, { base: A, segment: 0, speed: 8 });
    const second = leg(first.at(-1), 120, { base: B, segment: 1, speed: 8 });
    const msgs = decode(encodeFit(rideOf([...first, ...second])));
    const laps = msgs.lapMesgs ?? [];
    expect(laps).toHaveLength(2);
    expect(laps.map((l) => l.totalTimerTime)).toEqual([120, 120]);
    expect((laps[0]!.startPositionLat as number) * semi).toBeCloseTo(A.lat, 6);
    expect((laps[1]!.startPositionLat as number) * semi).toBeCloseTo(B.lat, 6);
    expect((msgs.recordMesgs ?? []).every((r) => r.positionLat !== undefined)).toBe(true);
  });

  it('several jumps in a row with no riding in between make one lap boundary', () => {
    const first = leg(undefined, 120, { base: A, segment: 0, speed: 8 });
    // jump, resume for a second without moving, pause, jump again, …
    const j1 = leg(first.at(-1), 1, { base: B, segment: 1, speed: 0, pauseS: 30 });
    const j2 = leg(j1.at(-1), 2, { base: C, segment: 2, speed: 0, pauseS: 30 });
    const last = leg(j2.at(-1), 120, { base: B, segment: 3, speed: 8, pauseS: 30 });
    const ride = rideOf([...first, ...j1, ...j2, ...last]);
    const msgs = decode(encodeFit(ride));
    const laps = msgs.lapMesgs ?? [];
    expect(laps).toHaveLength(2);
    expect(msgs.sessionMesgs![0]!.numLaps).toBe(2);
    expect(laps.map((l) => l.totalTimerTime)).toEqual([120, 123]);
    expect((laps[1]!.startPositionLat as number) * semi).toBeCloseTo(B.lat, 6);
    expect(laps[1]!.enhancedMinAltitude as number).toBeGreaterThanOrEqual(B.alt - 0.2);
    const records = msgs.recordMesgs ?? [];
    expect(records.slice(120, 123).every((r) => r.positionLat === undefined)).toBe(true);
    expect(records[123]!.positionLat).toBeDefined();
  });

  it('a jump at the very end without riding is folded into the last lap', () => {
    const first = leg(undefined, 120, { base: A, segment: 0, speed: 8 });
    const tail = leg(first.at(-1), 2, { base: B, segment: 1, speed: 0, pauseS: 10 });
    const msgs = decode(encodeFit(rideOf([...first, ...tail])));
    expect(msgs.lapMesgs).toHaveLength(1);
    const lap = msgs.lapMesgs![0]!;
    expect(lap.totalTimerTime).toBe(122);
    expect((lap.endPositionLat as number) * semi).toBeCloseTo(A.lat + (119 * 8) / 111_000, 6);
  });
});

describe('normalized power', () => {
  const flat = (watts: (i: number) => number, n: number) =>
    makeRide(n, (i) => ({ powerW: watts(i) })).samples;

  it('equals the power of a constant effort and is null under 30 s', () => {
    expect(normalizedPower(flat(() => 200, 600))).toBeCloseTo(200, 9);
    expect(normalizedPower(flat(() => 200, 29))).toBeNull();
    expect(normalizedPower(flat(() => 200, 30))).toBeCloseTo(200, 9);
  });

  it('weights hard efforts: 30 s on / 30 s off is above the average power', () => {
    const p = (i: number) => (Math.floor(i / 30) % 2 === 0 ? 400 : 0);
    const samples = flat(p, 1200);
    // reference: straightforward O(n·30) computation
    const watts = samples.map((s) => s.powerW);
    let acc = 0;
    let n = 0;
    for (let i = 29; i < watts.length; i++) {
      const avg = watts.slice(i - 29, i + 1).reduce((a, b) => a + b, 0) / 30;
      acc += avg ** 4;
      n++;
    }
    const np = normalizedPower(samples)!;
    expect(np).toBeCloseTo((acc / n) ** 0.25, 6);
    expect(np).toBeGreaterThan(
      rideSummary(makeRide(1200, (i) => ({ powerW: p(i) }))).avgPowerW + 50,
    );
  });

  it('is written to the session and the laps', () => {
    const msgs = decode(encodeFit(makeRide(600, (i) => ({ powerW: i < 300 ? 100 : 300 }))));
    const session = msgs.sessionMesgs![0]!;
    const expected = Math.round(
      normalizedPower(makeRide(600, (i) => ({ powerW: i < 300 ? 100 : 300 })).samples)!,
    );
    expect(session.normalizedPower).toBe(expected);
    expect(msgs.lapMesgs![0]!.normalizedPower).toBe(expected);
    // FTP is not known to the encoder: no intensity factor / TSS.
    expect(session.intensityFactor).toBeUndefined();
    expect(session.trainingStressScore).toBeUndefined();
  });

  it('per lap when the ride has jumps; absent for a ride shorter than 30 s', () => {
    const ride = makeRide(200, (i) => ({
      powerW: i < 100 ? 150 : 250,
      lat: 47 + (i % 100) * 1e-5,
      lon: 11,
      altitudeM: 500,
      ...(i >= 100 ? { segment: 1 } : {}),
    }));
    const msgs = decode(encodeFit(ride));
    expect(msgs.lapMesgs!.map((l) => l.normalizedPower)).toEqual([150, 250]);
    expect(decode(encodeFit(makeRide(20))).sessionMesgs![0]!.normalizedPower).toBeUndefined();
  });
});

describe('energy in the FIT file', () => {
  it('writes total_calories as kJ / (4.184 × 0.24) and no fat calories without FTP', () => {
    const ride = makeRide(600, () => ({ powerW: 200 })); // 120 kJ
    const msgs = decode(encodeFit(ride));
    expect(msgs.sessionMesgs?.[0]?.totalCalories).toBe(Math.round(120 / 1.00416)); // 120
    expect(msgs.lapMesgs?.[0]?.totalCalories).toBe(120);
    expect(msgs.sessionMesgs?.[0]?.totalFatCalories).toBeUndefined();
    expect(msgs.lapMesgs?.[0]?.totalFatCalories).toBeUndefined();
  });

  it('writes total_fat_calories from the FTP stored with the ride', () => {
    // 1 h at 150 W with FTP 300 (50 % FTP → 40 % VO2max → 70 % fat).
    const ride = { ...makeRide(3600, () => ({ powerW: 150 })), ftpW: 300 };
    const kcal = 540 / 1.00416;
    const msgs = decode(encodeFit(ride));
    expect(msgs.sessionMesgs?.[0]?.totalCalories).toBe(Math.round(kcal)); // 538
    expect(msgs.sessionMesgs?.[0]?.totalFatCalories).toBe(Math.round(0.7 * kcal)); // 376
    expect(msgs.lapMesgs?.[0]?.totalFatCalories).toBe(Math.round(0.7 * kcal));
  });

  it('per lap when the ride has jumps: the laps add up to the session', () => {
    const ride = {
      ...makeRide(600, (i) => ({
        powerW: 150,
        lat: 47 + i * 1e-5,
        lon: 8,
        altitudeM: 400,
        segment: i < 300 ? 0 : 1,
      })),
      ftpW: 300,
    };
    const msgs = decode(encodeFit(ride));
    const laps = msgs.lapMesgs ?? [];
    expect(laps).toHaveLength(2);
    const sum = laps.reduce((a, l) => a + (l.totalCalories as number), 0);
    expect(Math.abs(sum - (msgs.sessionMesgs?.[0]?.totalCalories as number))).toBeLessThanOrEqual(
      1,
    );
    for (const l of laps) expect(l.totalFatCalories).toBe(Math.round(0.7 * (45 / 1.00416)));
  });
});
