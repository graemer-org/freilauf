/**
 * The scenery along a route (buildings, woods and fields, water, town names), as a compact
 * route-relative model: every feature is placed by its distance along the route and its
 * lateral offset from the road (+ right, − left, in the direction of travel), in metres. That
 * is exactly what the ride scenes draw, so nothing has to be projected at ride time, and the
 * model works offline once it is stored next to the route.
 *
 * Built from OpenStreetMap data (sceneryBuild.ts, overpass.ts); docs/adr/0011-osm-scenery.md.
 * Pure: no DOM, no Node APIs. Decoding validates everything (the file is untrusted input).
 */
import { cleanText, utf8ByteLength } from './geo';

export const SCENERY_FORMAT = 'freilauf-scenery';
export const SCENERY_FORMAT_VERSION = 1;
/** Required attribution wherever the data is shown (ODbL). */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Features are kept up to this far from the road on either side (m). */
export const SCENERY_CORRIDOR_M = 150;
/** Encoded size limit (UTF-8 bytes) of one route's scenery. */
export const MAX_SCENERY_BYTES = 2 * 1024 * 1024;
/** Count limits; beyond them the features farthest from the road are dropped first. */
export const MAX_SCENERY_BUILDINGS = 30_000;
export const MAX_SCENERY_STRETCHES = 20_000;
export const MAX_SCENERY_PLACES = 400;
export const MAX_SCENERY_STRUCTURES = 2_000;
/** Stretches longer than this are split (keeps the lookups by distance cheap). */
export const MAX_STRETCH_M = 2_000;
/** Longest place name kept (characters). */
export const MAX_PLACE_NAME = 40;

export const BUILDING_KINDS = [
  'house',
  'apartments',
  'farm',
  'shed',
  'industrial',
  'church',
  'other',
] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];

export const GROUND_KINDS = [
  'forest',
  'meadow',
  'farmland',
  'grass',
  'residential',
  'orchard',
] as const;
export type GroundKind = (typeof GROUND_KINDS)[number];

export const WATER_KINDS = ['lake', 'river', 'stream'] as const;
export type WaterKind = (typeof WATER_KINDS)[number];

export const PLACE_KINDS = ['city', 'town', 'village', 'hamlet'] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

export const STRUCTURE_KINDS = ['bridge', 'tunnel'] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];

/**
 * A building as a box aligned with the road: centre at `alongM` / `offsetM`, `lengthM` along
 * the road, `depthM` across it, `heightM` to the eaves (pitched roofs add on top).
 */
export interface SceneryBuilding {
  alongM: number;
  offsetM: number;
  lengthM: number;
  depthM: number;
  heightM: number;
  kind: BuildingKind;
}

/** Land cover beside the road over a stretch: from `nearM` to `farM` metres out on `side`. */
export interface SceneryStretch<K extends string> {
  kind: K;
  /** −1 left, +1 right. */
  side: -1 | 1;
  fromM: number;
  toM: number;
  nearM: number;
  farM: number;
}

/** A town sign at the route's entry into a place. */
export interface SceneryPlace {
  name: string;
  kind: PlaceKind;
  /** Where the sign stands (route distance), on the right verge. */
  alongM: number;
}

/** A bridge or tunnel on the route itself. */
export interface SceneryStructure {
  kind: StructureKind;
  fromM: number;
  toM: number;
}

export interface SceneryModel {
  routeId: string;
  /** The route length the model was built for (a check on load). */
  totalDistanceM: number;
  loop: boolean;
  /** When the data was fetched (ms since 1970). */
  fetchedAt: number;
  corridorM: number;
  attribution: string;
  /** Sorted by alongM. */
  buildings: SceneryBuilding[];
  /** Sorted by fromM. */
  ground: SceneryStretch<GroundKind>[];
  water: SceneryStretch<WaterKind>[];
  places: SceneryPlace[];
  structures: SceneryStructure[];
  /** True when the caps dropped features (a very dense route). */
  truncated: boolean;
}

/** What the Routes tab shows about a route's stored scenery. */
export interface ScenerySummary {
  buildings: number;
  forestM: number;
  waterM: number;
  places: string[];
  bytes: number;
  fetchedAt: number;
  truncated: boolean;
}

