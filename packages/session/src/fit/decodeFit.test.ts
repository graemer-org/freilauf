import { describe, expect, it } from 'vitest';
import type { RecordedRide, RideSample } from '../types';
import { fitCrc } from './crc';
import { decodeFitTrack } from './decodeFit';
import { FIT_EPOCH_OFFSET_S, encodeFit } from './encodeFit';

const START = Date.UTC(2026, 10, 22, 17, 0, 0);

function ride(n: number, pauseAfter?: number, pauseS = 0): RecordedRide {
  const samples: RideSample[] = [];
  for (let i = 1; i <= n; i++) {
    const wall = i + (pauseAfter !== undefined && i > pauseAfter ? pauseS : 0);
    samples.push({
      timestamp: START + wall * 1000,
      elapsedS: i,
      powerW: 200,
      cadenceRpm: 90,
      heartRateBpm: 130,
      speedMps: 8,
      distanceM: i * 8,
      gradePercent: 0,
      gear: 5,
      lat: 47 + i * 1e-5,
      lon: 11 + i * 2e-5,
      altitudeM: 500 + i * 0.1,
    });
  }
  return { id: 'ride-1', name: 'Test', startedAt: START, riderMassKg: 75, samples };
}

describe('decodeFitTrack', () => {
  it('reads our own .fit back: positions, distance, altitude and moving time', () => {
    const r = ride(120);
    const out = decodeFitTrack(encodeFit(r));
    if (!out.ok) throw new Error(out.reason);
    expect(out.points).toHaveLength(120);
    expect(out.withPosition).toBe(120);
    const p = out.points[59]!;
    const s = r.samples[59]!;
    expect(p.lat).toBeCloseTo(s.lat!, 6);
    expect(p.lon).toBeCloseTo(s.lon!, 6);
    expect(p.distanceM).toBeCloseTo(s.distanceM, 1);
    expect(p.altitudeM).toBeCloseTo(s.altitudeM!, 0);
    expect(p.timeS).toBe(59); // from the first record
  });

  it('a pause (timer stopped) does not count as moving time', () => {
    const out = decodeFitTrack(encodeFit(ride(100, 50, 300)));
    if (!out.ok) throw new Error(out.reason);
    // 99 s were ridden; the file's timer stops at the last record before the pause and starts
    // at the first one after it, so the second in between is not timed.
    expect(out.points.at(-1)!.timeS).toBe(98);
  });

  it('refuses what is not a FIT file, a damaged one, or one without records', () => {
    expect(decodeFitTrack(Uint8Array.from('<gpx></gpx>', (c) => c.charCodeAt(0)))).toMatchObject({
      ok: false,
    });
    const bytes = encodeFit(ride(30));
    expect(decodeFitTrack(bytes.slice(0, 200))).toMatchObject({ ok: false });
    const empty = new Uint8Array(14);
    empty.set([14, 0x20, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54], 0);
    expect(decodeFitTrack(empty)).toEqual({
      ok: false,
      reason: 'The file holds no recorded ride.',
    });
  });

  it('handles big-endian definitions and compressed timestamp headers (other apps)', () => {
    // Hand-built: one big-endian record definition (timestamp, lat, lon), a full record, then
    // two records with compressed timestamp headers (+1 s, +2 s).
    const out: number[] = [];
    const u8 = (v: number) => out.push(v & 0xff);
    const u16be = (v: number) => out.push((v >> 8) & 0xff, v & 0xff);
    const u32be = (v: number) =>
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    const ts0 = Math.floor(START / 1000) - FIT_EPOCH_OFFSET_S;
    const semi = (deg: number) => Math.round((deg * 2 ** 31) / 180) >>> 0;
    // Definition, local 0: record (20), big endian, 3 fields.
    u8(0x40);
    u8(0);
    u8(1);
    u16be(20);
    u8(3);
    out.push(253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85);
    u8(0x00);
    u32be(ts0);
    u32be(semi(47.1));
    u32be(semi(11.2));
    // A second definition, local 1, without the timestamp (used with compressed headers).
    u8(0x41);
    u8(0);
    u8(1);
    u16be(20);
    u8(2);
    out.push(0, 4, 0x85, 1, 4, 0x85);
    for (let k = 1; k <= 2; k++) {
      u8(0x80 | (1 << 5) | ((ts0 + k) & 0x1f));
      u32be(semi(47.1 + k * 1e-4));
      u32be(semi(11.2));
    }
    const data = Uint8Array.from(out);
    const file = new Uint8Array(14 + data.length + 2);
    file.set([14, 0x20, 0x52, 0x52], 0);
    new DataView(file.buffer).setUint32(4, data.length, true);
    file.set([0x2e, 0x46, 0x49, 0x54], 8);
    const hcrc = fitCrc(file, 0, 12);
    file[12] = hcrc & 0xff;
    file[13] = hcrc >> 8;
    file.set(data, 14);
    const result = decodeFitTrack(file);
    if (!result.ok) throw new Error(result.reason);
    expect(result.points.map((p) => p.timeS)).toEqual([0, 1, 2]);
    expect(result.points[2]!.lat).toBeCloseTo(47.1002, 6);
    expect(result.points[0]!.lon).toBeCloseTo(11.2, 6);
  });
});
