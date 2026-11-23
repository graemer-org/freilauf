import { buildRoute, decodeRoute, parseGpx } from '@freilauf/routes';
import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORTED_ROUTES,
  ROUTE_INDEX_KEY,
  ROUTE_KEY_PREFIX,
  RouteLibrary,
} from './routeLibrary';
import { memoryStorage } from './testing/communityFixtures';

/** A small GPX: `n` points north from (lat, 8), climbing 0.5 m each. */
function gpx(n: number, lat = 46, name: string | null = 'Home loop'): string {
  const pts = Array.from(
    { length: n },
    (_, i) =>
      `<trkpt lat="${(lat + i * 0.0002).toFixed(6)}" lon="8"><ele>${300 + i * 0.5}</ele></trkpt>`,
  ).join('');
  const meta = name === null ? '' : `<metadata><name>${name}</name></metadata>`;
  return `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${meta}<trk><trkseg>${pts}</trkseg></trk></gpx>`;
}

describe('RouteLibrary', () => {
  it('lists the built-in routes first, with thumbnails', () => {
    const lib = new RouteLibrary(null);
    const list = lib.list();
    expect(list.map((e) => e.source)).toEqual(['builtin', 'builtin', 'builtin', 'builtin']);
    for (const e of list) {
      expect(e.profile.length).toBeLessThanOrEqual(200);
      expect(e.profile.length).toBeGreaterThan(10);
      expect(e.outline.length).toBeLessThanOrEqual(200);
      expect(e.totalDistanceM).toBeGreaterThan(1000);
    }
  });

  it('imports a GPX, persists it and loads it again', () => {
    const storage = memoryStorage();
    const lib = new RouteLibrary(storage);
    const r = lib.importText(gpx(200));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry).toMatchObject({ name: 'Home loop', source: 'imported', loop: false });
    expect(r.entry.totalDistanceM).toBeGreaterThan(4000);
    expect(r.stats?.inputPoints).toBe(200);
    expect(JSON.parse(storage.map.get(ROUTE_INDEX_KEY)!)).toEqual([r.entry.id]);
    expect(decodeRoute(storage.map.get(ROUTE_KEY_PREFIX + r.entry.id)!).ok).toBe(true);

    const again = new RouteLibrary(storage);
    const loaded = again.list().at(-1)!;
    expect(loaded).toMatchObject({ id: r.entry.id, name: r.entry.name, source: 'imported' });
    expect(loaded.ascentM).toBeCloseTo(r.entry.ascentM, 0);
    const track = again.get(r.entry.id)!.track;
    expect(track.totalDistanceM).toBeCloseTo(lib.get(r.entry.id)!.track.totalDistanceM, 3);
  });

  it('names a nameless GPX after the file, reports parse errors and warnings', () => {
    const lib = new RouteLibrary(null);
    const named = lib.importText(gpx(50, 47, null), 'C:\\rides\\Lake Run.GPX');
    expect(named.ok && named.entry.name).toBe('Lake Run');
    const bad = lib.importText('<gpx version="1.1"><trk/></gpx>');
    expect(bad.ok).toBe(false);
    const flat = lib.importText(gpx(50, 48).replace(/<ele>[^<]*<\/ele>/g, ''));
    expect(flat.ok && flat.warnings).toContain(
      'This file has no elevation; the route will be flat.',
    );
  });

  it('imports its own format and does not shadow built-ins', () => {
    const lib = new RouteLibrary(null);
    const builtin = lib.list()[0]!;
    const r = lib.add(lib.get(builtin.id)!.track);
    expect(r.ok && r.entry.source).toBe('builtin');
    expect(lib.list()).toHaveLength(4);
  });

  it('deletes routes from storage', () => {
    const storage = memoryStorage();
    const lib = new RouteLibrary(storage);
    const r = lib.importText(gpx(100));
    if (!r.ok) throw new Error('import');
    expect(lib.remove(r.entry.id)).toBe(true);
    expect(lib.remove(r.entry.id)).toBe(false);
    expect(JSON.parse(storage.map.get(ROUTE_INDEX_KEY)!)).toEqual([]);
    expect(storage.map.get(ROUTE_KEY_PREFIX + r.entry.id) ?? '').toBe('');
    expect(new RouteLibrary(storage).list()).toHaveLength(4);
  });

  it('keeps a route in memory when storage is full, and says so', () => {
    const storage = memoryStorage();
    storage.full = true;
    const lib = new RouteLibrary(storage);
    const r = lib.importText(gpx(80));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join()).toMatch(/could not be saved permanently/);
    expect(lib.saveFailed).toBe(true);
    expect(lib.list()).toHaveLength(5);
  });

  it('refuses beyond the route count limit', () => {
    const lib = new RouteLibrary(null);
    for (let i = 0; i < MAX_IMPORTED_ROUTES; i++) {
      const raw = parseGpx(gpx(12, 10 + i * 0.01));
      if (!raw.ok) throw new Error('parse');
      expect(lib.add(buildRoute(raw.track)).ok).toBe(true);
    }
    const r = lib.importText(gpx(12, 60));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/full/);
  });

  it('ignores corrupt stored data', () => {
    const storage = memoryStorage();
    storage.map.set(ROUTE_INDEX_KEY, JSON.stringify(['route-x', 5, 'route-y']));
    storage.map.set(`${ROUTE_KEY_PREFIX}route-x`, '{"f":"freilauf-route"}');
    expect(new RouteLibrary(storage).list()).toHaveLength(4);
    storage.map.set(ROUTE_INDEX_KEY, '{nope');
    expect(new RouteLibrary(storage).list()).toHaveLength(4);
  });

  it('exports the prepared route as GPX', () => {
    const lib = new RouteLibrary(null);
    const r = lib.importText(gpx(100, 46, 'Up &amp; over'));
    if (!r.ok) throw new Error('import');
    const out = lib.export(r.entry.id)!;
    expect(out.fileName).toBe('Up  over.gpx');
    const back = parseGpx(out.text);
    expect(back.ok && back.track.name).toBe('Up & over');
    expect(lib.export('missing')).toBeNull();
  });
});
