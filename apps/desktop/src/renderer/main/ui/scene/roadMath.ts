/**
 * Pure maths of the perspective ride scene: the road ahead of the rider is
 * sampled from the route, laid out in a camera-aligned frame (lateral offset
 * from heading change → curves; height from elevation change → hills) and
 * projected through a simple pinhole camera a few metres behind and above
 * the rider. No DOM — unit-tested in node; the canvas layer (roadRender.ts)
 * only fills the quads computed here.
 *
 * Frame: X to the right, Y up, Z forward (into the screen), metres. The
 * rider stands at Z = 0 on the road centre line's reference; the camera sits
 * CAMERA.backM behind and CAMERA.heightM above.
 *
 * Depth follows the road: each metre of route adds max(cos Δ, MIN_FORWARD)
 * metres of depth and sin Δ of lateral offset, where Δ is the road's heading
 * relative to the camera. Depth therefore always grows along the road, so
 * segments can be painted far to near and clipped against hill crests near
 * to far, even through hairpins (which read as the road folding back across
 * the view, farther away).
 *
 * Everything is derived from the route distance and the rider's lateral
 * position only — never from frame timing — and segment boundaries sit on
 * a fixed grid of absolute route distance, so nothing swims or flickers as
 * the rider moves.
 */
import type { RouteTrack } from '@freilauf/routes';
import { createTrackPoint, meanOver, sampleTrack, type TrackPoint } from './routeSample';

/** Road dimensions in metres. */
export const ROAD = {
  /** Half the asphalt width (a quiet two-lane country road). */
  halfWidthM: 3.1,
  /** Grass/gravel verge beyond the asphalt. */
  vergeM: 1.4,
  /** Edge lines: inset from the asphalt edge, and their width. */
  edgeInsetM: 0.25,
  edgeWidthM: 0.12,
  /** Centre dashes: on / period along the road, and their width. */
  dashM: 3,
  dashPeriodM: 9,
  dashWidthM: 0.12,
  /** Where the rider rides at lateral 0 (centre of the right-hand lane), and the reach either way. */
  riderBaseM: 1.35,
  riderReachM: 1.2,
} as const;

/** Camera placement and lens. */
export const CAMERA = {
  /** Behind the rider, along the road. */
  backM: 4.6,
  /** Above the road at the rider. */
  heightM: 2.05,
  /** Nearest depth projected (anything nearer is clamped). */
  nearM: 0.6,
  /** Hills are drawn this much steeper than they are, so 5 % reads as a hill. */
  elevationExaggeration: 1.8,
  /** Share of the rider's lateral offset the camera follows. */
  followLateral: 0.45,
  /**
   * Share of the road's (exaggerated) slope the camera pitches with: a
   * little, so a long climb does not fill the view, but not much, or the
   * road ahead would look flat (it is the rise over the horizon that reads
   * as a hill).
   */
  pitchFollow: 0.15,
  /** Window the camera heading is averaged over, metres behind / ahead of the rider. */
  yawBehindM: 6,
  yawAheadM: 22,
} as const;

/** Depth gained per metre of road when the road runs sideways or back. */
export const MIN_FORWARD = 0.3;

/** Sampling: [up to this many metres ahead, step] — coarser further out. */
export const ROAD_STEPS: readonly (readonly [number, number])[] = [
  [100, 4],
  [260, 10],
  [520, 20],
];
export const ROAD_BEHIND_M = 3.6;
export const ROAD_FAR_M = 520;

/**
 * Relative heading as laid out: beyond ±90° the road keeps running sideways
 * (and away), so a hairpin reads as the road sweeping off to that side
 * rather than doubling back over itself.
 */
export function laidOut(rel: number): number {
  const lim = Math.PI / 2;
  return rel > lim ? lim : rel < -lim ? -lim : rel;
}

/** Capacity of a strip (boundaries); enough for ROAD_STEPS plus slack. */
const CAPACITY = 128;

export interface Viewport {
  width: number;
  height: number;
  /** Focal length in pixels. */
  focalPx: number;
  /** Optical centre. */
  cx: number;
  /** Screen y of the horizon with the camera level. */
  horizonY: number;
  /** Screen y where the rider's wheel touches the road. */
  riderY: number;
}

