/**
 * Placing a recorded track on a route by GPS proximity (src/match.ts), with the real
 * out-and-back fixture (its return leg lies on its outbound leg) and synthetic tracks.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MatchPoint, RouteTrack } from '../src/index';
import {
  buildRoute,
  getBuiltinRoute,
  matchTrackToRoute,
  parseGpx,
  pointAt,
  prepareRoute,
  project,
  unproject,
} from '../src/index';

const file = path.resolve(import.meta.dirname, '..', 'fixtures', 'isar-ursprung.gpx');

function isar(): RouteTrack {
  const parsed = parseGpx(readFileSync(file, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  const prepared = prepareRoute(parsed.track);
  if (!prepared.ok) throw new Error(prepared.errors.join('; '));
  return prepared.track;
}

/** Deterministic noise in −1 … 1. */
function noise(i: number, seed: number): number {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * A ride along `track` from `fromM` to `toM` (route metres, may run past a loop's length) at
 * `speed`, one point per second, with up to `jitterM` of GPS noise; optionally a pause.
 */
function rideAlong(
  track: RouteTrack,
  fromM: number,
  toM: number,
  speed = 8,
  jitterM = 8,
  shift = { x: 0, y: 0 },
): MatchPoint[] {
  const origin = { lat0: track.lat[0]!, lon0: track.lon[0]! };
  const out: MatchPoint[] = [];
  const dir = toM >= fromM ? 1 : -1;
  for (let i = 0; ; i++) {
    const d = fromM + dir * i * speed;
    if (dir * (d - toM) > 0) break;
    const L = track.totalDistanceM;
    const p = pointAt(track, track.loop ? d - Math.floor(d / L) * L : d);
    const xy = project(origin, p.lat, p.lon);
    const q = unproject(
      origin,
      xy.x + shift.x + noise(i, 1) * jitterM,
      xy.y + shift.y + noise(i, 2) * jitterM,
    );
    out.push({ timeS: i, lat: q.lat, lon: q.lon });
  }
  return out;
}

describe('matchTrackToRoute: the Isar out-and-back fixture', () => {
  const track = isar();
  const L = track.totalDistanceM;

  it('is ridden as a loop whose return leg lies on the outbound leg', () => {
    expect(track.loop).toBe(true);
    expect(L).toBeGreaterThan(90_000);
  });

  it('a full noisy ride is placed along the whole route, outbound and back in order', () => {
    const pts = rideAlong(track, 0, L - 5, 9, 10);
    const m = matchTrackToRoute(track, pts);
    if (!m.ok) throw new Error(m.reason);
    // The start lies where the route starts and ends: lap 1 from 0, or from L (one lap on).
    const base = m.fromM > L / 2 ? L : 0;
    expect(m.fromM - base).toBeLessThan(40);
    expect(m.toM - base).toBeGreaterThan(L - 60);
    expect(m.share).toBeGreaterThan(0.98);
    expect(m.meanOffM).toBeLessThan(12);
    // On the return leg (which overlaps the outbound one) the distance keeps growing.
    for (const t of [L * 0.25, L * 0.5, L * 0.75]) {
      const at = m.points.find((p) => p.timeS >= Math.round(t / 9))!;
      expect(Math.abs(at.distanceM - base - t)).toBeLessThan(60);
    }
  });

  it('a ride on the return leg only is placed on the return leg', () => {
    const m = matchTrackToRoute(track, rideAlong(track, L * 0.6, L * 0.8));
    if (!m.ok) throw new Error(m.reason);
    expect(Math.abs(m.fromM - L * 0.6)).toBeLessThan(60);
    expect(Math.abs(m.toM - L * 0.8)).toBeLessThan(60);
  });

  it('riding the outbound leg backwards is riding the return leg: placed there', () => {
    const m = matchTrackToRoute(track, rideAlong(track, L * 0.2, L * 0.05));
    if (!m.ok) throw new Error(m.reason);
    // The legs are not exactly the same length: the return leg, and about as long.
    expect(m.fromM).toBeGreaterThan(L * 0.75);
    expect(m.toM).toBeLessThan(L);
    expect(Math.abs(m.toM - m.fromM - L * 0.15)).toBeLessThan(L * 0.01);
  });

  it('refuses a ride somewhere else, saying how far away it is', () => {
    const m = matchTrackToRoute(track, rideAlong(track, 0, 5000, 8, 5, { x: 40_000, y: 0 }));
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.reason).toMatch(/nowhere near this route \(\d+\.\d km away/);
  });

  it('refuses a track without positions', () => {
    expect(matchTrackToRoute(track, [])).toMatchObject({ ok: false, reason: /no GPS positions/ });
  });
});

describe('matchTrackToRoute: synthetic tracks', () => {
  /** 4 km due north. */
  const straight = buildRoute({
    name: 'Straight',
    hasElevation: true,
    points: Array.from({ length: 401 }, (_, i) => ({
      ...unproject({ lat0: 46.5, lon0: 8 }, 0, i * 10),
      ele: 500,
    })),
  });

  it('uses the longest part that follows the route when the ride leaves it', () => {
    const on1 = rideAlong(straight, 0, 1000);
    // 2 km off to the side, then back on from 2.5 km.
    const off = rideAlong(straight, 1000, 2400, 8, 5, { x: 300, y: 0 }).map((p) => ({
      ...p,
      timeS: p.timeS + 126,
    }));
    const on2 = rideAlong(straight, 2500, 4000).map((p) => ({ ...p, timeS: p.timeS + 302 }));
    const m = matchTrackToRoute(straight, [...on1, ...off, ...on2]);
    if (!m.ok) throw new Error(m.reason);
    expect(m.fromM).toBeGreaterThan(2450);
    expect(m.toM).toBeGreaterThan(3950);
    expect(m.points[0]!.timeS).toBe(302); // moving time of the file, not reset
  });

  it('refuses a ride that goes the other way', () => {
    const m = matchTrackToRoute(straight, rideAlong(straight, 3500, 500));
    expect(m).toEqual({ ok: false, reason: 'The ride goes the other way along this route.' });
  });

  it('refuses a ride that only touches the route', () => {
    const m = matchTrackToRoute(straight, rideAlong(straight, 0, 200));
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.reason).toMatch(/Only \d+ m of the ride follow this route/);
  });

  it('a built-in loop ridden twice counts on across the line', () => {
    const loop = getBuiltinRoute('builtin-punchy-circuit')!;
    const L = loop.totalDistanceM;
    const m = matchTrackToRoute(loop, rideAlong(loop, 0, 2 * L - 20));
    if (!m.ok) throw new Error(m.reason);
    expect(m.toM - m.fromM).toBeGreaterThan(2 * L - 80);
  });
});
