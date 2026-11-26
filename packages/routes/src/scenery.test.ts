import { describe, expect, it } from 'vitest';
import { buildRoute } from './build';
import { unproject } from './geo';
import type { RawPoint } from './gpx';
import type { OsmElement } from './overpass';
import { overpassBody, overpassQuery, parseOverpassJson, sceneryChunks } from './overpass';
import {
  boundScenery,
  decodeScenery,
  emptyScenery,
  encodeScenery,
  forEachBuildingIn,
  forEachStretchIn,
  MAX_SCENERY_BYTES,
  OSM_ATTRIBUTION,
  SCENERY_CORRIDOR_M,
  type SceneryBuilding,
  type SceneryModel,
} from './scenery';
import { BUILDING_MIN_OFFSET_M, buildScenery, buildingShape, parseMetres } from './sceneryBuild';
import {
  CancelSource,
  type CancelSignal,
  fetchScenery,
  type OverpassResponse,
} from './sceneryFetch';
import { utf8ByteLength } from './geo';

const ORIGIN = { lat0: 47.5, lon0: 11.4 };
const at = (x: number, y: number): RawPoint => ({ ...unproject(ORIGIN, x, y), ele: 600 });
const ll = (x: number, y: number) => unproject(ORIGIN, x, y);

/** 2 km straight north. */
const straight = () =>
  buildRoute({
    name: 'Straight',
    points: Array.from({ length: 201 }, (_, i) => at(0, i * 10)),
    hasElevation: true,
  });

/** 500 m north, a 90° right bend (radius 100 m), 500 m east. */
function bend() {
  const pts: RawPoint[] = [];
  for (let y = 0; y <= 500; y += 10) pts.push(at(0, y));
  for (let a = 1; a <= 30; a++) {
    const th = (a / 30) * (Math.PI / 2);
    pts.push(at(100 - 100 * Math.cos(th), 500 + 100 * Math.sin(th)));
  }
  for (let x = 110; x <= 600; x += 10) pts.push(at(x, 600));
  return buildRoute({ name: 'Bend', points: pts, hasElevation: true });
}

/** A square loop of 4 × 1 km, clockwise (north, east, south, west). */
function squareLoop() {
  const pts: RawPoint[] = [];
  for (let y = 0; y < 1000; y += 10) pts.push(at(0, y));
  for (let x = 0; x < 1000; x += 10) pts.push(at(x, 1000));
  for (let y = 1000; y > 0; y -= 10) pts.push(at(1000, y));
  for (let x = 1000; x >= 0; x -= 10) pts.push(at(x, 0));
  return buildRoute({ name: 'Square', points: pts, hasElevation: true });
}

/** A closed building footprint (w × d m) centred at x/y, axis aligned. */
function building(id: number, x: number, y: number, w = 10, d = 8, tags = {}): OsmElement {
  const g = [
    ll(x - w / 2, y - d / 2),
    ll(x + w / 2, y - d / 2),
    ll(x + w / 2, y + d / 2),
    ll(x - w / 2, y + d / 2),
    ll(x - w / 2, y - d / 2),
  ];
  return { type: 'way', id, tags: { building: 'house', ...tags }, geometry: g };
}

function box(x0: number, y0: number, x1: number, y1: number) {
  return [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)];
}