export function emptyScenery(routeId: string, totalDistanceM: number, loop: boolean): SceneryModel {
  return {
    routeId,
    totalDistanceM,
    loop,
    fetchedAt: 0,
    corridorM: SCENERY_CORRIDOR_M,
    attribution: OSM_ATTRIBUTION,
    buildings: [],
    ground: [],
    water: [],
    places: [],
    structures: [],
    truncated: false,
  };
}

export function sceneryIsEmpty(m: SceneryModel): boolean {
  return (
    m.buildings.length === 0 &&
    m.ground.length === 0 &&
    m.water.length === 0 &&
    m.places.length === 0 &&
    m.structures.length === 0
  );
}

/** Length of the stretches per side summed (m), e.g. "forest along 3.2 km". */
function stretchLength(list: readonly SceneryStretch<string>[], kind?: string): number {
  let sum = 0;
  for (const s of list) if (!kind || s.kind === kind) sum += s.toM - s.fromM;
  return sum;
}

export function summarizeScenery(m: SceneryModel, bytes: number): ScenerySummary {
  return {
    buildings: m.buildings.length,
    forestM: Math.round(stretchLength(m.ground, 'forest')),
    waterM: Math.round(stretchLength(m.water)),
    places: [...new Set(m.places.map((p) => p.name))].slice(0, 20),
    bytes,
    fetchedAt: m.fetchedAt,
    truncated: m.truncated,
  };
}

// ───────────── codec ─────────────

const dm = (v: number): number => Math.round(v * 10);
const m1 = (v: number): number => Math.round(v);

/**
 * Encodes a model as compact JSON: buildings as integer tuples in decimetres, stretches in
 * whole metres. A 2000-house town takes ~60 KB.
 */
export function encodeScenery(m: SceneryModel): string {
  const kindIndex = <K extends string>(list: readonly K[], k: K): number => list.indexOf(k);
  return JSON.stringify({
    format: SCENERY_FORMAT,
    version: SCENERY_FORMAT_VERSION,
    routeId: m.routeId,
    totalDistanceM: Math.round(m.totalDistanceM * 10) / 10,
    loop: m.loop,
    fetchedAt: Math.round(m.fetchedAt),
    corridorM: m.corridorM,
    attribution: OSM_ATTRIBUTION,
    truncated: m.truncated,
    b: m.buildings.map((b) => [
      dm(b.alongM),
      dm(b.offsetM),
      dm(b.lengthM),
      dm(b.depthM),
      dm(b.heightM),
      kindIndex(BUILDING_KINDS, b.kind),
    ]),
    g: m.ground.map((s) => [
      kindIndex(GROUND_KINDS, s.kind),
      s.side,
      m1(s.fromM),
      m1(s.toM),
      m1(s.nearM),
      m1(s.farM),
    ]),
    w: m.water.map((s) => [
      kindIndex(WATER_KINDS, s.kind),
      s.side,
      m1(s.fromM),
      m1(s.toM),
      m1(s.nearM),
      m1(s.farM),
    ]),
    p: m.places.map((p) => [p.name, kindIndex(PLACE_KINDS, p.kind), m1(p.alongM)]),
    s: m.structures.map((s) => [kindIndex(STRUCTURE_KINDS, s.kind), m1(s.fromM), m1(s.toM)]),
  });
}

