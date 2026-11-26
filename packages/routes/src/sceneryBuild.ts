/**
 * Turns OpenStreetMap elements (overpass.ts) into the route-relative scenery model
 * (scenery.ts): every feature is placed by distance along the route and lateral offset.
 *
 * - Buildings: the footprint's centre is projected onto the route; a building near the road
 *   more than once (the way back of an out-and-back, the next lap of a loop that crosses
 *   itself) is placed once per pass, on the side it lies on for that pass. The footprint is
 *   measured in the road's frame there (length along, depth across).
 * - Land cover and water: the route is probed every PROBE_M with a line across it; where the
 *   line runs inside a polygon (even-odd over all rings, so holes work) or crosses a river
 *   line, that side has that cover from `near` to `far` metres out. Runs of equal probes
 *   become stretches.
 * - Town signs: where the route enters the built-up area around a place node.
 * - Bridges and tunnels: highway ways tagged so that run along the route for a while.
 *
 * Everything beyond the corridor is dropped; counts and size are bounded (boundScenery).
 */
import { cleanText, project, type Projection } from './geo';
import type { LatLon, OsmElement, OsmTags } from './overpass';
import { routeXY } from './overpass';
import {
  boundScenery,
  type BuildingKind,
  type GroundKind,
  MAX_PLACE_NAME,
  MAX_SCENERY_BUILDINGS,
  MAX_SCENERY_PLACES,
  MAX_SCENERY_STRETCHES,
  MAX_SCENERY_STRUCTURES,
  MAX_STRETCH_M,
  OSM_ATTRIBUTION,
  type PlaceKind,
  SCENERY_CORRIDOR_M,
  type SceneryBuilding,
  type SceneryModel,
  type SceneryPlace,
  type SceneryStretch,
  type SceneryStructure,
  type StructureKind,
  type WaterKind,
} from './scenery';
import type { RouteTrack } from './types';

/** Spacing of the probes across the route (m). */
export const PROBE_M = 20;
/** Buildings never stand closer to the road centre than this (asphalt + verge, m). */
export const BUILDING_MIN_OFFSET_M = 6;
/** Footprints larger than this (m, either way) are not drawn as a building. */
const MAX_FOOTPRINT_M = 250;
/** How far from the road a place node may be for its sign (m). */
const PLACE_RADIUS_M: Record<PlaceKind, number> = {
  city: 3000,
  town: 2000,
  village: 1200,
  hamlet: 600,
};
/** Buildings closer than this along the road count as one built-up area (m). */
const BUILT_UP_GAP_M = 220;

const STOREY_M = 3;

/** Kind and eaves height (m) of a building from its tags. */
export function buildingShape(tags: OsmTags): { kind: BuildingKind; heightM: number } {
  const b = (tags.building ?? 'yes').toLowerCase();
  let kind: BuildingKind = 'other';
  let levels = 2;
  if (
    [
      'house',
      'detached',
      'semidetached_house',
      'terrace',
      'bungalow',
      'residential',
      'yes',
    ].includes(b)
  ) {
    kind = 'house';
    levels = b === 'bungalow' ? 1 : 2;
  } else if (['apartments', 'dormitory', 'hotel'].includes(b)) {
    kind = 'apartments';
    levels = 4;
  } else if (['church', 'chapel', 'cathedral'].includes(b)) {
    kind = 'church';
    levels = 4;
  } else if (['farm', 'farm_auxiliary', 'barn', 'cowshed', 'stable', 'sty'].includes(b)) {
    kind = 'farm';
    levels = 2;
  } else if (
    ['garage', 'garages', 'shed', 'hut', 'carport', 'cabin', 'roof', 'kiosk'].includes(b)
  ) {
    kind = 'shed';
    levels = 1;
  } else if (
    ['industrial', 'warehouse', 'retail', 'commercial', 'office', 'supermarket'].includes(b)
  ) {
    kind = 'industrial';
    levels = 3;
  }
  const height = parseMetres(tags.height);
  const lv = Number.parseFloat(tags['building:levels'] ?? '');
  let heightM: number;
  if (height !== null && height > 1 && height < 300) {
    // `height` includes the roof; the eaves sit roughly a storey lower on pitched roofs.
    heightM = kind === 'house' || kind === 'farm' ? Math.max(2.5, height * 0.7) : height;
  } else if (Number.isFinite(lv) && lv >= 1 && lv <= 80) {
    heightM = lv * STOREY_M;
  } else heightM = levels * STOREY_M;
  if (kind === 'shed') heightM = Math.min(heightM, 4);
  return { kind, heightM: Math.max(2.5, Math.min(250, heightM)) };
}