describe('route-relative projection', () => {
  it('places buildings left and right, at their distance along the road', () => {
    const t = straight();
    const { model } = buildScenery(t, [
      building(1, 30, 500), // 30 m right (east) of km 0.5
      building(2, -50, 1200, 20, 12), // 50 m left
    ]);
    expect(model.buildings).toHaveLength(2);
    const [a, b] = model.buildings as [SceneryBuilding, SceneryBuilding];
    expect(a.alongM).toBeCloseTo(500, 0);
    expect(a.offsetM).toBeCloseTo(30, 0);
    expect(a.lengthM).toBeCloseTo(8, 0); // along the road (north–south)
    expect(a.depthM).toBeCloseTo(10, 0);
    expect(b.alongM).toBeCloseTo(1200, 0);
    expect(b.offsetM).toBeCloseTo(-50, 0);
    expect(b.lengthM).toBeCloseTo(12, 0);
    expect(b.depthM).toBeCloseTo(20, 0);
  });

  it('measures across the road after a bend, with the side seen from the road', () => {
    const t = bend();
    // After the bend the road runs east: a house north of it is on the left.
    const { model } = buildScenery(t, [building(1, 400, 640), building(2, 400, 570)]);
    const [north, south] = [...model.buildings].sort((x, y) => x.offsetM - y.offsetM);
    expect(north!.offsetM).toBeCloseTo(-40, 0);
    expect(south!.offsetM).toBeCloseTo(30, 0);
    const along = 500 + (Math.PI / 2) * 100 + 300;
    expect(north!.alongM).toBeCloseTo(along, -1);
    expect(north!.lengthM).toBeCloseTo(10, 0); // now east–west is along the road
    // Inside the bend (south-east of its centre … well inside the corner): one pass only.
    const inside = buildScenery(t, [building(3, 60, 540)]).model.buildings;
    expect(inside).toHaveLength(1);
    expect(inside[0]!.offsetM).toBeGreaterThan(0);
  });

  it('places a building near a loop crossing once per pass, never twice at the seam', () => {
    const t = squareLoop();
    expect(t.loop).toBe(true);
    // Near the start/finish corner, outside the square: seen when leaving and arriving.
    const { model } = buildScenery(t, [building(1, -30, 30), building(2, 500, 1040)]);
    const start = model.buildings.filter((b) => b.alongM < 200 || b.alongM > 3800);
    expect(start).toHaveLength(1); // one physical pass across the seam
    expect(start[0]!.offsetM).toBeLessThan(0); // west of a road going north: left
    const top = model.buildings.find((b) => Math.abs(b.alongM - 1500) < 20)!;
    expect(top.offsetM).toBeCloseTo(-40, 0); // north of the eastbound top edge: left
    for (const b of model.buildings) {
      expect(b.alongM).toBeGreaterThanOrEqual(0);
      expect(b.alongM).toBeLessThan(t.totalDistanceM);
    }
  });

  it('places a building on an out-and-back once each way, on opposite sides', () => {
    const pts: RawPoint[] = [];
    for (let y = 0; y <= 1000; y += 10) pts.push(at(0, y));
    for (let y = 990; y >= 0; y -= 10) pts.push(at(3, y));
    const t = buildRoute({ name: 'Out and back', points: pts, hasElevation: true });
    const { model } = buildScenery(t, [building(1, 25, 300)]);
    expect(model.buildings).toHaveLength(2);
    const [out, back] = model.buildings as [SceneryBuilding, SceneryBuilding];
    expect(out.alongM).toBeCloseTo(300, -1);
    expect(out.offsetM).toBeGreaterThan(15);
    expect(back.alongM).toBeCloseTo(t.totalDistanceM - 300, -1);
    expect(back.offsetM).toBeLessThan(-15);
  });

  it('drops what lies beyond the corridor and keeps the road clear', () => {
    const t = straight();
    const { model } = buildScenery(t, [
      building(1, SCENERY_CORRIDOR_M + 40, 500),
      building(2, -(SCENERY_CORRIDOR_M - 10), 700),
      building(3, 2, 900), // mapped on the road edge
      building(4, 0, 3000), // beyond the end
      { type: 'way', id: 5, tags: { building: 'yes' }, geometry: box(20, 1000, 420, 1300) }, // huge
    ]);
    expect(model.buildings.map((b) => Math.round(b.alongM))).toEqual([700, 900]);
    const onEdge = model.buildings[1]!;
    expect(Math.abs(onEdge.offsetM) - onEdge.depthM / 2).toBeCloseTo(BUILDING_MIN_OFFSET_M, 5);
  });

  it('turns land cover polygons into stretches per side, holes included', () => {
    const t = straight();
    const forest: OsmElement = {
      type: 'relation',
      id: 10,
      tags: { type: 'multipolygon', landuse: 'forest' },
      members: [
        { type: 'way', role: 'outer', geometry: box(-400, 200, -10, 1000) },
        { type: 'way', role: 'inner', geometry: box(-60, 500, -10.5, 600) },
      ],
    };
    const meadow: OsmElement = {
      type: 'way',
      id: 11,
      tags: { landuse: 'meadow' },
      geometry: box(8, 0, 60, 2000),
    };
    const lake: OsmElement = {
      type: 'way',
      id: 12,
      tags: { natural: 'water' },
      geometry: box(70, 800, 400, 1400),
    };
    const { model } = buildScenery(t, [forest, meadow, lake]);
    const f = model.ground.filter((g) => g.kind === 'forest');
    expect(f.every((g) => g.side === -1)).toBe(true);
    // To the probe spacing (20 m).
    expect(Math.abs(Math.min(...f.map((g) => g.fromM)) - 200)).toBeLessThanOrEqual(20);
    expect(Math.abs(Math.max(...f.map((g) => g.toM)) - 1000)).toBeLessThanOrEqual(20);
    // Where the clearing is, the forest starts 60 m out.
    const atClearing = f.find((g) => g.fromM <= 550 && g.toM >= 550)!;
    expect(atClearing.nearM).toBeCloseTo(60, -1);
    expect(f.find((g) => g.fromM <= 300 && g.toM >= 300)!.farM).toBe(SCENERY_CORRIDOR_M);
    const m = model.ground.filter((g) => g.kind === 'meadow');
    expect(m.every((g) => g.side === 1 && g.nearM === 8 && g.farM === 60)).toBe(true);
    const w = model.water.filter((g) => g.kind === 'lake');
    expect(w.every((g) => g.side === 1 && g.nearM === 70)).toBe(true);
    expect(Math.abs(Math.min(...w.map((g) => g.fromM)) - 800)).toBeLessThanOrEqual(20);
  });

  it('draws a river line as a band, and skips a culvert under the road', () => {
    const t = straight();
    const river: OsmElement = {
      type: 'way',
      id: 20,
      tags: { waterway: 'river', width: '20' },
      geometry: [ll(-40, -100), ll(-40, 2100)],
    };
    const culvert: OsmElement = {
      type: 'way',
      id: 21,
      tags: { waterway: 'stream' },
      geometry: [ll(-300, 1500), ll(300, 1500)],
    };
    const { model } = buildScenery(t, [river, culvert]);
    expect(model.water.length).toBeGreaterThan(0);
    for (const w of model.water) {
      expect(w).toMatchObject({ kind: 'river', side: -1, nearM: 30, farM: 50 });
    }
  });

  it('puts a town sign where the houses begin, and finds a bridge on the route', () => {
    const t = straight();
    const houses = Array.from({ length: 12 }, (_, i) => building(100 + i, 20, 1000 + i * 40));
    const place: OsmElement = {
      type: 'node',
      id: 300,
      ...ll(300, 1200),
      tags: { place: 'village', name: 'Testdorf' },
    };
    const bridge: OsmElement = {
      type: 'way',
      id: 301,
      tags: { highway: 'tertiary', bridge: 'yes' },
      geometry: [ll(0, 1700), ll(0, 1730), ll(0, 1745)],
    };
    const crossing: OsmElement = {
      type: 'way',
      id: 302,
      tags: { highway: 'motorway', bridge: 'yes' },
      geometry: [ll(-200, 1850), ll(200, 1850)],
    };
    const { model } = buildScenery(t, [...houses, place, bridge, crossing]);
    expect(model.places).toEqual([{ name: 'Testdorf', kind: 'village', alongM: 970 }]);
    expect(model.structures).toEqual([{ kind: 'bridge', fromM: 1700, toM: 1745 }]);
  });

  it('reads heights from levels, height tags and building types', () => {
    expect(buildingShape({ building: 'house', 'building:levels': '3' })).toEqual({
      kind: 'house',
      heightM: 9,
    });
    expect(buildingShape({ building: 'apartments', height: '20 m' }).heightM).toBe(20);
    expect(buildingShape({ building: 'garage' })).toEqual({ kind: 'shed', heightM: 3 });
    expect(buildingShape({ building: 'church' }).kind).toBe('church');
    expect(buildingShape({ building: 'warehouse' }).kind).toBe('industrial');
    expect(buildingShape({ building: 'yes' })).toEqual({ kind: 'house', heightM: 6 });
    expect(parseMetres('12,5 m')).toBe(12.5);
    expect(parseMetres('40 ft')).toBeNull();
  });
});

