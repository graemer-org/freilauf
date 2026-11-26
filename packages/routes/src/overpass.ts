/**
 * Talking to an Overpass API server (the read-only query service for OpenStreetMap data):
 * which boxes along a route to ask for, the query text, and reading the JSON answer
 * (https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL, output format "json" with
 * `out geom`). Pure; the request itself is made by the host (sceneryFetch.ts).
 *
 * Only a corridor along the route is asked for: the route is cut into chunks of a few
 * kilometres, each covered by one bounding box padded by the corridor width. Stretches that
 * an earlier part of the route already covers (the way back of an out-and-back, the end of a
 * loop) are not asked for twice.
 */
import { project, unproject, type Projection } from './geo';
import { SCENERY_CORRIDOR_M } from './scenery';
import type { RouteTrack } from './types';

/** The public main instance (fair-use policy: https://dev.overpass-api.de/overpass-doc/en/preface/commons.html). */
export const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** Sent as User-Agent where the host can set it: names the app, nothing about the rider. */
export const OVERPASS_USER_AGENT = 'Freilauf (open-source indoor cycling app)';
/** Server-side time limit asked for per query (s). */
export const OVERPASS_TIMEOUT_S = 90;
/** Place nodes are looked for this much further out than the corridor (town signs). */
export const PLACE_SEARCH_M = 1_500;

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface SceneryChunk {
  index: number;
  /** Route distance the chunk covers (first and last sample in it). */
  fromM: number;
  toM: number;
  /** Box for the features (corridor + margin). */
  bbox: Bbox;
  /** Larger box for place names. */
  placeBbox: Bbox;
}

export interface ChunkOptions {
  corridorM?: number;
  /** Largest box area (km²) and route length (m) per chunk. */
  maxAreaKm2?: number;
  maxLengthM?: number;
}

/** Route samples within this of an earlier part of the route count as covered by it. */
const COVERED_M = 25;
/** Extra margin around the corridor: building footprints reach out, the projection distorts. */
const MARGIN_M = 50;

/** Local x/y (m) of every sample, projected around the first one. */
export function routeXY(track: RouteTrack): { proj: Projection; x: Float64Array; y: Float64Array } {
  const proj = { lat0: track.lat[0]!, lon0: track.lon[0]! };
  const x = new Float64Array(track.count);
  const y = new Float64Array(track.count);
  for (let i = 0; i < track.count; i++) {
    const p = project(proj, track.lat[i]!, track.lon[i]!);
    x[i] = p.x;
    y[i] = p.y;
  }
  return { proj, x, y };
}

/**
 * Which samples an earlier part of the route already covers: within COVERED_M of a sample at
 * least three corridor widths earlier along the route.
 */
export function coveredSamples(
  track: RouteTrack,
  x: Float64Array,
  y: Float64Array,
  corridorM = SCENERY_CORRIDOR_M,
): Uint8Array {
  const n = track.count;
  const out = new Uint8Array(n);
  const cell = 50;
  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number): string => `${cx},${cy}`;
  const lag = Math.max(1, Math.ceil((3 * corridorM) / track.stepM));
  for (let i = 0; i < n; i++) {
    // Make samples old enough searchable.
    const j = i - lag;
    if (j >= 0) {
      const k = key(Math.floor(x[j]! / cell), Math.floor(y[j]! / cell));
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(j);
    }
    const cx = Math.floor(x[i]! / cell);
    const cy = Math.floor(y[i]! / cell);
    search: for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const j2 of grid.get(key(gx, gy)) ?? []) {
          if (Math.hypot(x[j2]! - x[i]!, y[j2]! - y[i]!) <= COVERED_M) {
            out[i] = 1;
            break search;
          }
        }
      }
    }
  }
  return out;
}

function toBbox(proj: Projection, x0: number, y0: number, x1: number, y1: number): Bbox {
  const sw = unproject(proj, x0, y0);
  const ne = unproject(proj, x1, y1);
  const r = (v: number): number => Math.round(v * 1e6) / 1e6;
  return { south: r(sw.lat), west: r(sw.lon), north: r(ne.lat), east: r(ne.lon) };
}

