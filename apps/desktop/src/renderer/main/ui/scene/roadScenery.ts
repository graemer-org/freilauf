/**
 * Which scenery features of the route-relative model (packages/routes/src/scenery.ts) the
 * road view draws this frame, and in how much detail. Pure apart from the projection of
 * roadMath.ts, so culling and level of detail are unit-tested without a canvas; the canvas
 * layer (roadRender.ts) only paints what this hands it.
 *
 * Budget: at most SCENERY_LIMITS.maxBuildings boxes per frame (the nearest win), detail
 * dropping with distance (windows near, plain faces further, a single silhouette far out),
 * nothing smaller than a pixel or off screen.
 */
import {
  forEachBuildingIn,
  forEachStretchIn,
  type GroundKind,
  type SceneryBuilding,
  type SceneryModel,
  type SceneryStretch,
  type WaterKind,
} from '@freilauf/routes';
import {
  type Camera,
  createScreenPoint,
  fogLevel,
  ROAD,
  type RoadStrip,
  type ScreenPoint,
  type Viewport,
} from './roadMath';

export interface SceneryLimits {
  maxBuildings: number;
  windowsM: number;
  silhouetteM: number;
  minPx: number;
  treeStepM: readonly [number, number, number];
}

export const SCENERY_LIMITS: SceneryLimits = {
  /** Buildings drawn per frame at most. */
  maxBuildings: 700,
  /** Nearer than this (m of depth): windows. */
  windowsM: 80,
  /** Farther than this: one silhouette per building. */
  silhouetteM: 240,
  /** Smaller than this on screen (px tall): not drawn. */
  minPx: 1.5,
  /** Forest trees: one per this many metres along the road, near / mid / far. */
  treeStepM: [5, 9, 18],
};

export type Lod = 0 | 1 | 2;

export interface PlacedBuilding {
  b: SceneryBuilding;
  /** Unwrapped route distances of the near and far wall (clipped to what is ahead). */
  a0: number;
  a1: number;
  /** Lateral position of the wall facing the road and of the far wall (m, + right). */
  li: number;
  lo: number;
  side: 1 | -1;
  /** Depth of the near corner facing the road (m); fog level and detail follow it. */
  depth: number;
  level: number;
  lod: Lod;
  /** Road segment of that corner (for crest clipping). */
  k: number;
}

export interface VisibleStretch<K extends string> {
  s: SceneryStretch<K>;
  /** Unwrapped from / to. */
  from: number;
  to: number;
}

/** What the road view draws of the scenery this frame (reused between frames). */
export class SceneryFrame {
  readonly buildings: PlacedBuilding[] = [];
  readonly ground: VisibleStretch<GroundKind>[] = [];
  readonly water: VisibleStretch<WaterKind>[] = [];
  /** Buildings before the budget cut (for tests and the data-buildings hook). */
  candidates = 0;
  /**
   * Per 10 m of road ahead and side (index 2 × slot + (side > 0)): 1 where a building
   * stands near the road, so the generic roadside trees keep clear of houses.
   */
  occupied = new Uint8Array(0);
  fromM = 0;
  readonly #pool: PlacedBuilding[] = [];
  readonly #sp: ScreenPoint = createScreenPoint();
  readonly #sq: ScreenPoint = createScreenPoint();

  /** Land cover kind at a route distance and side (unwrapped), or null. */
  coverAt(s: number, side: 1 | -1): GroundKind | WaterKind | null {
    for (const w of this.water) {
      if (w.s.side === side && s >= w.from && s <= w.to && w.s.nearM < 25) return w.s.kind;
    }
    let best: VisibleStretch<GroundKind> | null = null;
    for (const g of this.ground) {
      if (g.s.side !== side || s < g.from || s > g.to) continue;
      if (!best || g.s.nearM < best.s.nearM) best = g;
    }
    return best ? best.s.kind : null;
  }

  occupiedAt(s: number, side: 1 | -1): boolean {
    const slot = Math.floor((s - this.fromM) / 10);
    if (slot < 0 || 2 * slot + 1 >= this.occupied.length) return false;
    return this.occupied[2 * slot + (side > 0 ? 1 : 0)] === 1;
  }

  clear(): void {
    this.buildings.length = 0;
    this.ground.length = 0;
    this.water.length = 0;
    this.candidates = 0;
    this.occupied.fill(0);
  }