describe('Overpass queries and answers', () => {
  it('chunks a straight route into boxes covering the corridor', () => {
    const pts = Array.from({ length: 1001 }, (_, i) => at(0, i * 10)); // 10 km north
    const t = buildRoute({ name: 'Long', points: pts, hasElevation: true });
    const chunks = sceneryChunks(t, { maxLengthM: 4000 });
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.fromM).toBe(0);
    expect(chunks.at(-1)!.toM).toBeCloseTo(t.totalDistanceM, 0);
    for (const c of chunks) {
      // The corridor (150 m) plus margin either side of the road.
      const west = unproject(ORIGIN, -SCENERY_CORRIDOR_M, 0).lon;
      expect(c.bbox.west).toBeLessThan(west);
      expect(c.bbox.east).toBeGreaterThan(ORIGIN.lon0 + (ORIGIN.lon0 - west));
      expect(c.placeBbox.west).toBeLessThan(c.bbox.west);
    }
    // Consecutive chunks overlap or touch: nothing along the road is missed.
    for (let i = 1; i < chunks.length; i++)
      expect(chunks[i]!.bbox.south).toBeLessThanOrEqual(chunks[i - 1]!.bbox.north);
  });

  it('asks for an out-and-back route only once', () => {
    const pts: RawPoint[] = [];
    for (let y = 0; y <= 3000; y += 10) pts.push(at(0, y));
    for (let y = 2990; y >= 0; y -= 10) pts.push(at(4, y));
    const t = buildRoute({ name: 'Out and back', points: pts, hasElevation: true });
    const chunks = sceneryChunks(t);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.toM).toBeLessThan(3600); // the turn, then nothing of the way back
  });

  it('builds a query for buildings, land cover, water, places and structures', () => {
    const chunk = sceneryChunks(straight())[0]!;
    const q = overpassQuery(chunk, 60);
    expect(q.startsWith('[out:json][timeout:60];')).toBe(true);
    for (const part of [
      'way["building"]',
      'way["landuse"~"^(forest|meadow|farmland|grass|residential',
      'relation["type"="multipolygon"]["natural"~',
      'way["waterway"~"^(riverbank|river|stream|canal)$"]',
      'way["highway"]["bridge"',
      'node["place"~"^(city|town|village|hamlet)$"]["name"]',
      'out geom qt;',
    ])
      expect(q).toContain(part);
    expect(overpassBody('a b&c')).toBe('data=a%20b%26c');
  });

  it('parses Overpass JSON and skips what it cannot use', () => {
    const r = parseOverpassJson(
      JSON.stringify({
        version: 0.6,
        elements: [
          { type: 'node', id: 1, lat: 47.5, lon: 11.4, tags: { place: 'village', name: 'X' } },
          {
            type: 'way',
            id: 2,
            tags: { building: 'yes', 'building:levels': '2', bad: 3 },
            geometry: [{ lat: 47.5, lon: 11.4 }, null, { lat: 47.5001, lon: 11.4 }],
          },
          { type: 'way', id: 3, tags: {}, geometry: [{ lat: 47.5, lon: 11.4 }] }, // too short
          { type: 'relation', id: 4, tags: { landuse: 'forest' }, members: [{ type: 'node' }] },
          { type: 'area', id: 5 },
          'junk',
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.elements.map((e) => `${e.type}/${e.id}`)).toEqual(['node/1', 'way/2']);
    expect(r.elements[1]!.tags).toEqual({ building: 'yes', 'building:levels': '2' });
  });

  it('reports a server-side timeout as worth retrying, garbage as not', () => {
    const timeout = parseOverpassJson(
      JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query"' }),
    );
    expect(timeout).toMatchObject({ ok: false, retry: true });
    expect(parseOverpassJson('<html>nope</html>')).toMatchObject({ ok: false, retry: false });
    expect(parseOverpassJson('[]')).toMatchObject({ ok: false, retry: false });
  });
});

describe('scenery model', () => {
  const model = (): SceneryModel => ({
    ...emptyScenery('route-abc', 4000, true),
    fetchedAt: 1,
    buildings: [
      { alongM: 100, offsetM: 12.5, lengthM: 9, depthM: 8, heightM: 6, kind: 'house' },
      { alongM: 3950, offsetM: -20, lengthM: 20, depthM: 12, heightM: 9, kind: 'farm' },
    ],
    ground: [{ kind: 'forest', side: -1, fromM: 3900, toM: 4000, nearM: 8, farM: 150 }],
    water: [{ kind: 'river', side: 1, fromM: 0, toM: 500, nearM: 30, farM: 45 }],
    places: [{ name: 'Testdorf', kind: 'village', alongM: 60 }],
    structures: [{ kind: 'bridge', fromM: 200, toM: 240 }],
  });

  it('round-trips the codec exactly', () => {
    const m = model();
    const text = encodeScenery(m);
    const d = decodeScenery(text);
    if (!d.ok) throw new Error(d.error);
    expect(d.model).toEqual(m);
    expect(d.model.attribution).toBe(OSM_ATTRIBUTION);
  });

  it('refuses malformed or foreign files', () => {
    const good = JSON.parse(encodeScenery(model())) as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>) =>
      decodeScenery(JSON.stringify({ ...good, ...patch })).ok;
    expect(bad({})).toBe(true);
    expect(bad({ format: 'x' })).toBe(false);
    expect(bad({ version: 2 })).toBe(false);
    expect(bad({ routeId: '../etc' })).toBe(false);
    expect(bad({ b: [[1, 2, 3]] })).toBe(false);
    expect(bad({ b: [[1, 2, 30, 30, 30, 99]] })).toBe(false);
    expect(bad({ g: [[0, 0, 0, 10, 0, 5]] })).toBe(false); // side 0
    expect(bad({ p: [['', 0, 5]] })).toBe(false);
    expect(decodeScenery('nope').ok).toBe(false);
    expect(decodeScenery(42).ok).toBe(false);
  });

  it('keeps a dense route within the size limit, nearest buildings first', () => {
    const m = model();
    m.buildings = Array.from({ length: 30_000 }, (_, i) => ({
      alongM: i * 0.13,
      offsetM: (i % 2 ? 1 : -1) * (10 + (i % 140)),
      lengthM: 12.3,
      depthM: 9.7,
      heightM: 6,
      kind: 'house' as const,
    }));
    const limit = 400_000;
    const { model: bounded, text } = boundScenery(m, limit);
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(limit);
    expect(bounded.truncated).toBe(true);
    expect(bounded.buildings.length).toBeGreaterThan(5_000);
    const maxKept = Math.max(...bounded.buildings.map((b) => Math.abs(b.offsetM)));
    const dropped = m.buildings.filter((b) => !bounded.buildings.includes(b));
    expect(Math.min(...dropped.map((b) => Math.abs(b.offsetM)))).toBeGreaterThanOrEqual(maxKept);
    expect(utf8ByteLength(encodeScenery(m))).toBeLessThan(MAX_SCENERY_BYTES); // 30 k fit 2 MB
  });

  it('finds buildings and stretches in a window, across the lap line of a loop', () => {
    const m = model();
    const seen: number[] = [];
    forEachBuildingIn(m, 3900, 4200, (b, shift) => seen.push(b.alongM + shift));
    expect(seen).toEqual([3950, 4100]);
    const far: number[] = [];
    forEachBuildingIn(m, 3900, 4200, (b, shift) => far.push(b.alongM + shift), true);
    expect(far).toEqual([4100, 3950]);
    const water: number[] = [];
    forEachStretchIn(m.water, m, 4100, 4200, (s, shift) => water.push(s.fromM + shift));
    expect(water).toEqual([4000]);
    const p2p = { ...m, loop: false };
    const none: number[] = [];
    forEachBuildingIn(p2p, 4000, 4200, (b) => none.push(b.alongM));
    expect(none).toEqual([]);
  });
});

