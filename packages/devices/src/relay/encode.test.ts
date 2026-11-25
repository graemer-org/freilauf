import { describe, expect, it } from 'vitest';
import { CadenceFromCrankRevs, parseCyclingPowerMeasurement } from '../cyclingPower';
import { SpeedFromWheelRevs, parseCscMeasurement } from '../cyclingSpeedCadence';
import { parseIndoorBikeData } from '../ftms';
import { parseHeartRateMeasurement } from '../heartRate';
import { dataView } from '../testing/fakeGatt';
import {
  ScControlResult,
  encodeCscFeature,
  encodeCscMeasurement,
  encodeCyclingPowerFeature,
  encodeCyclingPowerMeasurement,
  encodeFitnessMachineFeature,
  encodeHeartRateMeasurement,
  encodeIndoorBikeData,
  encodeScControlPointResponse,
  fromRelayHex,
  parseScControlPointRequest,
  toRelayHex,
} from './encode';
import { RevolutionCounter } from './revolutions';

const view = (b: Uint8Array) => dataView(b);

describe('encodeHeartRateMeasurement', () => {
  it('round-trips uint8 and uint16 values through the parser', () => {
    for (const bpm of [0, 72, 255, 256, 300, 0xffff]) {
      expect(parseHeartRateMeasurement(view(encodeHeartRateMeasurement({ bpm })))).toEqual({
        bpm,
      });
    }
    expect(toRelayHex(encodeHeartRateMeasurement({ bpm: 72 }))).toBe('0048');
    expect(toRelayHex(encodeHeartRateMeasurement({ bpm: 300 }))).toBe('012c01');
  });

  it('encodes sensor contact', () => {
    expect(
      parseHeartRateMeasurement(view(encodeHeartRateMeasurement({ bpm: 80, sensorContact: true }))),
    ).toEqual({ bpm: 80, sensorContact: true });
    expect(
      parseHeartRateMeasurement(
        view(encodeHeartRateMeasurement({ bpm: 80, sensorContact: false })),
      ),
    ).toEqual({ bpm: 80, sensorContact: false });
  });

  it('clamps and rounds out-of-range values', () => {
    expect(parseHeartRateMeasurement(view(encodeHeartRateMeasurement({ bpm: 71.6 })))!.bpm).toBe(
      72,
    );
    expect(parseHeartRateMeasurement(view(encodeHeartRateMeasurement({ bpm: -3 })))!.bpm).toBe(0);
    expect(parseHeartRateMeasurement(view(encodeHeartRateMeasurement({ bpm: NaN })))!.bpm).toBe(0);
  });
});

describe('encodeCyclingPowerMeasurement', () => {
  it('round-trips power and crank data', () => {
    const bytes = encodeCyclingPowerMeasurement({
      powerW: 250,
      crank: { cumulativeRevs: 0xfffe, lastEventTime1024: 0xfc00 },
    });
    expect(toRelayHex(bytes)).toBe('2000fa00feff00fc');
    expect(parseCyclingPowerMeasurement(view(bytes))).toEqual({
      flags: 0x20,
      powerW: 250,
      crank: { cumulativeRevs: 0xfffe, lastEventTime1024: 0xfc00 },
    });
  });

  it('round-trips wheel data (1/2048 s) before crank data, and negative power', () => {
    const bytes = encodeCyclingPowerMeasurement({
      powerW: -5,
      wheel: { cumulativeRevs: 0xfffffffe, lastEventTime2048: 0x1234 },
      crank: { cumulativeRevs: 7, lastEventTime1024: 9 },
    });
    expect(parseCyclingPowerMeasurement(view(bytes))).toEqual({
      flags: 0x30,
      powerW: -5,
      wheel: { cumulativeRevs: 0xfffffffe, lastEventTime2048: 0x1234 },
      crank: { cumulativeRevs: 7, lastEventTime1024: 9 },
    });
  });

  it('power only, clamped to sint16', () => {
    expect(
      parseCyclingPowerMeasurement(view(encodeCyclingPowerMeasurement({ powerW: 1e6 }))),
    ).toEqual({ flags: 0, powerW: 32767 });
  });

  it('feature bits are a little-endian uint32', () => {
    expect(toRelayHex(encodeCyclingPowerFeature(0x08))).toBe('08000000');
  });
});

describe('encodeCscMeasurement', () => {
  it('round-trips wheel and crank data', () => {
    const m = {
      wheel: { cumulativeRevs: 0x12345678, lastEventTime1024: 0xabcd },
      crank: { cumulativeRevs: 0xffff, lastEventTime1024: 0x0102 },
    };
    const bytes = encodeCscMeasurement(m);
    expect(toRelayHex(bytes)).toBe('03785634 12cdab ffff0201'.replace(/ /g, ''));
    expect(parseCscMeasurement(view(bytes))).toEqual({ flags: 3, ...m });
  });

  it('wheel only, crank only', () => {
    expect(
      parseCscMeasurement(
        view(encodeCscMeasurement({ wheel: { cumulativeRevs: 1, lastEventTime1024: 2 } })),
      ),
    ).toEqual({ flags: 1, wheel: { cumulativeRevs: 1, lastEventTime1024: 2 } });
    expect(
      parseCscMeasurement(
        view(encodeCscMeasurement({ crank: { cumulativeRevs: 1, lastEventTime1024: 2 } })),
      ),
    ).toEqual({ flags: 2, crank: { cumulativeRevs: 1, lastEventTime1024: 2 } });
    expect(toRelayHex(encodeCscFeature(3))).toBe('0300');
  });
});