/** Lens and horizon for a canvas size: the road fills the bottom, sky the top ~40 %. */
export function viewportFor(width: number, height: number): Viewport {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return {
    width: w,
    height: h,
    focalPx: Math.min(h * 1.25, w * 0.78),
    cx: w / 2,
    horizonY: h * 0.4,
    riderY: h * 0.95,
  };
}

export interface Camera {
  /** Route distance of the rider. */
  distanceM: number;
  /** Heading the camera looks along, radians (unwrapped, like the track). */
  yaw: number;
  /** Upward tilt, radians. */
  pitch: number;
  /** Lateral camera offset from the road reference, metres. */
  x: number;
  /** Rider's elevation, metres. */
  elevationM: number;
  /**
   * Vertical shift of the image, pixels (see anchorCamera): keeps the rider
   * standing at the same height on screen whatever the camera's pitch.
   */
  offsetY: number;
}

const camScratch = createTrackPoint();
const anchorScratch: ScreenPoint = { x: 0, y: 0, depth: 1 };

/**
 * Camera for a rider at `distanceM`, `lateralM` metres right of the road
 * reference. Heading and pitch are means over a window of road, so the
 * camera turns into a bend smoothly and before the rider does, without any
 * time-based easing (identical frames for identical inputs).
 */
export function cameraFor(track: RouteTrack, distanceM: number, lateralM: number): Camera {
  const d = distanceM;
  const yaw = meanOver(track, d - CAMERA.yawBehindM, d + CAMERA.yawAheadM, 8, (p) => p.headingRad);
  const e0 = sampleTrack(track, d - 10, camScratch).elevationM;
  const e1 = sampleTrack(track, d + 30, camScratch).elevationM;
  const slope = ((e1 - e0) / 40) * CAMERA.elevationExaggeration;
  return {
    distanceM: d,
    yaw,
    pitch: Math.atan(slope) * CAMERA.pitchFollow,
    x: lateralM * CAMERA.followLateral,
    elevationM: sampleTrack(track, d, camScratch).elevationM,
    offsetY: 0,
  };
}

/**
 * Shifts the image so the rider's wheel touches the road at `vp.riderY`:
 * pitching the camera then moves the horizon and the road ahead, never the
 * rider (who would otherwise sink out of the frame on a climb).
 */
export function anchorCamera(vp: Viewport, cam: Camera, riderXM: number): void {
  cam.offsetY = 0;
  const p = project(vp, cam, riderXM, 0, 0, anchorScratch);
  cam.offsetY = vp.riderY - p.y;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** Depth from the camera (≥ nearM); pixels per metre there = focalPx / depth. */
  depth: number;
}

export function createScreenPoint(): ScreenPoint {
  return { x: 0, y: 0, depth: 1 };
}

/**
 * Projects a point in the rider frame (X right, Y up relative to the rider's
 * road height — already exaggerated —, Z ahead of the rider) to the screen.
 */
export function project(
  vp: Viewport,
  cam: Camera,
  X: number,
  Y: number,
  Z: number,
  out: ScreenPoint,
): ScreenPoint {
  const x = X - cam.x;
  const y = Y - CAMERA.heightM;
  const z = Z + CAMERA.backM;
  const c = Math.cos(cam.pitch);
  const s = Math.sin(cam.pitch);
  const zc = Math.max(CAMERA.nearM, z * c + y * s);
  const yc = y * c - z * s;
  out.depth = zc;
  out.x = vp.cx + (vp.focalPx * x) / zc;
  out.y = vp.horizonY + cam.offsetY - (vp.focalPx * yc) / zc;
  return out;
}

/** Screen y of the true horizon (a level point infinitely far away). */
export const horizonLine = (vp: Viewport, cam: Camera): number =>
  vp.horizonY + cam.offsetY + vp.focalPx * Math.tan(cam.pitch);

/**
 * The road ahead, as boundaries along the route (index 0 nearest). For each
 * boundary: route distance, the road-centre position in the rider frame,
 * the road's normal there, and screen data. Segment k joins boundary k−1 to
 * k. Preallocated; `build` refills it without allocating.
 */