/** The boxes to ask for, in route order. */
export function sceneryChunks(track: RouteTrack, options: ChunkOptions = {}): SceneryChunk[] {
  const corridor = options.corridorM ?? SCENERY_CORRIDOR_M;
  const maxArea = (options.maxAreaKm2 ?? 4) * 1e6;
  const maxLength = options.maxLengthM ?? 4_000;
  const pad = corridor + MARGIN_M;
  const { proj, x, y } = routeXY(track);
  const covered = coveredSamples(track, x, y, corridor);
  const chunks: SceneryChunk[] = [];
  interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    from: number;
    to: number;
  }
  let box = null as Box | null;
  const flush = (): void => {
    if (!box) return;
    chunks.push({
      index: chunks.length,
      fromM: box.from,
      toM: box.to,
      bbox: toBbox(proj, box.x0, box.y0, box.x1, box.y1),
      placeBbox: toBbox(
        proj,
        box.x0 - PLACE_SEARCH_M,
        box.y0 - PLACE_SEARCH_M,
        box.x1 + PLACE_SEARCH_M,
        box.y1 + PLACE_SEARCH_M,
      ),
    });
    box = null;
  };
  for (let i = 0; i < track.count; i++) {
    if (covered[i]) continue;
    const at = i * track.stepM;
    const sx0 = x[i]! - pad;
    const sy0 = y[i]! - pad;
    const sx1 = x[i]! + pad;
    const sy1 = y[i]! + pad;
    const open: Box | null = box;
    if (open) {
      const nx0 = Math.min(open.x0, sx0);
      const ny0 = Math.min(open.y0, sy0);
      const nx1 = Math.max(open.x1, sx1);
      const ny1 = Math.max(open.y1, sy1);
      if ((nx1 - nx0) * (ny1 - ny0) > maxArea || at - open.from > maxLength) flush();
      else {
        box = { ...open, x0: nx0, y0: ny0, x1: nx1, y1: ny1, to: at };
        continue;
      }
    }
    box = { x0: sx0, y0: sy0, x1: sx1, y1: sy1, from: at, to: at };
  }
  flush();
  return chunks;
}

const bboxText = (b: Bbox): string => `${b.south},${b.west},${b.north},${b.east}`;

/** Land cover and water tags asked for (and understood by sceneryBuild.ts). */
export const LANDUSE_VALUES = [
  'forest',
  'meadow',
  'farmland',
  'grass',
  'residential',
  'orchard',
  'vineyard',
  'village_green',
  'allotments',
] as const;
export const NATURAL_VALUES = ['wood', 'water', 'grassland', 'heath', 'scrub'] as const;
export const WATERWAY_VALUES = ['riverbank', 'river', 'stream', 'canal'] as const;
export const PLACE_VALUES = ['city', 'town', 'village', 'hamlet'] as const;

const alt = (values: readonly string[]): string => `^(${values.join('|')})$`;

/** Overpass QL for one chunk. */
export function overpassQuery(chunk: SceneryChunk, timeoutS = OVERPASS_TIMEOUT_S): string {
  const b = bboxText(chunk.bbox);
  const landuse = alt(LANDUSE_VALUES);
  const natural = alt(NATURAL_VALUES);
  return [
    `[out:json][timeout:${Math.round(timeoutS)}];`,
    '(',
    `  way["building"](${b});`,
    `  way["landuse"~"${landuse}"](${b});`,
    `  relation["type"="multipolygon"]["landuse"~"${landuse}"](${b});`,
    `  way["natural"~"${natural}"](${b});`,
    `  relation["type"="multipolygon"]["natural"~"${natural}"](${b});`,
    `  way["waterway"~"${alt(WATERWAY_VALUES)}"](${b});`,
    `  relation["type"="multipolygon"]["waterway"="riverbank"](${b});`,
    `  way["highway"]["bridge"~"^(yes|viaduct)$"](${b});`,
    `  way["highway"]["tunnel"~"^(yes|building_passage)$"](${b});`,
    ');',
    'out geom qt;',
    `node["place"~"${alt(PLACE_VALUES)}"]["name"](${bboxText(chunk.placeBbox)});`,
    'out qt;',
  ].join('\n');
}