/** "12", "12 m", "12.5m" → 12.5; feet and other units are not guessed. */
export function parseMetres(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m|meters?|metres?)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** The land cover or water a polygon stands for, or null. */
export function areaKind(
  tags: OsmTags,
): { water: false; kind: GroundKind } | { water: true; kind: WaterKind } | null {
  const lu = tags.landuse;
  const nat = tags.natural;
  const ww = tags.waterway;
  if (nat === 'water' || ww === 'riverbank') {
    const river = ww === 'riverbank' || ['river', 'canal', 'stream'].includes(tags.water ?? '');
    return { water: true, kind: river ? 'river' : 'lake' };
  }
  if (lu === 'forest' || nat === 'wood') return { water: false, kind: 'forest' };
  if (lu === 'orchard' || lu === 'vineyard') return { water: false, kind: 'orchard' };
  if (lu === 'meadow' || nat === 'grassland' || nat === 'heath' || nat === 'scrub')
    return { water: false, kind: 'meadow' };
  if (lu === 'farmland') return { water: false, kind: 'farmland' };
  if (lu === 'grass' || lu === 'village_green' || lu === 'allotments')
    return { water: false, kind: 'grass' };
  if (lu === 'residential') return { water: false, kind: 'residential' };
  return null;
}

/** When two covers start equally near the road, the more telling one wins. */
const GROUND_PRIORITY: Record<GroundKind, number> = {
  forest: 6,
  orchard: 5,
  meadow: 4,
  farmland: 3,
  grass: 2,
  residential: 1,
};

/** A river or stream centre line: kind and drawn width (m). */
function lineWater(tags: OsmTags): { kind: WaterKind; widthM: number } | null {
  const ww = tags.waterway;
  if (ww !== 'river' && ww !== 'canal' && ww !== 'stream') return null;
  const width = parseMetres(tags.width);
  const def = ww === 'river' ? 14 : ww === 'canal' ? 10 : 3;
  const w = width !== null && width > 0.5 && width < 300 ? width : def;
  return { kind: ww === 'stream' ? 'stream' : 'river', widthM: w };
}

interface Pass {
  /** Route distance of the nearest point. */
  alongM: number;
  /** Signed distance, + right. */
  offsetM: number;
  /** Segment index the point projects onto. */
  seg: number;
}

interface Segments {
  xs: Float64Array;
  ys: Float64Array;
  edges: number;
}

/** Flattens rings or lines into one list of segments (x0 y0 x1 y1 …). */
function segmentsOf(proj: Projection, lines: readonly (readonly LatLon[])[]): Segments {
  let edges = 0;
  for (const l of lines) edges += Math.max(0, l.length - 1);
  const xs = new Float64Array(edges * 2);
  const ys = new Float64Array(edges * 2);
  let k = 0;
  for (const l of lines) {
    let prev: { x: number; y: number } | null = null;
    for (const p of l) {
      const q = project(proj, p.lat, p.lon);
      if (prev) {
        xs[k] = prev.x;
        ys[k] = prev.y;
        xs[k + 1] = q.x;
        ys[k + 1] = q.y;
        k += 2;
      }
      prev = q;
    }
  }
  return { xs, ys, edges };
}

export interface SceneryBuildOptions {
  corridorM?: number;
  maxBuildings?: number;
}

/** Accumulates elements chunk by chunk (duplicates across chunks are ignored), then builds. */
export class SceneryBuilder {
  readonly #track: RouteTrack;
  readonly #corridor: number;
  readonly #maxBuildings: number;
  readonly #proj: Projection;
  readonly #x: Float64Array;
  readonly #y: Float64Array;
  readonly #total: number;
  /** Segment grid: cell → segment indices. */
  readonly #grid = new Map<string, number[]>();
  readonly #cell = 100;
  /** Probes: sample index every PROBE_M, their point and right-hand normal. */
  readonly #probes: { i: number; x: number; y: number; nx: number; ny: number; at: number }[] = [];
  readonly #probeGrid = new Map<string, number[]>();
  readonly #probeCell = 200;
  /** Per probe and side (index 2p + (side>0)): nearest ground and water. */
  readonly #ground: { kind: GroundKind; near: number; far: number }[] = [];
  readonly #water: { kind: WaterKind; near: number; far: number }[] = [];
  readonly #seen = new Set<string>();
  readonly #buildings: SceneryBuilding[] = [];
  readonly #places: { name: string; kind: PlaceKind; x: number; y: number }[] = [];
  readonly #structureAlongs: { kind: StructureKind; along: number[] }[] = [];
  elements = 0;