export class RoadStrip {
  count = 0;
  /** Route distance (unwrapped, may exceed the route length). */
  readonly s = new Float64Array(CAPACITY);
  /** Road centre in the rider frame. */
  readonly X = new Float64Array(CAPACITY);
  readonly Y = new Float64Array(CAPACITY);
  readonly Z = new Float64Array(CAPACITY);
  /** Unit normal pointing to the road's right, in the X/Z plane. */
  readonly nx = new Float64Array(CAPACITY);
  readonly nz = new Float64Array(CAPACITY);
  /** Heading relative to the camera, radians. */
  readonly rel = new Float64Array(CAPACITY);
  /** Screen y of the road centre. */
  readonly sy = new Float64Array(CAPACITY);
  /**
   * Hill occlusion: the highest (smallest) screen y the road reached
   * between the camera and boundary k (exclusive). The far part of a
   * segment below this line is hidden behind a crest.
   */
  readonly clip = new Float64Array(CAPACITY);
  /** 1 when segment k (k−1 → k) is at least partly visible. */
  readonly visible = new Uint8Array(CAPACITY);
  /**
   * 0…1: share of segment k (from its far end) that is visible; 1 = all of
   * it. Lets the renderer cut the quad at the crest line.
   */
  readonly visibleFrom = new Float64Array(CAPACITY);

  private readonly tp: TrackPoint = createTrackPoint();
  private readonly sp: ScreenPoint = createScreenPoint();