describe('fetchScenery: one request at a time, retries, cancel', () => {
  const t = (() => {
    const pts = Array.from({ length: 1001 }, (_, i) => at(0, i * 10));
    return buildRoute({ name: 'Ten km', points: pts, hasElevation: true });
  })();
  const chunks = sceneryChunks(t).length;
  const answer = (els: unknown[] = []): OverpassResponse => ({
    status: 200,
    text: JSON.stringify({ elements: els }),
  });

  it('sends the chunks one after another with a pause, and reports progress', async () => {
    const log: string[] = [];
    let inFlight = 0;
    const res = await fetchScenery(t, {
      transport: async (q) => {
        inFlight++;
        expect(inFlight).toBe(1);
        log.push(`req ${q.length > 0}`);
        await Promise.resolve();
        inFlight--;
        return answer();
      },
      sleep: async (ms) => void log.push(`sleep ${ms}`),
      onProgress: (p) => log.push(`${p.phase} ${p.done}/${p.total}`),
    });
    expect(res.ok).toBe(true);
    expect(res.requests).toBe(chunks);
    expect(log.filter((l) => l === 'sleep 1000')).toHaveLength(chunks - 1);
    expect(log.at(-1)).toBe(`building ${chunks}/${chunks}`);
  });

  it('backs off exponentially on 429/504 and honours Retry-After', async () => {
    const statuses = [429, 504, 200];
    const waits: number[] = [];
    let calls = 0;
    const res = await fetchScenery(t, {
      transport: async () => {
        const s = calls < statuses.length ? statuses[calls]! : 200;
        calls++;
        if (calls === 1) return { status: s, text: 'busy', retryAfterS: 7 };
        return s === 200 ? answer() : { status: s, text: '' };
      },
      sleep: async (ms) => void waits.push(ms),
      backoffMs: 1000,
      pauseMs: 0,
    });
    expect(res.ok).toBe(true);
    // 7 s from Retry-After, then the second step of the backoff (2 s).
    expect(waits).toEqual([7000, 2000]);
    expect(res.requests).toBe(chunks + 2);
  });

  it('retries network errors and server timeouts, then gives up with a reason', async () => {
    let calls = 0;
    const res = await fetchScenery(t, {
      transport: async () => {
        calls++;
        if (calls % 2) throw new Error('ECONNRESET');
        return {
          status: 200,
          text: JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }),
        };
      },
      sleep: async () => undefined,
      retries: 3,
      backoffMs: 1,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.cancelled).toBe(false);
    expect(calls).toBe(4);
    expect(res.error).toMatch(/gave up after 4 tries/);
  });

  it('does not retry a refused query', async () => {
    let calls = 0;
    const res = await fetchScenery(t, {
      transport: async () => {
        calls++;
        return { status: 400, text: 'bad' };
      },
      sleep: async () => undefined,
    });
    expect(calls).toBe(1);
    expect(res).toMatchObject({ ok: false, cancelled: false });
  });

  it('cancels during a request and during a backoff, and sends nothing more', async () => {
    const cancel = new CancelSource();
    let calls = 0;
    const pending = fetchScenery(t, {
      transport: (_q, signal: CancelSignal) => {
        calls++;
        return new Promise((_resolve, reject) => {
          signal.onCancel(() => reject(new Error('aborted')));
        });
      },
      signal: cancel.signal,
    });
    await Promise.resolve();
    cancel.cancel();
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
    expect(calls).toBe(1);

    const cancel2 = new CancelSource();
    let calls2 = 0;
    const res2 = fetchScenery(t, {
      transport: async () => {
        calls2++;
        return { status: 503, text: '' };
      },
      signal: cancel2.signal,
      backoffMs: 60_000,
    });
    for (let i = 0; i < 10; i++) await Promise.resolve(); // into the backoff
    cancel2.cancel();
    expect(await res2).toMatchObject({ ok: false, cancelled: true });
    expect(calls2).toBe(1);
  });
});