export type DecodeSceneryResult = { ok: true; model: SceneryModel } | { ok: false; error: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validates and decodes stored scenery; never throws. */
export function decodeScenery(text: unknown): DecodeSceneryResult {
  const fail = (error: string): DecodeSceneryResult => ({ ok: false, error });
  if (typeof text !== 'string') return fail('not text');
  if (utf8ByteLength(text) > MAX_SCENERY_BYTES + 1024) return fail('too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r.format !== SCENERY_FORMAT) return fail('not a scenery file');
  if (r.version !== SCENERY_FORMAT_VERSION) return fail(`unsupported version ${String(r.version)}`);
  if (typeof r.routeId !== 'string' || !ID.test(r.routeId)) return fail('bad route id');
  const total = r.totalDistanceM;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0 || total > 1e6)
    return fail('bad route length');
  const lo = -1000;
  const hi = total + 1000;
  const lists = ['b', 'g', 'w', 'p', 's'] as const;
  for (const k of lists) if (!Array.isArray(r[k])) return fail(`missing ${k}`);
  const b = r.b as unknown[];
  const g = r.g as unknown[];
  const w = r.w as unknown[];
  const p = r.p as unknown[];
  const s = r.s as unknown[];
  if (
    b.length > MAX_SCENERY_BUILDINGS ||
    g.length + w.length > MAX_SCENERY_STRETCHES ||
    p.length > MAX_SCENERY_PLACES ||
    s.length > MAX_SCENERY_STRUCTURES
  )
    return fail('too many features');

  const buildings: SceneryBuilding[] = [];
  for (const t of b) {
    if (!Array.isArray(t) || t.length !== 6 || !t.every(isInt)) return fail('bad building');
    const [a, o, l, d, h, k] = t as number[];
    const kind = BUILDING_KINDS[k!];
    if (
      !kind ||
      a! / 10 < lo ||
      a! / 10 > hi ||
      Math.abs(o!) > 5000 ||
      l! <= 0 ||
      d! <= 0 ||
      l! > 5000 ||
      d! > 5000 ||
      h! <= 0 ||
      h! > 3000
    )
      return fail('bad building');
    buildings.push({
      alongM: a! / 10,
      offsetM: o! / 10,
      lengthM: l! / 10,
      depthM: d! / 10,
      heightM: h! / 10,
      kind,
    });
  }
  const stretches = <K extends string>(
    list: unknown[],
    kinds: readonly K[],
  ): SceneryStretch<K>[] | null => {
    const out: SceneryStretch<K>[] = [];
    for (const t of list) {
      if (!Array.isArray(t) || t.length !== 6 || !t.every(isInt)) return null;
      const [k, side, from, to, near, far] = t as number[];
      const kind = kinds[k!];
      if (!kind || (side !== -1 && side !== 1)) return null;
      if (
        from! < lo ||
        to! > hi ||
        to! <= from! ||
        to! - from! > MAX_STRETCH_M ||
        near! < 0 ||
        far! <= near! ||
        far! > 2000
      )
        return null;
      out.push({ kind, side, fromM: from!, toM: to!, nearM: near!, farM: far! });
    }
    return out;
  };
  const ground = stretches(g, GROUND_KINDS);
  if (!ground) return fail('bad land cover');
  const water = stretches(w, WATER_KINDS);
  if (!water) return fail('bad water');
  const places: SceneryPlace[] = [];
  for (const t of p) {
    if (!Array.isArray(t) || t.length !== 3) return fail('bad place');
    const [name, k, along] = t as unknown[];
    const kind = isInt(k) ? PLACE_KINDS[k] : undefined;
    if (typeof name !== 'string' || !kind || !isInt(along) || along < lo || along > hi)
      return fail('bad place');
    const clean = cleanText(name, MAX_PLACE_NAME);
    if (!clean) return fail('bad place');
    places.push({ name: clean, kind, alongM: along });
  }
  const structures: SceneryStructure[] = [];
  for (const t of s) {
    if (!Array.isArray(t) || t.length !== 3 || !t.every(isInt)) return fail('bad structure');
    const [k, from, to] = t as number[];
    const kind = STRUCTURE_KINDS[k!];
    if (!kind || from! < lo || to! > hi || to! <= from!) return fail('bad structure');
    structures.push({ kind, fromM: from!, toM: to! });
  }
  const corridor = r.corridorM;
  const fetchedAt = r.fetchedAt;
  return {
    ok: true,
    model: {
      routeId: r.routeId,
      totalDistanceM: total,
      loop: r.loop === true,
      fetchedAt: typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? fetchedAt : 0,
      corridorM:
        typeof corridor === 'number' && corridor > 0 && corridor <= 1000
          ? corridor
          : SCENERY_CORRIDOR_M,
      attribution: OSM_ATTRIBUTION,
      buildings: buildings.sort((x, y) => x.alongM - y.alongM),
      ground: ground.sort((x, y) => x.fromM - y.fromM),
      water: water.sort((x, y) => x.fromM - y.fromM),
      places: places.sort((x, y) => x.alongM - y.alongM),
      structures: structures.sort((x, y) => x.fromM - y.fromM),
      truncated: r.truncated === true,
    },
  };
}

/**
 * Fits a model into MAX_SCENERY_BYTES: drops the buildings farthest from the road (and
 * then the shortest stretches) until the encoding fits. Returns the encoded text.
 */
export function boundScenery(
  m: SceneryModel,
  maxBytes = MAX_SCENERY_BYTES,
): {
  model: SceneryModel;
  text: string;
} {
  let model = m;
  let text = encodeScenery(model);
  for (let round = 0; round < 40 && utf8ByteLength(text) > maxBytes; round++) {
    const keepB = Math.floor(model.buildings.length * 0.8);
    const byNear = [...model.buildings].sort((a, b) => Math.abs(a.offsetM) - Math.abs(b.offsetM));
    const buildings = byNear.slice(0, keepB).sort((a, b) => a.alongM - b.alongM);
    const trim = <K extends string>(list: SceneryStretch<K>[]): SceneryStretch<K>[] =>
      buildings.length > 0
        ? list
        : [...list]
            .sort((a, b) => b.toM - b.fromM - (a.toM - a.fromM))
            .slice(0, Math.floor(list.length * 0.8))
            .sort((a, b) => a.fromM - b.fromM);
    model = {
      ...model,
      buildings,
      ground: trim(model.ground),
      water: trim(model.water),
      truncated: true,
    };
    text = encodeScenery(model);
  }
  return { model, text };
}

// ───────────── queries for the renderers ─────────────

/** Index of the first item whose key is ≥ `v` (items sorted by key). */
export function lowerBound<T>(list: readonly T[], v: number, key: (t: T) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]!) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Calls `fn` for every building whose centre lies in [fromM, toM] of route distance, which may
 * run across laps on a loop (unwrapped distances); `shift` is what to add to the stored
 * alongM to get the unwrapped position. Far to near order when `farFirst`.
 */