  /** Index of the boundary at or beyond route distance `s` (binary search). */
  indexAt(s: number): number {
    let lo = 0;
    let hi = this.count - 1;
    if (hi < 0) return 0;
    if (s <= this.s[0]!) return 0;
    if (s >= this.s[hi]!) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid]! < s) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  /**
   * Interpolated road point at route distance `s`, `lateralM` metres right
   * of the centre and `upM` above the road, projected. Returns the segment
   * index the point lies in (≥ 1), or 0 outside the strip.
   */
  pointAt(
    vp: Viewport,
    cam: Camera,
    s: number,
    lateralM: number,
    upM: number,
    out: ScreenPoint,
  ): number {
    if (this.count < 2) return 0;
    if (s < this.s[0]! - 1e-6 || s > this.s[this.count - 1]! + 1e-6) return 0;
    const k = Math.max(1, this.indexAt(s));
    const a = k - 1;
    const t = (s - this.s[a]!) / Math.max(1e-9, this.s[k]! - this.s[a]!);
    const X = this.X[a]! + (this.X[k]! - this.X[a]!) * t;
    const Y = this.Y[a]! + (this.Y[k]! - this.Y[a]!) * t;
    const Z = this.Z[a]! + (this.Z[k]! - this.Z[a]!) * t;
    const nx = this.nx[a]! + (this.nx[k]! - this.nx[a]!) * t;
    const nz = this.nz[a]! + (this.nz[k]! - this.nz[a]!) * t;
    project(vp, cam, X + nx * lateralM, Y + upM, Z + nz * lateralM, out);
    return k;
  }

  /** Projects boundary k offset `lateralM` along its normal. */
  edge(vp: Viewport, cam: Camera, k: number, lateralM: number, out: ScreenPoint): ScreenPoint {
    return project(
      vp,
      cam,
      this.X[k]! + this.nx[k]! * lateralM,
      this.Y[k]!,
      this.Z[k]! + this.nz[k]! * lateralM,
      out,
    );
  }

  /** True when a point at screen y in segment k is behind a crest. */
  hiddenAt(k: number, screenY: number): boolean {
    if (k <= 0 || k >= this.count) return false;
    return screenY > this.clip[k]! + 0.5;
  }

  /**
   * Lays out the road from ROAD_BEHIND_M behind the rider to ROAD_FAR_M
   * ahead and computes visibility. Boundaries: the rider's own distance
   * minus ROAD_BEHIND_M, then every grid point of ROAD_STEPS.
   */
  build(track: RouteTrack, vp: Viewport, cam: Camera): void {
    const d = cam.distanceM;
    const ex = CAMERA.elevationExaggeration;
    const tp = this.tp;
    const elev0 = cam.elevationM;

    // Boundary distances on the absolute grid.
    let n = 0;
    this.s[n++] = d - ROAD_BEHIND_M;
    const firstStep = ROAD_STEPS[0]![1];
    let s = Math.floor((d - ROAD_BEHIND_M) / firstStep + 1) * firstStep;
    for (const [until, step] of ROAD_STEPS) {
      s = Math.ceil(s / step - 1e-9) * step;
      while (s - d <= until && n < CAPACITY) {
        if (s > this.s[n - 1]! + 1e-6) this.s[n++] = s;
        s += step;
      }
    }
    this.count = n;

    // Integrate the road from the rider outwards (Z = 0 at the rider).
    // Behind the rider first (one boundary), then ahead.
    let riderIdx = 0;
    while (riderIdx < n - 1 && this.s[riderIdx + 1]! <= d) riderIdx++;
    // Value at the rider itself: X = 0, Z = 0.
    // Forward from the rider (midpoint heading of each piece).
    let X = 0;
    let Z = 0;
    let prev = d;
    for (let k = riderIdx + 1; k < n; k++) {
      const len = this.s[k]! - prev;
      const r = laidOut(sampleTrack(track, prev + len / 2, tp).headingRad - cam.yaw);
      X += Math.sin(r) * len;
      Z += Math.max(Math.cos(r), MIN_FORWARD) * len;
      this.X[k] = X;
      this.Z[k] = Z;
      prev = this.s[k]!;
    }
    // Backward from the rider.
    X = 0;
    Z = 0;
    prev = d;
    for (let k = riderIdx; k >= 0; k--) {
      const len = prev - this.s[k]!;
      const r = laidOut(sampleTrack(track, prev - len / 2, tp).headingRad - cam.yaw);
      X -= Math.sin(r) * len;
      Z -= Math.max(Math.cos(r), MIN_FORWARD) * len;
      this.X[k] = X;
      this.Z[k] = Z;
      prev = this.s[k]!;
    }

    // Height, normals, screen y.
    const sp = this.sp;
    for (let k = 0; k < n; k++) {
      const p = sampleTrack(track, this.s[k]!, tp);
      this.Y[k] = (p.elevationM - elev0) * ex;
      const r = laidOut(p.headingRad - cam.yaw);
      this.rel[k] = p.headingRad - cam.yaw;
      // Direction of the laid-out road (matches the integration above).
      const dx = Math.sin(r);
      const dz = Math.max(Math.cos(r), MIN_FORWARD);
      const len = Math.hypot(dx, dz) || 1;
      this.nx[k] = dz / len;
      this.nz[k] = -dx / len;
      project(vp, cam, this.X[k]!, this.Y[k]!, this.Z[k]!, sp);
      this.sy[k] = sp.y;
    }

    // Hill occlusion, near to far: a segment is visible where it rises
    // above everything nearer.
    let clip = Number.POSITIVE_INFINITY;
    this.clip[0] = clip;
    this.visible[0] = 0;
    this.visibleFrom[0] = 0;
    for (let k = 1; k < n; k++) {
      this.clip[k] = clip;
      const yNear = this.sy[k - 1]!;
      const yFar = this.sy[k]!;
      if (yFar < clip - 0.01) {
        this.visible[k] = 1;
        // Part of the segment between its far end and where it dips below the clip line.
        this.visibleFrom[k] =
          yNear <= clip ? 1 : Math.max(0, Math.min(1, (clip - yFar) / (yNear - yFar)));
        clip = yFar;
      } else {
        this.visible[k] = 0;
        this.visibleFrom[k] = 0;
      }
    }
  }
}

/**
 * Fog: 0 near the rider, 1 at ROAD_FAR_M, quantised to `levels` steps so
 * the renderer can batch each level into one fill.
 */
export function fogLevel(depthM: number, levels: number): number {
  const t = Math.max(0, Math.min(1, (depthM - 30) / (ROAD_FAR_M - 30)));
  return Math.min(levels - 1, Math.floor(Math.pow(t, 0.75) * levels));
}

/** Lean into a bend: the angle a bike takes at speed v on curvature κ (rad/m), limited. */
export function curveLean(speedMps: number, curvature: number): number {
  const v = Math.max(0, speedMps);
  const lean = Math.atan((v * v * curvature) / 9.81);
  return Math.max(-0.35, Math.min(0.35, lean));
}

/** Lateral position in metres from the road reference for a lateral input −1 … 1. */
export const riderLateralM = (lateral: number): number =>
  ROAD.riderBaseM + Math.max(-1, Math.min(1, lateral)) * ROAD.riderReachM;

/** A stable lateral offset for another rider (so a group spreads over the lane). */
export function otherLateralM(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ROAD.riderBaseM + ((h % 1000) / 1000 - 0.5) * 1.4;
}