describe('SC control point', () => {
  it('parses Set Cumulative Value and builds responses', () => {
    expect(parseScControlPointRequest(fromRelayHex('0178563412'))).toEqual({
      op: 'setCumulativeValue',
      value: 0x12345678,
    });
    expect(parseScControlPointRequest(fromRelayHex('0101'))).toEqual({ op: 'invalid' });
    expect(parseScControlPointRequest(fromRelayHex('04'))).toEqual({ op: 'other', opCode: 4 });
    expect(toRelayHex(encodeScControlPointResponse(1, ScControlResult.Success))).toBe('100101');
  });
});

describe('encodeIndoorBikeData', () => {
  it('round-trips through the FTMS parser', () => {
    const bytes = encodeIndoorBikeData({
      speedKph: 32.47,
      cadenceRpm: 91.5,
      distanceM: 12345,
      powerW: 230,
      heartRateBpm: 141,
    });
    expect(parseIndoorBikeData(view(bytes))).toMatchObject({
      speedKph: 32.47,
      cadenceRpm: 91.5,
      distanceM: 12345,
      powerW: 230,
      heartRateBpm: 141,
    });
    const noHr = parseIndoorBikeData(
      view(encodeIndoorBikeData({ speedKph: 0, cadenceRpm: 0, distanceM: 0, powerW: 0 })),
    );
    expect(noHr?.heartRateBpm).toBeUndefined();
    expect(toRelayHex(encodeFitnessMachineFeature(0x4406))).toBe('0644000000000000');
  });
});

describe('hex helpers', () => {
  it('round-trip and reject junk', () => {
    expect(toRelayHex(fromRelayHex('00ff7a'))).toBe('00ff7a');
    expect(() => fromRelayHex('0')).toThrow();
    expect(() => fromRelayHex('zz')).toThrow();
  });
});

// ───────────── counters through the receivers' own derivation ─────────────

/** Feeds a counter at `hz` for `seconds` at a constant rate; returns the samples. */
function run(
  counter: RevolutionCounter,
  revsPerSecond: (tS: number) => number,
  seconds: number,
  hz = 4,
  startMs = 0,
) {
  const out: { tMs: number; cumulativeRevs: number; lastEventTime: number }[] = [];
  const stepMs = 1000 / hz;
  for (let tMs = startMs; tMs <= startMs + seconds * 1000; tMs += stepMs) {
    counter.advance(tMs, tMs === startMs ? 0 : revsPerSecond(tMs / 1000) * (stepMs / 1000));
    out.push({ tMs, cumulativeRevs: counter.cumulativeRevs, lastEventTime: counter.lastEventTime });
  }
  return out;
}

