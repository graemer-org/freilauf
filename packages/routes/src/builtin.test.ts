import { describe, expect, it } from 'vitest';
import { builtinRoutes, getBuiltinRoute } from './builtin';
import { curvatureAt, gradeAt } from './query';

const stats = (id: string) => {
  const t = getBuiltinRoute(id)!;
  const grades: number[] = [];
  let maxCurve = 0;
  for (let d = 0; d <= t.totalDistanceM; d += 10) {
    grades.push(gradeAt(t, d));
    maxCurve = Math.max(maxCurve, Math.abs(curvatureAt(t, d)));
  }
  return { t, min: Math.min(...grades), max: Math.max(...grades), maxCurve };
};

describe('built-in routes', () => {
  it('are four distinct, deterministic routes with plain names', () => {
    const routes = builtinRoutes();
    expect(routes.map((r) => r.id)).toEqual([
      'builtin-rolling-loop',
      'builtin-steady-climb',
      'builtin-punchy-circuit',
      'builtin-flat-out-and-back',
    ]);
    expect(builtinRoutes()).toBe(routes);
    expect(getBuiltinRoute('nope')).toBeNull();
    for (const r of routes) expect(r.description?.length).toBeGreaterThan(10);
  });

  it('rolling loop: 12 km loop, gentle', () => {
    const { t, min, max } = stats('builtin-rolling-loop');
    expect(t.loop).toBe(true);
    expect(t.totalDistanceM).toBeCloseTo(12_000, -2);
    expect(max).toBeLessThan(6);
    expect(min).toBeGreaterThan(-6);
    expect(t.ascentM).toBeGreaterThan(80);
  });

  it('steady climb: 8 km point-to-point at about 6 %', () => {
    const { t, min, max } = stats('builtin-steady-climb');
    expect(t.loop).toBe(false);
    expect(t.totalDistanceM).toBeCloseTo(8000, -2);
    expect(min).toBeGreaterThan(4.5);
    expect(max).toBeLessThan(7.5);
    expect(t.ascentM).toBeCloseTo(480, -1);
  });

  it('punchy circuit: a short loop with real corners and steep rises', () => {
    const { t, max, maxCurve } = stats('builtin-punchy-circuit');
    expect(t.loop).toBe(true);
    expect(t.totalDistanceM).toBeCloseTo(4000, -2);
    expect(max).toBeGreaterThan(7);
    expect(maxCurve).toBeGreaterThan(1 / 60); // corners tighter than 60 m radius
  });

  it('flat out-and-back: 20 km, ridden as laps', () => {
    const { t, min, max } = stats('builtin-flat-out-and-back');
    expect(t.loop).toBe(true);
    expect(Math.abs(t.totalDistanceM - 20_000)).toBeLessThan(200);
    expect(Math.max(max, -min)).toBeLessThan(0.5);
  });
});