export function forEachBuildingIn(
  m: SceneryModel,
  fromM: number,
  toM: number,
  fn: (b: SceneryBuilding, shift: number) => void,
  farFirst = false,
): void {
  const list = m.buildings;
  if (list.length === 0 || toM < fromM) return;
  const total = m.totalDistanceM;
  const ranges: [number, number, number][] = [];
  if (m.loop && total > 0) {
    const first = Math.floor(fromM / total);
    const last = Math.floor(toM / total);
    for (let lap = first; lap <= last && lap - first < 4; lap++) {
      const shift = lap * total;
      ranges.push([Math.max(fromM, shift) - shift, Math.min(toM, shift + total) - shift, shift]);
    }
  } else ranges.push([fromM, toM, 0]);
  if (farFirst) ranges.reverse();
  for (const [a, b, shift] of ranges) {
    const i0 = lowerBound(list, a, (x) => x.alongM);
    const i1 = lowerBound(list, b + 1e-9, (x) => x.alongM);
    if (farFirst) for (let i = i1 - 1; i >= i0; i--) fn(list[i]!, shift);
    else for (let i = i0; i < i1; i++) fn(list[i]!, shift);
  }
}

/** Stretches overlapping [fromM, toM] (unwrapped on a loop), with the lap shift. */
export function forEachStretchIn<K extends string>(
  list: readonly SceneryStretch<K>[],
  m: Pick<SceneryModel, 'loop' | 'totalDistanceM'>,
  fromM: number,
  toM: number,
  fn: (s: SceneryStretch<K>, shift: number) => void,
): void {
  if (list.length === 0 || toM < fromM) return;
  const total = m.totalDistanceM;
  const laps: number[] = [];
  if (m.loop && total > 0) {
    for (let lap = Math.floor(fromM / total) - 1; lap <= Math.floor(toM / total); lap++)
      laps.push(lap * total);
  } else laps.push(0);
  for (const shift of laps) {
    // Stretches are at most MAX_STRETCH_M long, so the search can start that far back.
    const i0 = lowerBound(list, fromM - shift - MAX_STRETCH_M, (x) => x.fromM);
    for (let i = i0; i < list.length; i++) {
      const s = list[i]!;
      if (s.fromM + shift > toM) break;
      if (s.toM + shift < fromM) continue;
      fn(s, shift);
    }
  }
}
