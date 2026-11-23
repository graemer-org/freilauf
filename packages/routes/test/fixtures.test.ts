/**
 * Every GPX file in `fixtures/` (and, if present, the git-ignored `fixtures/local/`) must
 * parse, prepare into rideable gradients and survive the codec and group sharing. Lives
 * outside `src/` because it reads files; the package's own code stays free of Node APIs.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_SHARE_STEP_M,
  ROUTE_SHARE_BUDGET_BYTES,
  decodeRoute,
  encodeRoute,
  gradeAt,
  parseGpx,
  positionAt,
  prepareRoute,
  simplifyForSharing,
} from '../src/index';

const root = path.resolve(import.meta.dirname, '..', 'fixtures');
const files = [root, path.join(root, 'local')]
  .filter((dir) => existsSync(dir))
  .flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.gpx'))
      .map((f) => path.join(dir, f)),
  );

describe.runIf(files.length > 0)('GPX fixtures', () => {
  it.each(files.map((f) => [path.relative(root, f), f]))('%s', (_name, file) => {
    const parsed = parseGpx(readFileSync(file, 'utf8'));
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const prepared = prepareRoute(parsed.track);
    if (!prepared.ok) throw new Error(prepared.errors.join('; '));
    const t = prepared.track;

    expect(t.count).toBeGreaterThan(1);
    expect(t.totalDistanceM).toBeGreaterThan(100);
    // Plausible road gradients everywhere (smoothing must have removed noise spikes).
    for (let d = 0; d <= t.totalDistanceM; d += t.stepM) {
      const g = gradeAt(t, d);
      expect(Number.isFinite(g)).toBe(true);
      expect(Math.abs(g)).toBeLessThanOrEqual(25.01);
    }
    if (parsed.track.hasElevation)
      expect(t.ascentM).toBeLessThanOrEqual(prepared.stats.rawAscentM + 1);
    expect(positionAt(t, t.totalDistanceM / 2).remainingM).toBeGreaterThan(0);

    const decoded = decodeRoute(encodeRoute(t));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.track.totalDistanceM).toBeCloseTo(t.totalDistanceM, 3);
      expect(Math.abs(decoded.track.ascentM - t.ascentM)).toBeLessThan(0.02 * t.ascentM + 2);
    }

    const shared = simplifyForSharing(t);
    if (shared.ok) {
      expect(shared.bytes).toBeLessThanOrEqual(ROUTE_SHARE_BUDGET_BYTES);
      expect(shared.stepM).toBeLessThanOrEqual(MAX_SHARE_STEP_M);
      expect(decodeRoute(shared.text).ok).toBe(true);
    } else {
      expect(t.totalDistanceM).toBeGreaterThan(150_000); // only very long routes may not fit
    }
  });
});

describe('the committed real-world fixture', () => {
  const file = path.join(root, 'isar-ursprung.gpx');
  it.runIf(existsSync(file))(
    'is an out-and-back read as a loop, with valley-road gradients',
    () => {
      const parsed = parseGpx(readFileSync(file, 'utf8'));
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      expect(parsed.warnings).toEqual([]); // waypoints and <type> are ignored silently
      expect(parsed.track.points).toHaveLength(2410);
      const prepared = prepareRoute(parsed.track);
      if (!prepared.ok) throw new Error(prepared.errors.join('; '));
      const t = prepared.track;
      expect(t.loop).toBe(true);
      expect(prepared.stats.spikesDropped).toBe(0); // the sparse turnaround is kept
      expect(t.totalDistanceM / 1000).toBeCloseTo(97.6, 0);
      expect(t.stepM).toBeCloseTo(10, 1);
      const grades: number[] = [];
      for (let d = 0; d <= t.totalDistanceM; d += 10) grades.push(Math.abs(gradeAt(t, d)));
      grades.sort((a, b) => a - b);
      expect(grades.at(-1)).toBeLessThan(10);
      expect(grades[Math.floor(grades.length * 0.95)]).toBeLessThan(6);
      const shared = simplifyForSharing(t);
      expect(shared.ok && shared.stepM).toBeCloseTo(20, 0);
    },
  );
});