describe('RevolutionCounter → CadenceFromCrankRevs', () => {
  it('90 rpm in, 90 rpm out', () => {
    const c = new RevolutionCounter({ ticksPerSecond: 1024, countBits: 16 });
    const cadence = new CadenceFromCrankRevs();
    let rpm: number | undefined;
    for (const s of run(c, () => 1.5, 20)) {
      const bytes = encodeCyclingPowerMeasurement({
        powerW: 200,
        crank: { cumulativeRevs: s.cumulativeRevs, lastEventTime1024: s.lastEventTime },
      });
      rpm = cadence.update(parseCyclingPowerMeasurement(view(bytes))!.crank!, s.tMs);
    }
    expect(rpm).toBeCloseTo(90, 0);
    expect(c.cumulativeRevs).toBe(30);
  });

  it('survives uint16 count and event-time wraparound', () => {
    const c = new RevolutionCounter({
      ticksPerSecond: 1024,
      countBits: 16,
      initialCount: 0xfff0,
      initialTimeS: 63.5, // event time wraps at 64 s
    });
    const cadence = new CadenceFromCrankRevs();
    const rpms: number[] = [];
    let wrappedCount = false;
    let wrappedTime = false;
    let prev: { cumulativeRevs: number; lastEventTime: number } | null = null;
    for (const s of run(c, () => 100 / 60, 30)) {
      if (prev && s.cumulativeRevs < prev.cumulativeRevs) wrappedCount = true;
      if (prev && s.lastEventTime < prev.lastEventTime) wrappedTime = true;
      prev = s;
      const parsed = parseCscMeasurement(
        view(
          encodeCscMeasurement({
            crank: { cumulativeRevs: s.cumulativeRevs, lastEventTime1024: s.lastEventTime },
          }),
        ),
      )!;
      const r = cadence.update(parsed.crank!, s.tMs);
      if (s.tMs > 2000 && r !== undefined) rpms.push(r);
    }
    expect(wrappedCount).toBe(true);
    expect(wrappedTime).toBe(true);
    expect(rpms.length).toBeGreaterThan(50);
    for (const r of rpms) {
      expect(r).toBeGreaterThan(95);
      expect(r).toBeLessThan(105);
    }
  });

  it('zero cadence: no new crank event, time held, the receiver drops to 0', () => {
    const c = new RevolutionCounter({ ticksPerSecond: 1024, countBits: 16 });
    const cadence = new CadenceFromCrankRevs({ staleAfterMs: 3000 });
    const samples = run(c, (t) => (t < 10 ? 1.5 : 0), 20);
    const atStop = samples.find((s) => s.tMs === 10_000)!;
    const end = samples.at(-1)!;
    expect(end.cumulativeRevs).toBe(atStop.cumulativeRevs);
    expect(end.lastEventTime).toBe(atStop.lastEventTime);
    let rpm: number | undefined;
    for (const s of samples)
      rpm = cadence.update(
        { cumulativeRevs: s.cumulativeRevs, lastEventTime1024: s.lastEventTime },
        s.tMs,
      );
    expect(rpm).toBe(0);
  });

  it('a cadence below one turn per update still produces exact events', () => {
    const c = new RevolutionCounter({ ticksPerSecond: 1024, countBits: 16 });
    const samples = run(c, () => 0.5, 10); // 30 rpm: one turn every 2 s
    const events = samples.filter(
      (s, i) => i > 0 && s.cumulativeRevs !== samples[i - 1]!.cumulativeRevs,
    );
    expect(events.map((s) => s.lastEventTime)).toEqual([2, 4, 6, 8, 10].map((t) => t * 1024));
  });
});

describe('RevolutionCounter → SpeedFromWheelRevs (CSC wheel, 1/1024 s)', () => {
  const circ = 2.105;

  it('a constant speed comes back as that speed; distance from the count', () => {
    const c = new RevolutionCounter({ ticksPerSecond: 1024, countBits: 32 });
    const speed = new SpeedFromWheelRevs({ circumferenceM: circ });
    const mps = 10; // 36 km/h
    let v: number | undefined;
    for (const s of run(c, () => mps / circ, 60)) {
      const parsed = parseCscMeasurement(
        view(
          encodeCscMeasurement({
            wheel: { cumulativeRevs: s.cumulativeRevs, lastEventTime1024: s.lastEventTime },
          }),
        ),
      )!;
      v = speed.update(parsed.wheel!, s.tMs);
    }
    expect(v).toBeCloseTo(mps, 1);
    expect(c.cumulativeRevs * circ).toBeGreaterThan(600 - circ);
    expect(c.cumulativeRevs * circ).toBeLessThanOrEqual(600);
  });

  it('survives uint32 count wraparound and event time wrap', () => {
    const c = new RevolutionCounter({
      ticksPerSecond: 1024,
      countBits: 32,
      initialCount: 0xffffffff - 20,
      initialTimeS: 60,
    });
    const speed = new SpeedFromWheelRevs({ circumferenceM: circ });
    const values: number[] = [];
    for (const s of run(c, () => 8 / circ, 20)) {
      const v = speed.update(
        { cumulativeRevs: s.cumulativeRevs, lastEventTime1024: s.lastEventTime },
        s.tMs,
      );
      if (s.tMs > 1000 && v !== undefined) values.push(v);
    }
    expect(c.cumulativeRevs).toBeLessThan(100);
    for (const v of values) expect(v).toBeCloseTo(8, 0);
  });

  it('stopped wheel: count and time held, the receiver reports 0', () => {
    const c = new RevolutionCounter({ ticksPerSecond: 1024, countBits: 32 });
    const speed = new SpeedFromWheelRevs({ circumferenceM: circ, staleAfterMs: 3000 });
    let v: number | undefined;
    for (const s of run(c, (t) => (t < 5 ? 5 / circ : 0), 15))
      v = speed.update(
        { cumulativeRevs: s.cumulativeRevs, lastEventTime1024: s.lastEventTime },
        s.tMs,
      );
    expect(v).toBe(0);
  });

  it('1/2048 s event time (CPS wheel data) at the same speed', () => {
    const c = new RevolutionCounter({ ticksPerSecond: 2048, countBits: 32 });
    const samples = run(c, () => 1, 3);
    const last = samples.at(-1)!;
    expect(last.cumulativeRevs).toBe(3);
    expect(last.lastEventTime).toBe(3 * 2048);
    const parsed = parseCyclingPowerMeasurement(
      view(
        encodeCyclingPowerMeasurement({
          powerW: 0,
          wheel: { cumulativeRevs: last.cumulativeRevs, lastEventTime2048: last.lastEventTime },
        }),
      ),
    );
    expect(parsed?.wheel).toEqual({ cumulativeRevs: 3, lastEventTime2048: 6144 });
  });
});
