/**
 * The scenery pipeline on the real route fixture with the synthetic Overpass answer
 * (osmFixture.ts): chunking a 98 km out-and-back, building, bounds, codec.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildScenery,
  decodeScenery,
  encodeScenery,
  fetchScenery,
  MAX_SCENERY_BYTES,
  overpassQuery,
  parseOverpassJson,
  sceneryChunks,
  SCENERY_CORRIDOR_M,
  utf8ByteLength,
} from '../src/index';
import { ISAR_OVERPASS, isarTrack, makeIsarOverpass } from './osmFixture';

const track = isarTrack();
const fixtureText = (): string =>
  existsSync(ISAR_OVERPASS)
    ? readFileSync(ISAR_OVERPASS, 'utf8')
    : `${JSON.stringify(makeIsarOverpass(track), null, 1)}\n`;

describe('synthetic Overpass fixture along isar-ursprung.gpx', () => {
  it('is reproducible (UPDATE_OSM_FIXTURE=1 rewrites it)', () => {
    const json = `${JSON.stringify(makeIsarOverpass(track), null, 1)}\n`;
    if (process.env.UPDATE_OSM_FIXTURE === '1' || !existsSync(ISAR_OVERPASS)) {
      mkdirSync(path.dirname(ISAR_OVERPASS), { recursive: true });
      writeFileSync(ISAR_OVERPASS, json);
    }
    expect(readFileSync(ISAR_OVERPASS, 'utf8')).toBe(json);
    expect(json.length).toBeLessThan(400_000); // a small fixture
  });

  it('parses as Overpass JSON', () => {
    const parsed = parseOverpassJson(readFileSync(ISAR_OVERPASS, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const types = new Set(parsed.elements.map((e) => e.type));
    expect(types).toEqual(new Set(['way', 'node', 'relation']));
  });
});

describe('scenery of the out-and-back fixture', () => {
  const parsed = parseOverpassJson(fixtureText());
  if (!parsed.ok) throw new Error(parsed.error);
  const { model, text } = buildScenery(track, parsed.elements, 1_700_000_000_000);
  const total = track.totalDistanceM;

  it('places the village on both sides, at its distance, both ways', () => {
    const out = model.buildings.filter((b) => b.alongM < 2_000);
    const back = model.buildings.filter((b) => b.alongM > total - 2_000);
    expect(out.length).toBeGreaterThan(80);
    // The way back passes the same houses: as many, mirrored sides.
    expect(Math.abs(back.length - out.length)).toBeLessThan(out.length * 0.1);
    expect(out.some((b) => b.offsetM > 0) && out.some((b) => b.offsetM < 0)).toBe(true);
    for (const b of out) {
      expect(b.alongM).toBeGreaterThan(150);
      expect(b.alongM).toBeLessThan(1_700);
      expect(Math.abs(b.offsetM) - b.depthM / 2).toBeGreaterThanOrEqual(5.9);
      expect(Math.abs(b.offsetM) - b.depthM / 2).toBeLessThanOrEqual(SCENERY_CORRIDOR_M);
    }
    const church = out.find((b) => b.kind === 'church')!;
    expect(church.alongM).toBeCloseTo(900, -1);
    expect(church.offsetM).toBeCloseTo(-38, 0);
    expect(church.heightM).toBeGreaterThan(15);
    // Mirrored on the way back: the church is on the right then.
    const churchBack = back.find((b) => b.kind === 'church')!;
    expect(churchBack.offsetM).toBeGreaterThan(30);
    expect(total - churchBack.alongM).toBeGreaterThan(800);
    expect(total - churchBack.alongM).toBeLessThan(1_000);
  });

  it('drops what is beyond the corridor or not a building', () => {
    expect(model.buildings.some((b) => Math.abs(b.offsetM) > 300)).toBe(false);
    expect(model.buildings.some((b) => b.kind === 'industrial')).toBe(false); // too large
    expect(model.ground.some((g) => g.fromM > 6_900 && g.toM < 8_100)).toBe(false);
  });

  it('has the forest on the left, the meadow and the river on the right', () => {
    const forest = model.ground.filter((g) => g.kind === 'forest' && g.fromM < 5_000);
    expect(forest.length).toBeGreaterThan(0);
    expect(forest.every((g) => g.side === -1)).toBe(true);
    const fFrom = Math.min(...forest.map((g) => g.fromM));
    const fTo = Math.max(...forest.map((g) => g.toM));
    expect(fFrom).toBeGreaterThan(1_950);
    expect(fFrom).toBeLessThan(2_100);
    expect(fTo).toBeGreaterThan(4_400);
    expect(fTo).toBeLessThan(4_550);
    // The clearing starts the forest further out there.
    const clearing = forest.filter((g) => g.fromM >= 3_120 && g.toM <= 3_280);
    expect(clearing.every((g) => g.nearM >= 25)).toBe(true);
    const meadow = model.ground.filter((g) => g.kind === 'meadow' && g.fromM < 5_000);
    expect(meadow.every((g) => g.side === 1)).toBe(true);
    const river = model.water.filter((w) => w.fromM < 6_500 && w.side === 1);
    const riverM = river.reduce((n, w) => n + w.toM - w.fromM, 0);
    expect(riverM).toBeGreaterThan(5_000);
    for (const w of river) {
      expect(w.nearM).toBeGreaterThan(15);
      expect(w.farM).toBeLessThan(80);
    }
    // On the way back the river is on the left.
    expect(model.water.some((w) => w.fromM > total - 6_000 && w.side === -1)).toBe(true);
  });

  it('puts town signs at the entry of the village, both ways, and finds the bridge', () => {
    const signs = model.places.filter((p) => p.name === 'Kleinmoos');
    expect(signs).toHaveLength(2);
    expect(signs[0]!.alongM).toBeGreaterThan(80);
    expect(signs[0]!.alongM).toBeLessThan(260);
    expect(total - signs[1]!.alongM).toBeGreaterThan(1_550);
    expect(total - signs[1]!.alongM).toBeLessThan(1_750);
    expect(model.places.some((p) => p.name === 'Auhof' && p.kind === 'hamlet')).toBe(true);
    const bridge = model.structures.find((s) => s.kind === 'bridge' && s.fromM < 6_000)!;
    expect(bridge.fromM).toBeGreaterThan(4_990);
    expect(bridge.toM).toBeLessThan(5_075);
  });

  it('round-trips the codec and stays small', () => {
    expect(utf8ByteLength(text)).toBeLessThan(150_000);
    const decoded = decodeScenery(text);
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.model.buildings).toHaveLength(model.buildings.length);
    expect(decoded.model.places).toEqual(model.places);
    expect(encodeScenery(decoded.model)).toBe(text);
  });

  it('chunks the 98 km out-and-back once, never the way back', () => {
    const chunks = sceneryChunks(track);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.length).toBeLessThan(40);
    // Almost everything asked for lies on the way out: the way back retraces it (apart from
    // two short stretches where the planner took another road back).
    const asked = chunks.reduce((n, c) => n + c.toM - c.fromM, 0);
    expect(asked).toBeLessThan(total * 0.55);
    expect(chunks.filter((c) => c.fromM > total / 2).length).toBeLessThanOrEqual(3);
    for (const c of chunks) {
      const q = overpassQuery(c);
      expect(q).toContain('[out:json]');
      expect(q).toContain(`(${c.bbox.south},${c.bbox.west},${c.bbox.north},${c.bbox.east})`);
      expect(q.length).toBeLessThan(2_000);
    }
  });

  it('fetches through a fake server: one request per chunk, the same model', async () => {
    const body = fixtureText();
    const queries: string[] = [];
    const res = await fetchScenery(track, {
      transport: async (q) => {
        queries.push(q);
        return { status: 200, text: queries.length === 1 ? body : '{"elements":[]}' };
      },
      sleep: async () => undefined,
      now: () => 1_700_000_000_000,
    });
    if (!res.ok) throw new Error(res.error);
    expect(queries).toHaveLength(sceneryChunks(track).length);
    expect(res.text).toBe(text);
    expect(res.summary.buildings).toBe(model.buildings.length);
    expect(res.summary.places).toEqual(['Kleinmoos', 'Auhof']);
    expect(utf8ByteLength(res.text)).toBeLessThanOrEqual(MAX_SCENERY_BYTES);
  });
});
