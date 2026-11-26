/**
 * A synthetic Overpass answer along fixtures/isar-ursprung.gpx: made up here, not taken from
 * OpenStreetMap. Features are placed in the route's own frame (distance along, metres to the
 * right) and written out as `out geom` JSON, so the scenery pipeline gets realistic input:
 *
 * - the village "Kleinmoos" from km 0.2 to 1.6 (houses on both sides, a church, farms, a few
 *   apartment blocks, sheds) with its place node, residential land use under it;
 * - meadow on the right from km 1.6 to 4.5, farmland on the left from km 4.5 to 6.2;
 * - a forest on the left from km 2.0 to 4.5 (a multipolygon with a clearing);
 * - the river on the right all along the first 6.5 km (a centre line ~45 m out, a riverbank
 *   area from km 4.5), a bridge on the route at km 5.0 and the hamlet "Auhof" near km 5.6;
 * - a few things that must be dropped: a house 400 m out, a forest 1 km away, a building
 *   footprint far too large, an unclosed "area".
 *
 * `fixtures/osm/isar-ursprung.overpass.json` is this function's output (scenery.test.ts
 * checks it; UPDATE_OSM_FIXTURE=1 rewrites it).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RouteTrack } from '../src/index';
import { parseGpx, prepareRoute, routeXY, unproject } from '../src/index';

export const FIXTURE_DIR = path.resolve(import.meta.dirname, '..', 'fixtures');
export const ISAR_GPX = path.join(FIXTURE_DIR, 'isar-ursprung.gpx');
export const ISAR_OVERPASS = path.join(FIXTURE_DIR, 'osm', 'isar-ursprung.overpass.json');

export function isarTrack(): RouteTrack {
  const parsed = parseGpx(readFileSync(ISAR_GPX, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  const prepared = prepareRoute(parsed.track);
  if (!prepared.ok) throw new Error(prepared.errors.join('; '));
  return prepared.track;
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Frame {
  /** lat/lon of the point `offsetM` right of the route at `alongM`. */
  at(alongM: number, offsetM: number): { lat: number; lon: number };
}

export function routeFrame(track: RouteTrack): Frame {
  const { proj, x, y } = routeXY(track);
  const n = track.count;
  return {
    at(alongM, offsetM) {
      const f = Math.max(0, Math.min(n - 1.000001, alongM / track.stepM));
      const i = Math.floor(f);
      const t = f - i;
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 2);
      let dx = x[b]! - x[a]!;
      let dy = y[b]! - y[a]!;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const px = x[i]! + (x[i + 1]! - x[i]!) * t + dy * offsetM;
      const py = y[i]! + (y[i + 1]! - y[i]!) * t - dx * offsetM;
      const ll = unproject(proj, px, py);
      return { lat: Math.round(ll.lat * 1e7) / 1e7, lon: Math.round(ll.lon * 1e7) / 1e7 };
    },
  };
}

type Element = Record<string, unknown>;