  /** Culls and grades the model for the strip as built for this frame. */
  update(
    model: SceneryModel,
    strip: RoadStrip,
    vp: Viewport,
    cam: Camera,
    fogLevels: number,
    limits: SceneryLimits = SCENERY_LIMITS,
  ): void {
    this.clear();
    if (strip.count < 2) return;
    const d = cam.distanceM;
    const sMin = d + 1;
    const sMax = strip.s[strip.count - 1]!;
    this.fromM = d;
    const slots = Math.ceil((sMax - d) / 10) + 2;
    if (this.occupied.length < 2 * slots) this.occupied = new Uint8Array(2 * slots);
    forEachStretchIn(model.ground, model, d - 5, sMax, (s, shift) => {
      this.ground.push({ s, from: s.fromM + shift, to: s.toM + shift });
    });
    forEachStretchIn(model.water, model, d - 5, sMax, (s, shift) => {
      this.water.push({ s, from: s.fromM + shift, to: s.toM + shift });
    });
    const sp = this.#sp;
    const sq = this.#sq;
    const margin = vp.width * 0.1;
    let used = 0;
    forEachBuildingIn(model, sMin - 150, sMax + 150, (b, shift) => {
      const a = b.alongM + shift;
      const a0 = Math.max(sMin, a - b.lengthM / 2);
      const a1 = Math.min(sMax, a + b.lengthM / 2);
      if (a1 <= a0 + 0.2) return;
      const side: 1 | -1 = b.offsetM >= 0 ? 1 : -1;
      const li = b.offsetM - (side * b.depthM) / 2;
      const lo = b.offsetM + (side * b.depthM) / 2;
      const k = strip.pointAt(vp, cam, a0, li, 0, sp);
      if (k === 0) return;
      const depth = sp.depth;
      const ppm = vp.focalPx / depth;
      if (b.heightM * ppm < limits.minPx) return;
      // Off screen: the near wall and the side facing the road all beyond one edge.
      const x0 = sp.x;
      strip.pointAt(vp, cam, a0, lo, 0, sq);
      const x1 = sq.x;
      strip.pointAt(vp, cam, a1, li, 0, sq);
      const x2 = sq.x;
      if (
        (x0 < -margin && x1 < -margin && x2 < -margin) ||
        (x0 > vp.width + margin && x1 > vp.width + margin && x2 > vp.width + margin)
      )
        return;
      this.candidates++;
      if (Math.abs(li) < 25) {
        for (let s = Math.floor((a0 - d) / 10); s <= Math.floor((a1 - d) / 10); s++) {
          if (s >= 0 && 2 * s + 1 < this.occupied.length)
            this.occupied[2 * s + (side > 0 ? 1 : 0)] = 1;
        }
      }
      let p = this.#pool[used];
      if (!p) {
        p = { b, a0, a1, li, lo, side, depth, level: 0, lod: 0, k };
        this.#pool.push(p);
      }
      used++;
      p.b = b;
      p.a0 = a0;
      p.a1 = a1;
      p.li = li;
      p.lo = lo;
      p.side = side;
      p.depth = depth;
      p.k = k;
      p.level = fogLevel(depth, fogLevels);
      p.lod = depth < limits.windowsM ? 0 : depth < limits.silhouetteM ? 1 : 2;
      this.buildings.push(p);
    });
    if (this.buildings.length > limits.maxBuildings) {
      this.buildings.sort((x, y) => x.depth - y.depth);
      this.buildings.length = limits.maxBuildings;
    }
    // Painter's order: far to near.
    this.buildings.sort((x, y) => y.depth - x.depth);
  }
}

/** The lateral band a stretch covers beside the road (never over the asphalt and verge). */
export function stretchBand(s: SceneryStretch<string>): [number, number] {
  const edge = ROAD.halfWidthM + ROAD.vergeM;
  const near = Math.max(edge, s.nearM);
  const far = Math.max(near + 0.5, s.farM);
  return s.side > 0 ? [near, far] : [-far, -near];
}

/** Pitched roof (ridge along the road) or flat, and its height above the eaves (m). */
export function roofOf(b: SceneryBuilding): number {
  switch (b.kind) {
    case 'house':
    case 'farm':
    case 'other':
      return Math.min(b.depthM * 0.42, 5.5);
    case 'church':
      return Math.min(b.depthM * 0.6, 9);
    default:
      return 0;
  }
}
