import { DEFAULT_BIKE, steadyStateSpeed } from '@freilauf/sim';
import { describe, expect, it } from 'vitest';
import { rideEnergy } from './energy';
import { RideSession } from './rideSession';

function setup() {
  let now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const session = new RideSession({ bike: DEFAULT_BIKE, riderMassKg: 75, now: () => now });
  /** Rides for the given seconds at 4 Hz, refreshing the sensors like real devices do. */
  const ride = (seconds: number, powerW: number | null, hr: number | null = 140) => {
    for (let i = 0; i < seconds * 4; i++) {
      now += 250;
      if (powerW !== null) {
        session.setPower(powerW);
        session.setCadence(90);
        if (hr !== null) session.setHeartRate(hr);
      }
      session.tick();
    }
    return session.tick();
  };
  return { session, ride, advance: (ms: number) => (now += ms) };
}

describe('RideSession', () => {
  it('does not move before start', () => {
    const { session, ride } = setup();
    const snap = ride(5, 200);
    expect(snap.state).toBe('idle');
    expect(snap.distanceM).toBe(0);
    expect(snap.elapsedS).toBe(0);
    expect(snap.powerW).toBe(200); // live power is still shown
    expect(session.toRecordedRide().samples).toHaveLength(0);
  });

  it('accelerates to the steady-state speed and records 1 Hz samples', () => {
    const { session, ride } = setup();
    session.setGear(12, 24);
    session.start();
    const snap = ride(240, 200);
    expect(snap.elapsedS).toBeCloseTo(240, 6);
    expect(snap.speedMps).toBeCloseTo(steadyStateSpeed(200, 0, DEFAULT_BIKE), 1);
    expect(snap.power3sW).toBeCloseTo(200, 6);
    expect(snap.wattsPerKg).toBeCloseTo(200 / 75, 6);
    expect(snap.gear).toBe(12);

    const { samples } = session.toRecordedRide();
    expect(samples).toHaveLength(240);
    expect(samples[0]!.elapsedS).toBe(1);
    expect(samples[239]!.elapsedS).toBe(240);
    expect(samples[10]!.timestamp - samples[9]!.timestamp).toBe(1000);
    expect(samples[239]!.distanceM).toBeCloseTo(snap.distanceM, 6);
    expect(samples[100]).toMatchObject({
      powerW: 200,
      cadenceRpm: 90,
      heartRateBpm: 140,
      gear: 12,
    });
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.distanceM).toBeGreaterThanOrEqual(samples[i - 1]!.distanceM);
    }
  });

  it('3 s power averages over the window; sample power is the mean of its second', () => {
    const { session, ride } = setup();
    session.start();
    ride(10, 100);
    const snap = ride(1.5, 400);
    expect(snap.powerW).toBe(400);
    expect(snap.power3sW).toBeCloseTo(250, 0);
    const samples = session.toRecordedRide().samples;
    expect(samples[9]!.powerW).toBe(100);
    expect(samples[10]!.powerW).toBe(400);
  });

  it('slows down on a climb', () => {
    const { session, ride } = setup();
    session.start();
    const flat = ride(120, 200).speedMps;
    session.setGradient(6);
    const climb = ride(120, 200);
    expect(climb.gradePercent).toBe(6);
    expect(climb.speedMps).toBeLessThan(flat / 2);
  });

  it('pause freezes time and distance; resume continues', () => {
    const { session, ride } = setup();
    session.start();
    ride(10, 200);
    session.pause();
    const paused = ride(30, 200);
    expect(paused.state).toBe('paused');
    expect(paused.elapsedS).toBeCloseTo(10, 6);
    expect(paused.speedMps).toBe(0);
    session.resume();
    const resumed = ride(5, 200);
    expect(resumed.elapsedS).toBeCloseTo(15, 6);
    expect(resumed.distanceM).toBeGreaterThan(paused.distanceM);
    expect(session.toRecordedRide().samples).toHaveLength(15);
  });

  it('treats a silent trainer as zero power and a silent strap as no heart rate', () => {
    const { session, ride } = setup();
    session.start();
    ride(60, 250);
    const dropped = ride(20, null);
    expect(dropped.powerW).toBe(0);
    expect(dropped.cadenceRpm).toBe(0);
    expect(dropped.heartRateBpm).toBeNull();
    const samples = session.toRecordedRide().samples;
    expect(samples.at(-1)).toMatchObject({ powerW: 0, heartRateBpm: null });
    expect(samples.at(-1)!.speedMps).toBeLessThan(samples[59]!.speedMps);
  });

  it('does not count a long tick gap (sleep) as riding', () => {
    const { session, ride, advance } = setup();
    session.start();
    const before = ride(10, 200);
    advance(3_600_000);
    const after = ride(1, 200);
    // The tick spanning the gap is discarded, the three after it count.
    expect(after.elapsedS).toBeCloseTo(before.elapsedS + 0.75, 6);
    expect(after.distanceM - before.distanceM).toBeLessThan(20);
  });

  it('finish returns the ride and stops advancing', () => {
    const { session, ride } = setup();
    session.start();
    ride(3, 150, null);
    const recorded = session.finish();
    expect(recorded.samples).toHaveLength(3);
    expect(recorded.samples[0]!.heartRateBpm).toBeNull();
    expect(recorded.riderMassKg).toBe(75);
    expect(recorded.startedAt).toBe(Date.UTC(2026, 0, 1, 12, 0, 0));
    ride(5, 150);
    expect(session.toRecordedRide().samples).toHaveLength(3);
  });

  it('ignores non-finite sensor values', () => {
    const { session, ride } = setup();
    session.start();
    ride(2, 200);
    session.setPower(Number.NaN);
    session.setHeartRate(Number.POSITIVE_INFINITY);
    const snap = session.tick();
    expect(snap.powerW).toBe(200);
    expect(snap.heartRateBpm).toBeNull();
  });

  it('the brake slows the virtual bike while it is refreshed and lapses when it goes stale', () => {
    const { session, ride } = setup();
    session.start();
    const cruising = ride(120, 200).speedMps;
    expect(cruising).toBeGreaterThan(8);

    // Held brake (refreshed every tick, like the controller does): stops within a few seconds.
    let braked = cruising;
    for (let i = 0; i < 4 * 3; i++) {
      session.setBrake(1);
      braked = ride(0.25, 200).speedMps;
      expect(braked).toBeGreaterThanOrEqual(0);
    }
    expect(braked).toBeLessThan(1);

    // Set once and never again: it stops acting after 3 s and the rider speeds up again.
    session.setBrake(1);
    ride(4, 200);
    const later = ride(20, 200).speedMps;
    expect(later).toBeGreaterThan(5);
  });

  it('a zero brake changes nothing', () => {
    const a = setup();
    const b = setup();
    a.session.start();
    b.session.start();
    for (let i = 0; i < 60; i++) {
      b.session.setBrake(0);
      expect(b.ride(1, 220)).toEqual(a.ride(1, 220));
    }
    b.session.setBrake(Number.NaN); // ignored like other non-finite inputs
    expect(b.ride(1, 220)).toEqual(a.ride(1, 220));
  });

  it('records positions from a position source at the distance of each sample', () => {
    const { session, ride } = setup();
    const asked: number[] = [];
    session.setPositionSource((d) => {
      asked.push(d);
      return { lat: 47 + d / 1e5, lon: 11, altitudeM: 500 + d / 100 };
    });
    session.start();
    ride(10, 200);
    const samples = session.toRecordedRide().samples;
    expect(samples).toHaveLength(10);
    for (const s of samples) {
      expect(s.lat).toBeCloseTo(47 + s.distanceM / 1e5, 9);
      expect(s.altitudeM).toBeCloseTo(500 + s.distanceM / 100, 9);
    }
    expect(asked).toHaveLength(10);
    session.setPositionSource(() => null);
    ride(2, 200);
    expect(session.toRecordedRide().samples.at(-1)).not.toHaveProperty('lat');
  });

  it('carries the route segment (jumps) from the position source; 0 is left out', () => {
    const { session, ride } = setup();
    let segment = 0;
    session.setPositionSource(() => ({ lat: 47, lon: 11, altitudeM: 500, segment }));
    session.start();
    ride(3, 200);
    segment = 1;
    ride(2, 200);
    segment = 2.5; // not an integer: ignored
    ride(1, 200);
    const samples = session.toRecordedRide().samples;
    expect(samples.map((s) => s.segment)).toEqual([
      undefined,
      undefined,
      undefined,
      1,
      1,
      undefined,
    ]);
    // Ridden distance is unaffected by the segments.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.distanceM).toBeGreaterThan(samples[i - 1]!.distanceM);
    }
  });

  it('samples have no position fields without a source', () => {
    const { session, ride } = setup();
    session.start();
    ride(3, 200);
    expect(Object.keys(session.toRecordedRide().samples[0]!)).not.toContain('lat');
  });
});