/** Builds the fixture's Overpass JSON object for a track. */
export function makeIsarOverpass(track: RouteTrack = isarTrack()): {
  version: number;
  generator: string;
  osm3s: Record<string, string>;
  elements: Element[];
} {
  const fr = routeFrame(track);
  const rand = rng(20261126);
  const elements: Element[] = [];
  let id = 1_000_000;
  const way = (tags: Record<string, string>, pts: { lat: number; lon: number }[]): void => {
    elements.push({ type: 'way', id: id++, tags, geometry: pts });
  };
  /** A rectangle in the route's frame, corners following the road. */
  const rect = (a0: number, a1: number, o0: number, o1: number, steps = 1) => {
    const pts: { lat: number; lon: number }[] = [];
    for (let k = 0; k <= steps; k++) pts.push(fr.at(a0 + ((a1 - a0) * k) / steps, o0));
    for (let k = steps; k >= 0; k--) pts.push(fr.at(a0 + ((a1 - a0) * k) / steps, o1));
    pts.push(pts[0]!);
    return pts;
  };
  const house = (
    along: number,
    offset: number,
    len: number,
    dep: number,
    tags: Record<string, string>,
  ) => way(tags, rect(along - len / 2, along + len / 2, offset - dep / 2, offset + dep / 2));

  // ── Kleinmoos, km 0.2 – 1.6 ──
  way({ landuse: 'residential', name: 'Kleinmoos' }, rect(150, 1650, -140, 140, 15));
  for (let along = 220; along < 1600; along += 14 + rand() * 18) {
    for (const side of [-1, 1]) {
      if (rand() < 0.25) continue;
      const rows = rand() < 0.45 ? 2 : 1;
      for (let row = 0; row < rows; row++) {
        const offset = side * (12 + row * 28 + rand() * 10);
        const r = rand();
        if (r < 0.06) {
          house(along, offset, 18 + rand() * 8, 12, { building: 'farm_auxiliary' });
        } else if (r < 0.1) {
          house(along, offset, 22, 14, { building: 'apartments', 'building:levels': '4' });
        } else if (r < 0.16) {
          house(along, offset, 6, 5, { building: 'garage' });
        } else {
          const levels = String(1 + Math.floor(rand() * 3));
          const tags: Record<string, string> =
            rand() < 0.5 ? { building: 'house', 'building:levels': levels } : { building: 'yes' };
          if (rand() < 0.1) tags.height = `${(7 + rand() * 5).toFixed(1)} m`;
          house(along, offset, 9 + rand() * 6, 8 + rand() * 4, tags);
        }
      }
    }
  }
  house(900, -38, 28, 14, { building: 'church', name: 'St. Nikolaus', height: '24' });
  elements.push({
    type: 'node',
    id: 9_000_001,
    lat: fr.at(900, 60).lat,
    lon: fr.at(900, 60).lon,
    tags: { place: 'village', name: 'Kleinmoos' },
  });

  // ── meadow right km 1.6 – 4.5, farmland left km 4.5 – 6.2 ──
  way({ landuse: 'meadow' }, rect(1600, 4500, 7, 36, 145));
  way({ landuse: 'farmland' }, rect(4500, 6200, -150, -8, 85));
  way({ landuse: 'grass' }, rect(1650, 1950, -60, -7, 4));

  // ── forest left km 2.0 – 4.5, a multipolygon with a clearing ──
  elements.push({
    type: 'relation',
    id: 7_000_001,
    tags: { type: 'multipolygon', landuse: 'forest' },
    members: [
      { type: 'way', ref: 1, role: 'outer', geometry: rect(2000, 4500, -260, -9, 125) },
      { type: 'way', ref: 2, role: 'inner', geometry: rect(3100, 3300, -80, -30, 3) },
    ],
  });
  // A few houses at the forest's edge.
  for (const a of [2100, 2600, 3900]) house(a, 24, 10, 9, { building: 'house' });

  // ── the river: centre line ~45 m right, a riverbank area from km 4.5 ──
  const river: { lat: number; lon: number }[] = [];
  for (let a = 0; a <= 6500; a += 50) river.push(fr.at(a, 45 + 8 * Math.sin(a / 700)));
  way({ waterway: 'river', name: 'Isar' }, river);
  way({ natural: 'water', water: 'river' }, rect(4500, 6500, 34, 62, 100));
  way({ waterway: 'stream' }, [
    fr.at(3000, -200),
    fr.at(3020, -60),
    fr.at(3040, 0),
    fr.at(3060, 40),
  ]);

  // ── a bridge on the route, the hamlet Auhof ──
  way({ highway: 'secondary', bridge: 'yes', layer: '1' }, [
    fr.at(5000, 0),
    fr.at(5030, 0),
    fr.at(5062, 0),
  ]);
  for (const [a, o] of [
    [5550, -30],
    [5580, -22],
    [5600, 26],
    [5640, -40],
  ] as const)
    house(a, o, 12, 10, { building: rand() < 0.5 ? 'farm' : 'barn' });
  elements.push({
    type: 'node',
    id: 9_000_002,
    lat: fr.at(5600, -120).lat,
    lon: fr.at(5600, -120).lon,
    tags: { place: 'hamlet', name: 'Auhof' },
  });

  // ── things that must be dropped ──
  house(1200, 400, 10, 10, { building: 'house' }); // beyond the corridor
  way({ natural: 'wood' }, rect(7000, 8000, 1000, 1300, 4)); // far away
  way({ building: 'industrial' }, rect(6000, 6400, 20, 420, 2)); // footprint far too large
  way({ landuse: 'forest' }, [fr.at(7000, 10), fr.at(7100, 10), fr.at(7100, 60)]); // not closed

  return {
    version: 0.6,
    generator: 'Freilauf synthetic test fixture (not OpenStreetMap data)',
    osm3s: {
      copyright:
        'Synthetic data made up for tests. Real Overpass answers carry: The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.',
    },
    elements,
  };
}