/** The form body Overpass expects for a POST. */
export const overpassBody = (query: string): string => `data=${encodeURIComponent(query)}`;

// ───────────── the answer ─────────────

export interface LatLon {
  lat: number;
  lon: number;
}

export type OsmTags = Record<string, string>;

export type OsmElement =
  | { type: 'node'; id: number; lat: number; lon: number; tags: OsmTags }
  | { type: 'way'; id: number; tags: OsmTags; geometry: LatLon[] }
  | {
      type: 'relation';
      id: number;
      tags: OsmTags;
      members: { type: string; role: string; geometry: LatLon[] }[];
    };

export type OverpassParseResult =
  | { ok: true; elements: OsmElement[] }
  /** `retry`: the server ran out of time or memory (worth another try later). */
  | { ok: false; error: string; retry: boolean };

/** Node coordinates kept per way at most (longer geometry is rare and only costs time). */
const MAX_WAY_NODES = 20_000;

function readTags(v: unknown): OsmTags {
  const out: OsmTags = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && k.length <= 64) out[k] = val.slice(0, 200);
  }
  return out;
}

function readGeometry(v: unknown): LatLon[] | null {
  if (!Array.isArray(v)) return null;
  const out: LatLon[] = [];
  for (const p of v.slice(0, MAX_WAY_NODES)) {
    if (typeof p !== 'object' || p === null) continue; // "null" for nodes outside a clip
    const { lat, lon } = p as { lat?: unknown; lon?: unknown };
    if (
      typeof lat === 'number' &&
      typeof lon === 'number' &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180
    )
      out.push({ lat, lon });
  }
  return out;
}

/** Reads an Overpass JSON answer; unknown or malformed elements are skipped. Never throws. */
export function parseOverpassJson(text: string): OverpassParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const busy = /rate_limited|too many requests|timeout|out of memory/i.test(text.slice(0, 2000));
    return { ok: false, error: 'The answer was not OSM data.', retry: busy };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, error: 'The answer was not OSM data.', retry: false };
  const r = raw as { elements?: unknown; remark?: unknown };
  // On a timeout or memory limit the server still answers 200, with a "remark".
  if (typeof r.remark === 'string' && /runtime (error|remark)/i.test(r.remark)) {
    return {
      ok: false,
      error: `The map server could not finish the query (${r.remark.slice(0, 120)}).`,
      retry: true,
    };
  }
  if (!Array.isArray(r.elements))
    return { ok: false, error: 'The answer was not OSM data.', retry: false };
  const elements: OsmElement[] = [];
  for (const e of r.elements as unknown[]) {
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, unknown>;
    if (typeof o.id !== 'number' || !Number.isFinite(o.id)) continue;
    const tags = readTags(o.tags);
    if (o.type === 'node') {
      if (typeof o.lat !== 'number' || typeof o.lon !== 'number') continue;
      elements.push({ type: 'node', id: o.id, lat: o.lat, lon: o.lon, tags });
    } else if (o.type === 'way') {
      const geometry = readGeometry(o.geometry);
      if (!geometry || geometry.length < 2) continue;
      elements.push({ type: 'way', id: o.id, tags, geometry });
    } else if (o.type === 'relation') {
      if (!Array.isArray(o.members)) continue;
      const members: { type: string; role: string; geometry: LatLon[] }[] = [];
      for (const m of o.members as unknown[]) {
        if (typeof m !== 'object' || m === null) continue;
        const mm = m as Record<string, unknown>;
        if (mm.type !== 'way') continue;
        const geometry = readGeometry(mm.geometry);
        if (!geometry || geometry.length < 2) continue;
        members.push({
          type: 'way',
          role: typeof mm.role === 'string' ? mm.role : '',
          geometry,
        });
      }
      if (members.length > 0) elements.push({ type: 'relation', id: o.id, tags, members });
    }
  }
  return { ok: true, elements };
}