  constructor(track: RouteTrack, options: SceneryBuildOptions = {}) {
    this.#track = track;
    this.#corridor = options.corridorM ?? SCENERY_CORRIDOR_M;
    this.#maxBuildings = options.maxBuildings ?? MAX_SCENERY_BUILDINGS;
    const { proj, x, y } = routeXY(track);
    this.#proj = proj;
    this.#x = x;
    this.#y = y;
    this.#total = (track.count - 1) * track.stepM;
    for (let i = 0; i < track.count - 1; i++) {
      const x0 = Math.min(x[i]!, x[i + 1]!);
      const x1 = Math.max(x[i]!, x[i + 1]!);
      const y0 = Math.min(y[i]!, y[i + 1]!);
      const y1 = Math.max(y[i]!, y[i + 1]!);
      for (let cx = Math.floor(x0 / this.#cell); cx <= Math.floor(x1 / this.#cell); cx++) {
        for (let cy = Math.floor(y0 / this.#cell); cy <= Math.floor(y1 / this.#cell); cy++) {
          const k = `${cx},${cy}`;
          let list = this.#grid.get(k);
          if (!list) this.#grid.set(k, (list = []));
          list.push(i);
        }
      }
    }
    const every = Math.max(1, Math.round(PROBE_M / track.stepM));
    for (let i = 0; i < track.count; i += every) {
      const a = Math.max(0, i - 1);
      const b = Math.min(track.count - 1, i + 1);
      let dx = x[b]! - x[a]!;
      let dy = y[b]! - y[a]!;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) {
        dx = 0;
        dy = 1;
      } else {
        dx /= len;
        dy /= len;
      }
      const p = this.#probes.length;
      this.#probes.push({ i, x: x[i]!, y: y[i]!, nx: dy, ny: -dx, at: i * track.stepM });
      const k = `${Math.floor(x[i]! / this.#probeCell)},${Math.floor(y[i]! / this.#probeCell)}`;
      let list = this.#probeGrid.get(k);
      if (!list) this.#probeGrid.set(k, (list = []));
      list.push(p);
    }
  }

  /**
   * Every pass of the route within `radius` of a point: the nearest place of each, one per
   * stretch of route (passes closer than 2 × radius along the route are one pass).
   */
  passes(px: number, py: number, radius: number, split = Infinity): Pass[] {
    const xs = this.#x;
    const ys = this.#y;
    const step = this.#track.stepM;
    const c = this.#cell;
    const hits: Pass[] = [];
    const seen = new Set<number>();
    for (let cx = Math.floor((px - radius) / c); cx <= Math.floor((px + radius) / c); cx++) {
      for (let cy = Math.floor((py - radius) / c); cy <= Math.floor((py + radius) / c); cy++) {
        for (const i of this.#grid.get(`${cx},${cy}`) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const ax = xs[i]!;
          const ay = ys[i]!;
          const ux = xs[i + 1]! - ax;
          const uy = ys[i + 1]! - ay;
          const len2 = ux * ux + uy * uy;
          const t =
            len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ux + (py - ay) * uy) / len2)) : 0;
          const qx = ax + ux * t;
          const qy = ay + uy * t;
          const dist = Math.hypot(px - qx, py - qy);
          if (dist > radius) continue;
          const cross = (px - ax) * uy - (py - ay) * ux;
          hits.push({ alongM: (i + t) * step, offsetM: cross >= 0 ? dist : -dist, seg: i });
        }
      }
    }
    if (hits.length === 0) return hits;
    hits.sort((a, b) => a.alongM - b.alongM);
    // Passes: runs of hits without a gap along the route; within a run, a new pass starts
    // where the distance rose by more than `split` since the nearest point (and falls again).
    const passes: Pass[] = [];
    const gap = 2 * Math.min(radius, split);
    let best = hits[0]!;
    let rising = false;
    let peak = 0;
    let last = best.alongM;
    for (let k = 1; k < hits.length; k++) {
      const h = hits[k]!;
      const d = Math.abs(h.offsetM);
      if (h.alongM - last > gap) {
        if (!rising) passes.push(best);
        best = h;
        rising = false;
      } else if (!rising) {
        if (d < Math.abs(best.offsetM)) best = h;
        else if (d > Math.abs(best.offsetM) + split) {
          passes.push(best);
          rising = true;
          peak = d;
        }
      } else {
        peak = Math.max(peak, d);
        if (d < peak - split) {
          best = h;
          rising = false;
        }
      }
      last = h.alongM;
    }
    if (!rising) passes.push(best);
    // A loop's start and end are one place: the same pass when both lie at the seam.
    if (this.#track.loop && passes.length > 1) {
      const first = passes[0]!;
      const lastP = passes[passes.length - 1]!;
      const seam = first.alongM + (this.#total - lastP.alongM);
      if (seam < 2 * Math.min(radius, split)) {
        if (Math.abs(lastP.offsetM) < Math.abs(first.offsetM)) passes.shift();
        else passes.pop();
      }
    }
    return passes;
  }

  /** Adds the elements of one answer. */
  add(elements: readonly OsmElement[]): void {
    for (const e of elements) {
      const key = `${e.type}/${e.id}`;
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      this.elements++;
      try {
        this.#addOne(e);
      } catch {
        // a malformed element is skipped
      }
    }
  }

  #addOne(e: OsmElement): void {
    const t = e.tags;
    if (e.type === 'node') {
      const kind = t.place as PlaceKind | undefined;
      const name = cleanText(t.name ?? '', MAX_PLACE_NAME);
      if (!kind || !(kind in PLACE_RADIUS_M) || !name) return;
      const p = project(this.#proj, e.lat, e.lon);
      this.#places.push({ name, kind, x: p.x, y: p.y });
      return;
    }
    if (e.type === 'way' && t.highway && (t.bridge || t.tunnel)) {
      this.#addStructure(e.geometry, t.tunnel && t.tunnel !== 'no' ? 'tunnel' : 'bridge');
      return;
    }
    if (e.type === 'way' && t.building && t.building !== 'no') {
      this.#addBuilding(e.geometry, t);
      return;
    }
    const line = e.type === 'way' ? lineWater(t) : null;
    if (line && e.type === 'way') {
      const segs = segmentsOf(this.#proj, [e.geometry]);
      this.#probeLine(segs, line.kind, line.widthM);
      return;
    }
    const area = areaKind(t);
    if (!area) return;
    const rings =
      e.type === 'way'
        ? [e.geometry]
        : e.type === 'relation'
          ? e.members
              .filter((m) => m.role === 'outer' || m.role === 'inner' || m.role === '')
              .map((m) => m.geometry)
          : [];
    if (rings.length === 0) return;
    // A way must be closed to be an area.
    if (e.type === 'way') {
      const g = e.geometry;
      const a = g[0]!;
      const b = g[g.length - 1]!;
      if (g.length < 4 || a.lat !== b.lat || a.lon !== b.lon) return;
    }
    this.#probeArea(segmentsOf(this.#proj, rings), area);
  }

  #addBuilding(geometry: readonly LatLon[], tags: OsmTags): void {
    if (this.#buildings.length >= this.#maxBuildings * 3) return; // runaway input
    const pts = geometry.map((p) => project(this.#proj, p.lat, p.lon));
    const ring =
      pts.length > 1 && pts[0]!.x === pts[pts.length - 1]!.x && pts[0]!.y === pts[pts.length - 1]!.y
        ? pts.slice(0, -1)
        : pts;
    if (ring.length < 3) return;
    let cx = 0;
    let cy = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of ring) {
      cx += p.x;
      cy += p.y;
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    cx /= ring.length;
    cy /= ring.length;
    if (x1 - x0 > MAX_FOOTPRINT_M || y1 - y0 > MAX_FOOTPRINT_M) return;
    const reach = Math.hypot(x1 - x0, y1 - y0) / 2;
    const shape = buildingShape(tags);
    const xs = this.#x;
    const ys = this.#y;
    for (const pass of this.passes(cx, cy, this.#corridor + reach)) {
      const i = pass.seg;
      const ux0 = xs[i + 1]! - xs[i]!;
      const uy0 = ys[i + 1]! - ys[i]!;
      const ul = Math.hypot(ux0, uy0) || 1;
      const ux = ux0 / ul;
      const uy = uy0 / ul;
      let a0 = Infinity;
      let a1 = -Infinity;
      let l0 = Infinity;
      let l1 = -Infinity;
      for (const p of ring) {
        const vx = p.x - cx;
        const vy = p.y - cy;
        const a = vx * ux + vy * uy;
        const l = vx * uy - vy * ux;
        a0 = Math.min(a0, a);
        a1 = Math.max(a1, a);
        l0 = Math.min(l0, l);
        l1 = Math.max(l1, l);
      }
      const lengthM = Math.max(2, a1 - a0);
      const depthM = Math.max(2, l1 - l0);
      let offsetM = pass.offsetM + (l0 + l1) / 2;
      // Keep the road clear: a house mapped onto the road edge moves back onto the verge.
      const side = offsetM >= 0 ? 1 : -1;
      const inner = Math.abs(offsetM) - depthM / 2;
      if (inner < BUILDING_MIN_OFFSET_M) offsetM = side * (BUILDING_MIN_OFFSET_M + depthM / 2);
      if (Math.abs(offsetM) - depthM / 2 > this.#corridor) continue;
      let alongM = pass.alongM + (a0 + a1) / 2;
      if (this.#track.loop && this.#total > 0) {
        alongM = ((alongM % this.#total) + this.#total) % this.#total;
      } else if (alongM < -this.#corridor || alongM > this.#total + this.#corridor) continue;
      this.#buildings.push({
        alongM,
        offsetM,
        lengthM,
        depthM,
        heightM: shape.heightM,
        kind: shape.kind,
      });
    }
  }

  #addStructure(geometry: readonly LatLon[], kind: StructureKind): void {
    const along: number[] = [];
    for (const p of geometry) {
      const q = project(this.#proj, p.lat, p.lon);
      for (const pass of this.passes(q.x, q.y, 8)) along.push(pass.alongM);
    }
    if (along.length >= 2) this.#structureAlongs.push({ kind, along });
  }

  /** Probes near a box: indices into #probes. */
  #probesNear(x0: number, y0: number, x1: number, y1: number): number[] {
    const r = this.#corridor;
    const c = this.#probeCell;
    const out: number[] = [];
    for (let cx = Math.floor((x0 - r) / c); cx <= Math.floor((x1 + r) / c); cx++) {
      for (let cy = Math.floor((y0 - r) / c); cy <= Math.floor((y1 + r) / c); cy++) {
        for (const p of this.#probeGrid.get(`${cx},${cy}`) ?? []) out.push(p);
      }
    }
    return out;
  }

  #bounds(s: Segments): [number, number, number, number] {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < s.xs.length; k++) {
      x0 = Math.min(x0, s.xs[k]!);
      x1 = Math.max(x1, s.xs[k]!);
      y0 = Math.min(y0, s.ys[k]!);
      y1 = Math.max(y1, s.ys[k]!);
    }
    return [x0, y0, x1, y1];
  }

  /** Where the probe line (P + t·n) crosses the segments: sorted t values. */
  #crossings(s: Segments, px: number, py: number, nx: number, ny: number, limit: number): number[] {
    const ts: number[] = [];
    for (let e = 0; e < s.edges; e++) {
      const ax = s.xs[2 * e]!;
      const ay = s.ys[2 * e]!;
      const bx = s.xs[2 * e + 1]!;
      const by = s.ys[2 * e + 1]!;
      const ex = bx - ax;
      const ey = by - ay;
      const denom = nx * ey - ny * ex;
      if (Math.abs(denom) < 1e-12) continue;
      const qx = ax - px;
      const qy = ay - py;
      const t = (qx * ey - qy * ex) / denom;
      const u = (qx * ny - qy * nx) / denom;
      // Half-open on the segment so a shared vertex counts once.
      if (u < 0 || u >= 1) continue;
      if (Math.abs(t) > limit) {
        // Far crossings still matter for the even-odd rule: keep them clamped.
        ts.push(t > 0 ? limit + 1 : -limit - 1);
      } else ts.push(t);
    }
    return ts.sort((a, b) => a - b);
  }

  #record(p: number, t0: number, t1: number, water: boolean, kind: GroundKind | WaterKind): void {
    const C = this.#corridor;
    for (const side of [1, -1] as const) {
      const lo = side > 0 ? Math.max(0, t0) : Math.max(0, -t1);
      const hi = side > 0 ? Math.min(C, t1) : Math.min(C, -t0);
      if (hi - lo < 1) continue;
      const idx = 2 * p + (side > 0 ? 1 : 0);
      if (water) {
        const cur = this.#water[idx];
        if (!cur || lo < cur.near)
          this.#water[idx] = { kind: kind as WaterKind, near: lo, far: hi };
      } else {
        const cur = this.#ground[idx];
        const k = kind as GroundKind;
        if (
          !cur ||
          lo < cur.near - 2 ||
          (Math.abs(lo - cur.near) <= 2 && GROUND_PRIORITY[k] > GROUND_PRIORITY[cur.kind])
        )
          this.#ground[idx] = { kind: k, near: lo, far: hi };
      }
    }
  }

  #probeArea(
    s: Segments,
    area: { water: false; kind: GroundKind } | { water: true; kind: WaterKind },
  ): void {
    if (s.edges < 3) return;
    const [x0, y0, x1, y1] = this.#bounds(s);
    const C = this.#corridor;
    for (const p of this.#probesNear(x0, y0, x1, y1)) {
      const pr = this.#probes[p]!;
      if (pr.x < x0 - C || pr.x > x1 + C || pr.y < y0 - C || pr.y > y1 + C) continue;
      const ts = this.#crossings(s, pr.x, pr.y, pr.nx, pr.ny, C);
      for (let k = 0; k + 1 < ts.length; k += 2) {
        const a = ts[k]!;
        const b = ts[k + 1]!;
        if (b < -C || a > C) continue;
        this.#record(p, a, b, area.water, area.kind);
      }
    }
  }

  #probeLine(s: Segments, kind: WaterKind, widthM: number): void {
    if (s.edges < 1) return;
    const [x0, y0, x1, y1] = this.#bounds(s);
    const C = this.#corridor;
    for (const p of this.#probesNear(x0, y0, x1, y1)) {
      const pr = this.#probes[p]!;
      for (const t of this.#crossings(s, pr.x, pr.y, pr.nx, pr.ny, C + widthM)) {
        if (Math.abs(t) > C + widthM / 2) continue;
        // A stream right under the road (a culvert) is not drawn as running alongside.
        if (Math.abs(t) < widthM / 2 + 3) continue;
        this.#record(p, t - widthM / 2, t + widthM / 2, true, kind);
      }
    }
  }

  #stretches<K extends string>(
    cells: readonly ({ kind: K; near: number; far: number } | undefined)[],
  ): SceneryStretch<K>[] {
    const out: SceneryStretch<K>[] = [];
    const half = PROBE_M / 2;
    const total = this.#total;
    for (const side of [-1, 1] as const) {
      let cur: SceneryStretch<K> | null = null;
      let count = 0;
      const close = (): void => {
        if (cur && count >= 2 && cur.toM - cur.fromM >= 30) out.push(cur);
        cur = null;
        count = 0;
      };
      for (let p = 0; p < this.#probes.length; p++) {
        const c = cells[2 * p + (side > 0 ? 1 : 0)];
        const at = this.#probes[p]!.at;
        if (!c) {
          close();
          continue;
        }
        const from = Math.max(0, at - half);
        const to = Math.min(total, at + half);
        const s = cur as SceneryStretch<K> | null;
        if (
          s &&
          s.kind === c.kind &&
          Math.abs(c.near - s.nearM) <= 12 &&
          Math.abs(c.far - s.farM) <= 30 &&
          to - s.fromM <= MAX_STRETCH_M
        ) {
          s.toM = to;
          s.nearM = Math.min(s.nearM, c.near);
          s.farM = Math.max(s.farM, c.far);
          count++;
        } else {
          close();
          cur = {
            kind: c.kind,
            side,
            fromM: from,
            toM: to,
            nearM: c.near,
            farM: Math.max(c.near + 1, c.far),
          };
          count = 1;
        }
      }
      close();
    }
    return out
      .map((s) => ({
        ...s,
        fromM: Math.round(s.fromM),
        toM: Math.round(s.toM),
        nearM: Math.round(s.nearM),
        farM: Math.max(Math.round(s.nearM) + 1, Math.round(s.farM)),
      }))
      .filter((s) => s.toM > s.fromM)
      .sort((a, b) => a.fromM - b.fromM);
  }

  #signs(buildings: readonly SceneryBuilding[]): SceneryPlace[] {
    const out: SceneryPlace[] = [];
    const alongs = buildings.map((b) => b.alongM).sort((a, b) => a - b);
    const total = this.#total;
    for (const pl of this.#places) {
      for (const pass of this.passes(pl.x, pl.y, PLACE_RADIUS_M[pl.kind], 250)) {
        // Walk back from the nearest point while buildings follow each other closely.
        let entry = pass.alongM;
        let i = upper(alongs, pass.alongM + BUILT_UP_GAP_M) - 1;
        if (i >= 0 && pass.alongM - alongs[i]! < 600) {
          entry = Math.min(entry, alongs[i]!);
          for (; i > 0; i--) {
            if (alongs[i]! - alongs[i - 1]! > BUILT_UP_GAP_M) break;
            entry = alongs[i - 1]!;
          }
          entry -= 30;
        } else entry -= 120;
        if (!this.#track.loop) entry = Math.max(0, Math.min(total, entry));
        else entry = ((entry % total) + total) % total;
        if (out.some((o) => o.name === pl.name && Math.abs(o.alongM - entry) < 500)) continue;
        out.push({ name: pl.name, kind: pl.kind, alongM: Math.round(entry) });
      }
    }
    return out.sort((a, b) => a.alongM - b.alongM).slice(0, MAX_SCENERY_PLACES);
  }

  #structures(): SceneryStructure[] {
    const out: SceneryStructure[] = [];
    for (const s of this.#structureAlongs) {
      const a = [...s.along].sort((x, y) => x - y);
      let from = a[0]!;
      let prev = a[0]!;
      const flush = (to: number): void => {
        if (to - from >= 8)
          out.push({ kind: s.kind, fromM: Math.round(from), toM: Math.round(to) });
      };
      for (let k = 1; k < a.length; k++) {
        if (a[k]! - prev > 40) {
          flush(prev);
          from = a[k]!;
        }
        prev = a[k]!;
      }
      flush(prev);
    }
    return out
      .filter((s) => s.toM > s.fromM)
      .sort((a, b) => a.fromM - b.fromM)
      .slice(0, MAX_SCENERY_STRUCTURES);
  }

  /** The model, bounded in counts and size, and its encoding. */
  finish(fetchedAt: number): { model: SceneryModel; text: string } {
    let truncated = false;
    let buildings = this.#buildings;
    if (buildings.length > this.#maxBuildings) {
      truncated = true;
      buildings = [...buildings]
        .sort((a, b) => Math.abs(a.offsetM) - Math.abs(b.offsetM))
        .slice(0, this.#maxBuildings);
    }
    buildings = [...buildings].sort((a, b) => a.alongM - b.alongM);
    let ground = this.#stretches(this.#ground);
    let water = this.#stretches(this.#water);
    if (ground.length + water.length > MAX_SCENERY_STRETCHES) {
      truncated = true;
      const keep = (l: SceneryStretch<string>[], n: number) =>
        [...l]
          .sort((a, b) => b.toM - b.fromM - (a.toM - a.fromM))
          .slice(0, n)
          .sort((a, b) => a.fromM - b.fromM);
      water = keep(water, Math.min(water.length, MAX_SCENERY_STRETCHES / 4)) as typeof water;
      ground = keep(ground, MAX_SCENERY_STRETCHES - water.length) as typeof ground;
    }
    const model: SceneryModel = {
      routeId: this.#track.id,
      totalDistanceM: this.#total,
      loop: this.#track.loop,
      fetchedAt,
      corridorM: this.#corridor,
      attribution: OSM_ATTRIBUTION,
      buildings,
      ground,
      water,
      places: this.#signs(buildings),
      structures: this.#structures(),
      truncated,
    };
    return boundScenery(model);
  }
}

function upper(sorted: readonly number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One-shot: builds the model from all elements at once. */
export function buildScenery(
  track: RouteTrack,
  elements: readonly OsmElement[],
  fetchedAt = 0,
  options: SceneryBuildOptions = {},
): { model: SceneryModel; text: string } {
  const b = new SceneryBuilder(track, options);
  b.add(elements);
  return b.finish(fetchedAt);
}
