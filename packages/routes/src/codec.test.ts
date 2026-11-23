import { describe, expect, it } from 'vitest';
import { buildRoute } from './build';
import { builtinRoutes } from './builtin';
import {
  MAX_ENCODED_ROUTE_BYTES,
  MAX_SHARE_STEP_M,
  ROUTE_SHARE_BUDGET_BYTES,
  decodeRoute,
  encodeRoute,
  simplifyForSharing,
} from './codec';
import { haversineM, unproject, utf8ByteLength } from './geo';
import type { RouteTrack } from './types';
import { gradeAt } from './query';

const O = { lat0: 47.2, lon0: 11.3 };

/** A winding, rolling synthetic route of the given length. */
function winding(lengthM: number, name = 'Winding'): RouteTrack {
  const points = [];
  let x = 0;
  let y = 0;
  let h = 0;
  for (let s = 0; s <= lengthM; s += 10) {
    h += 0.02 * Math.sin(s / 400) + 0.01 * Math.sin(s / 97);
    x += 10 * Math.sin(h);
    y += 10 * Math.cos(h);
    const ele = 600 + 80 * Math.sin(s / 3000) + 20 * Math.sin(s / 700);
    points.push({ ...unproject(O, x, y), ele });
  }
  return buildRoute({ name, hasElevation: true, points });
}

function expectClose(a: RouteTrack, b: RouteTrack, posTol: number, eleTol: number): void {
  expect(b.count).toBe(a.count);
  expect(b.stepM).toBeCloseTo(a.stepM, 5);
  expect(b.loop).toBe(a.loop);
  for (let i = 0; i < a.count; i++) {
    expect(Math.abs(b.x[i]! - a.x[i]!)).toBeLessThanOrEqual(posTol);
    expect(Math.abs(b.y[i]! - a.y[i]!)).toBeLessThanOrEqual(posTol);
    expect(Math.abs(b.elevationM[i]! - a.elevationM[i]!)).toBeLessThanOrEqual(eleTol);
    expect(haversineM(a.lat[i]!, a.lon[i]!, b.lat[i]!, b.lon[i]!)).toBeLessThan(
      posTol * 1.5 + 0.01,
    );
  }
}

describe('encodeRoute / decodeRoute', () => {
  it('round-trips every built-in route within the quantisation', () => {
    for (const r of builtinRoutes()) {
      const text = encodeRoute(r);
      const d = decodeRoute(text);
      expect(d.ok).toBe(true);
      if (!d.ok) continue;
      expect(d.track.id).toBe(r.id);
      expect(d.track.name).toBe(r.name);
      expect(d.track.description).toBe(r.description);
      expectClose(r, d.track, 0.051, 0.051);
      expect(d.track.ascentM).toBeCloseTo(r.ascentM, -1);
      for (let i = 1; i < r.count - 1; i++) {
        expect(Math.abs(d.track.headingRad[i]! - r.headingRad[i]!)).toBeLessThan(0.02);
      }
      // Re-encoding the decoded route is stable.
      expect(encodeRoute(d.track)).toBe(text);
    }
  });

  it('is compact: a few bytes per sample', () => {
    const t = winding(30_000);
    const bytes = utf8ByteLength(encodeRoute(t));
    expect(bytes / t.count).toBeLessThan(6);
  });

  const good = JSON.parse(encodeRoute(builtinRoutes()[2]!)) as Record<string, unknown>;
  const variant = (patch: Record<string, unknown>) => JSON.stringify({ ...good, ...patch });
  const rejects: [string, string][] = [
    ['not JSON', '{'],
    ['an array', '[]'],
    ['another format', variant({ f: 'freilauf-workout' })],
    ['a future major version', variant({ v: 2 })],
    ['a bad id', variant({ id: '../etc' })],
    ['a non-string name', variant({ name: 5 })],
    ['a huge name', variant({ name: 'x'.repeat(1000) })],
    ['a zero step', variant({ step: 0 })],
    ['a NaN-ish step', variant({ step: '10' })],
    ['too many samples', variant({ n: 20_001 })],
    ['a sample count that does not match', variant({ n: (good.n as number) - 1 })],
    ['a non-boolean loop', variant({ loop: 1 })],
    ['an origin out of range', variant({ lat0: 95 })],
    ['a bad resolution', variant({ qp: 0 })],
    ['foreign characters', variant({ e: `${good.e as string}!` })],
    ['a dangling varint', variant({ e: `${good.e as string}g` })],
    ['an absurd elevation', variant({ e: `_____H${(good.e as string).slice(1)}` })],
    ['positions that jump', variant({ p: `_____H${(good.p as string).slice(1)}` })],
  ];
  it.each(rejects)('rejects %s', (_name, text) => {
    const d = decodeRoute(text);
    expect(d.ok).toBe(false);
  });

  it('rejects oversized input and never throws', () => {
    expect(decodeRoute(' '.repeat(MAX_ENCODED_ROUTE_BYTES + 1)).ok).toBe(false);
    expect(decodeRoute(undefined as unknown as string).ok).toBe(false);
    expect(decodeRoute('null').ok).toBe(false);
    expect(decodeRoute(variant({ minor: 'extra fields are fine', v: 1.3 })).ok).toBe(true);
  });
});

describe('simplifyForSharing', () => {
  it('shares short routes at full resolution', () => {
    const r = simplifyForSharing(builtinRoutes()[0]!);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stepM).toBeCloseTo(10, 0);
      expect(r.bytes).toBeLessThanOrEqual(ROUTE_SHARE_BUDGET_BYTES);
      expect(r.track.id).toBe(builtinRoutes()[0]!.id);
    }
  });

  it('reduces resolution until it fits, keeping distance, ascent and gradients', () => {
    for (const km of [30, 150]) {
      const t = winding(km * 1000);
      const r = simplifyForSharing(t);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.bytes).toBeLessThanOrEqual(ROUTE_SHARE_BUDGET_BYTES);
      expect(r.stepM).toBeLessThanOrEqual(MAX_SHARE_STEP_M);
      expect(km === 30 ? r.stepM : 0).toBeLessThanOrEqual(15);
      const d = decodeRoute(r.text);
      expect(d.ok).toBe(true);
      if (!d.ok) continue;
      expect(d.track.totalDistanceM).toBeCloseTo(t.totalDistanceM, 0);
      expect(Math.abs(d.track.ascentM - t.ascentM)).toBeLessThan(0.03 * t.ascentM + 5);
      for (let s = 500; s < t.totalDistanceM; s += 500) {
        expect(Math.abs(gradeAt(d.track, s) - gradeAt(t, s))).toBeLessThan(0.5);
      }
      if (km === 150) expect(d.track.id).not.toBe(t.id);
      // docs/routes.md quotes these: 30 km → 10 m (≈ 9 KB), 150 km → 30 m (≈ 15 KB).
      expect(r.stepM).toBeCloseTo(km === 30 ? 10 : 30, 0);
    }
  });

  it('refuses, with a reason, a route that only fits as mush', () => {
    const r = simplifyForSharing(winding(150_000), 3000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long to share.*50 m/);
  });
});