describe('RideSession energy', () => {
  it('accumulates live what rideEnergy computes from the recorded ride, and stores the FTP', () => {
    let now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const session = new RideSession({
      bike: DEFAULT_BIKE,
      riderMassKg: 75,
      now: () => now,
      energy: { ftpW: 250, ageYears: 40, sex: 'male' },
    });
    expect(session.energy().kcal).toBeNull();
    session.start();
    for (let i = 0; i < 600 * 4; i++) {
      now += 250;
      session.setPower(i < 1200 ? 150 : 260);
      session.setCadence(90);
      session.setHeartRate(130);
      session.tick();
    }
    const ride = session.toRecordedRide();
    expect(ride.ftpW).toBe(250);
    const live = session.energy();
    expect(live).toEqual(rideEnergy(ride, { ageYears: 40, sex: 'male' }));
    // 300 s × 150 W + 300 s × 260 W = 123 kJ
    expect(live.kcalPower).toBeCloseTo(123 / 1.00416, 6);
    expect(live.kcalHr).toBeCloseTo(
      (10 * (-55.0969 + 0.6309 * 130 + 0.1988 * 75 + 0.2017 * 40)) / 4.184,
      6,
    );
    expect(live.fatG).toBeGreaterThan(0);
  });

  it('without an FTP the ride stores none and has no split', () => {
    const { session, ride } = setup();
    session.start();
    ride(60, 200);
    expect(session.toRecordedRide().ftpW).toBeUndefined();
    expect(session.energy().fatG).toBeNull();
    expect(session.energy().kcal).toBeCloseTo(12 / 1.00416, 6);
  });
});
