/**
 * Canvas layer of the perspective ride scene: fills the quads that
 * roadMath.ts lays out, plus the sky, a far silhouette that turns with the
 * camera, roadside trees and posts, gradient signs, other riders and the
 * rider seen from behind. Flat token-derived colours, few lines, no
 * textures — the same restrained style as the side-on scene.
 *
 * Per frame the work is a fixed number of batched paths (one per colour and
 * fog level); nothing here depends on frame timing.
 */
import type { RouteTrack } from '@freilauf/routes';
import { css, mix, parseColor, type Rgb, type ScenePalette } from './palette';
import { computePose, createPose, type Pose } from './riderPose';
import {
  anchorCamera,
  CAMERA,
  type Camera,
  createScreenPoint,
  fogLevel,
  horizonLine,
  otherLateralM,
  ROAD,
  RoadStrip,
  type ScreenPoint,
  type Viewport,
  viewportFor,
} from './roadMath';
import { formatGrade, hash01, valueNoise } from './sceneMath';
import type { GradeSign } from './routeSample';

const TAU = Math.PI * 2;
/** Fog levels (each is one batch of fills). */
const FOG_LEVELS = 6;
/** How far the colours go towards the haze at the far end. */
const FOG_MAX = 0.88;
/** Slope shades: lighter downhill, darker the steeper uphill (ink mixed in per step). */
const SHADES = [-1, 0, 1, 2] as const;
const SHADE_STEP = 0.035;

/** Shade of a stretch of road by its gradient (percent). */
export function slopeShade(gradePercent: number): -1 | 0 | 1 | 2 {
  if (gradePercent >= 6) return 2;
  if (gradePercent >= 2.5) return 1;
  if (gradePercent <= -2.5) return -1;
  return 0;
}

export interface RoadRider {
  id: string;
  name: string;
  /** Metres ahead along the road. */
  gapM: number;
  stale: boolean;
  crank: number;
}

export interface RoadFrame {
  track: RouteTrack;
  camera: Camera;
  state: 'idle' | 'riding' | 'paused';
  /** Lateral position of the rider, metres right of the road reference. */
  riderX: number;
  /** Lean in radians (+ = right): into the bend and into the steering. */
  lean: number;
  crank: number;
  standing: number;
  tuck: number;
  /** Gradient under the rider for the label, percent. */
  gradeLabel: number;
  /** The next gradient sign ahead (for the label), if any. */
  next: (GradeSign & { inM: number }) | null;
  /** All gradient signs of the route (route distance). */
  signs: readonly GradeSign[];
  /** Route distance(s) of a finish or lap line, or NaN. */
  finishM: number;
  others: readonly RoadRider[];
  reducedMotion: boolean;
}

interface FogColours {
  field: string[];
  verge: string[];
  /** By slope shade (−1 … 2, index + 1), then fog level: hills read as hills. */
  fieldShade: string[][];
  vergeShade: string[][];
  road: string[];
  edge: string[];
  mark: string[];
  trees: string[];
  treesDark: string[];
  posts: string[];
  ghost: string[];
  ghostJersey: string[];
  sign: string[];
}

interface RiderColours {
  tyre: string;
  frame: string;
  frameFar: string;
  jersey: string;
  jerseyShade: string;
  shorts: string;
  skin: string;
  helmet: string;
  shoe: string;
}

/** "+8 %", "−3 %", or "Flat" for a gradient sign. */
export function gradeWord(g: number): string {
  if (Math.abs(g) < 1) return 'Flat';
  return formatGrade(Math.round(g)).replace('.0 %', ' %');
}

export class RoadRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private vp: Viewport = viewportFor(1, 1);
  private pal: ScenePalette | null = null;
  private fog: FogColours | null = null;
  private skyFill: CanvasGradient | null = null;
  private skyFor = Number.NaN;
  private groundFill: CanvasGradient | null = null;
  private groundFor = Number.NaN;
  private local: RiderColours | null = null;
  private ghost: RiderColours | null = null;
  private family = 'system-ui, sans-serif';
  private labelFont = '';
  private nameFont = '';
  private signFont = '';
  private pillFont = '';
  private readonly strip = new RoadStrip();
  private readonly labels: { x: number; y: number; text: string; stale: boolean }[] = [];
  private readonly pose: Pose = createPose();
  private readonly a: ScreenPoint = createScreenPoint();
  private readonly b: ScreenPoint = createScreenPoint();
  private readonly c: ScreenPoint = createScreenPoint();
  private readonly d: ScreenPoint = createScreenPoint();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  get viewport(): Viewport {
    return this.vp;
  }

  get roadStrip(): RoadStrip {
    return this.strip;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.vp = viewportFor(w, h);
    this.skyFill = null;
    this.groundFill = null;
    this.fonts();
  }

  setPalette(p: ScenePalette, fontFamily: string): void {
    this.pal = p;
    this.family = fontFamily || this.family;
    this.skyFill = null;
    this.groundFill = null;
    const rgb = (c: string): Rgb => parseColor(c) ?? { r: 128, g: 128, b: 128, a: 1 };
    const haze = rgb(p.skyBottom);
    const level = (c: string, max = FOG_MAX): string[] => {
      const base = rgb(c);
      const out: string[] = [];
      for (let i = 0; i < FOG_LEVELS; i++) {
        const t = (i / (FOG_LEVELS - 1)) ** 1.1 * max;
        out.push(css(mix(base, haze, t)));
      }
      return out;
    };
    const surface = rgb(p.surface);
    const ink = rgb(p.ink);
    this.fog = {
      field: level(p.field),
      verge: level(p.verge),
      fieldShade: SHADES.map((sh) => level(css(mix(rgb(p.field), ink, sh * SHADE_STEP)))),
      vergeShade: SHADES.map((sh) => level(css(mix(rgb(p.verge), ink, sh * SHADE_STEP)))),
      road: level(p.road),
      edge: level(p.roadEdge),
      mark: level(p.roadMark),
      trees: level(p.treesFar),
      treesDark: level(p.trees),
      posts: level(p.roadEdge, 0.7),
      ghost: level(p.ghost, 0.6),
      ghostJersey: level(p.ghostJersey, 0.6),
      sign: level(css(mix(surface, ink, p.dark ? 0.12 : 0.02)), 0.5),
    };
    this.local = {
      tyre: p.tyre,
      frame: p.frame,
      frameFar: p.frameFar,
      jersey: p.jersey,
      jerseyShade: p.jerseyFar,
      shorts: p.shorts,
      skin: p.skin,
      helmet: p.ink,
      shoe: p.ink,
    };
    this.ghost = {
      tyre: p.ghost,
      frame: p.ghost,
      frameFar: p.ghost,
      jersey: p.ghostJersey,
      jerseyShade: p.ghost,
      shorts: p.ghost,
      skin: p.ghost,
      helmet: p.ghost,
      shoe: p.ghost,
    };
    this.fonts();
  }

  private fonts(): void {
    const s = (lo: number, hi: number, k: number): number =>
      Math.round(Math.max(lo, Math.min(hi, this.h * k)));
    this.labelFont = `650 ${s(12, 22, 0.042)}px ${this.family}`;
    this.nameFont = `600 ${s(10, 15, 0.032)}px ${this.family}`;
    this.signFont = `700 ${s(10, 17, 0.034)}px ${this.family}`;
    this.pillFont = `600 ${s(11, 17, 0.04)}px ${this.family}`;
  }

  draw(f: RoadFrame): void {
    const ctx = this.ctx;
    const p = this.pal;
    const fog = this.fog;
    if (!p || !fog || this.w <= 1) return;
    const { dpr, vp } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;

    const strip = this.strip;
    anchorCamera(vp, f.camera, f.riderX);
    strip.build(f.track, vp, f.camera);
    const hy = horizonLine(vp, f.camera);

    this.sky(hy, p);
    this.silhouette(f.camera, hy, p);
    this.ground(hy, fog);

    for (let level = FOG_LEVELS - 1; level >= 0; level--) {
      this.roadLevel(f, level, hy, fog);
      this.objectsLevel(f, level, fog);
    }

    this.others(f, fog);
    this.localRider(f);
    this.hud(f, p);

    if (f.state === 'paused') this.pill('Paused', p, true);
    else if (f.state === 'idle') this.pill('Ready', p, false);
  }

  // ─────────── sky and ground ───────────

  private sky(hy: number, p: ScenePalette): void {
    const ctx = this.ctx;
    if (!this.skyFill || this.skyFor !== Math.round(hy)) {
      const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
      g.addColorStop(0, p.skyTop);
      g.addColorStop(1, p.skyBottom);
      this.skyFill = g;
      this.skyFor = Math.round(hy);
    }
    ctx.fillStyle = this.skyFill;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  /**
   * Distant hills on the horizon as a function of view angle, so a turn of
   * the camera sweeps them across: 90° of turn moves them ~focal × π/2 px.
   */
  private silhouette(cam: Camera, hy: number, p: ScenePalette): void {
    const ctx = this.ctx;
    const { w } = this;
    const f = this.vp.focalPx;
    const step = Math.max(3, w / 180);
    const layer = (colour: string, amp: number, freq: number, seed: number, lift: number): void => {
      ctx.beginPath();
      ctx.moveTo(0, hy + 2);
      for (let x = 0; x <= w + step; x += step) {
        const ang = cam.yaw + Math.atan((x - this.vp.cx) / f);
        const u = ang * freq;
        const n = 0.65 * valueNoise(u, seed) + 0.35 * valueNoise(u * 2.9 + 7, seed + 1);
        ctx.lineTo(x, hy - f * amp * (lift + (1 - lift) * n));
      }
      ctx.lineTo(w, hy + 2);
      ctx.closePath();
      ctx.fillStyle = colour;
      ctx.fill();
    };
    layer(p.farHills, 0.085, 5, 17, 0.25);
    layer(p.nearHills, 0.045, 11, 29, 0.2);
  }

  private ground(hy: number, fog: FogColours): void {
    const ctx = this.ctx;
    const top = Math.max(0, hy);
    if (top >= this.h) return;
    if (!this.groundFill || this.groundFor !== Math.round(top)) {
      const g = ctx.createLinearGradient(0, top, 0, Math.min(this.h, top + this.h * 0.25));
      g.addColorStop(0, fog.field[FOG_LEVELS - 1]!);
      g.addColorStop(1, fog.field[0]!);
      this.groundFill = g;
      this.groundFor = Math.round(top);
    }
    ctx.fillStyle = this.groundFill;
    ctx.fillRect(0, top, this.w, this.h - top);
  }

  // ─────────── road ───────────

  /** Near end (route distance) of the visible part of segment k. */
  private nearEnd(k: number): number {
    const s = this.strip.s;
    return s[k]! - (s[k]! - s[k - 1]!) * this.strip.visibleFrom[k]!;
  }

  /** Adds the quad between lateral offsets l0 and l1 over [s0, s1] to the current path. */
  private quad(f: RoadFrame, s0: number, s1: number, l0: number, l1: number): void {
    const { vp, a, b, c, d, strip } = this;
    const cam = f.camera;
    if (
      strip.pointAt(vp, cam, s0, l0, 0, a) === 0 ||
      strip.pointAt(vp, cam, s0, l1, 0, b) === 0 ||
      strip.pointAt(vp, cam, s1, l1, 0, c) === 0 ||
      strip.pointAt(vp, cam, s1, l0, 0, d) === 0
    ) {
      return;
    }
    const ctx = this.ctx;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
  }

  private roadLevel(f: RoadFrame, level: number, hy: number, fog: FogColours): void {
    const ctx = this.ctx;
    const strip = this.strip;
    const { s, Z, visible } = strip;
    const n = strip.count;
    const inLevel = (k: number): boolean =>
      visible[k] === 1 && fogLevel(Z[k]! + CAMERA.backM, FOG_LEVELS) === level;
    let any = false;
    for (let k = 1; k < n; k++) if (inLevel(k)) any = true;
    if (!any) return;

    const hw = ROAD.halfWidthM;
    const vergeOut = hw + ROAD.vergeM;

    // Terrain: full-width bands where the land rises above the horizon or
    // slopes, shaded by gradient, so a hill reads as a hill. The flat land
    // below the horizon is the ground fill already.
    const ex = CAMERA.elevationExaggeration;
    const shadeOf = (k: number): number =>
      slopeShade(((strip.Y[k]! - strip.Y[k - 1]!) / ex / Math.max(1e-6, s[k]! - s[k - 1]!)) * 100);
    for (const shade of SHADES) {
      ctx.beginPath();
      let bands = false;
      for (let k = 1; k < n; k++) {
        if (!inLevel(k) || shadeOf(k) !== shade) continue;
        const yFar = strip.sy[k]!;
        if (yFar >= hy && shade === 0) continue;
        if (strip.pointAt(this.vp, f.camera, this.nearEnd(k), 0, 0, this.a) === 0) continue;
        const yNear = Math.max(this.a.y, yFar);
        const bottom = shade === 0 ? Math.min(yNear, hy + 2) : yNear;
        ctx.rect(0, yFar - 0.5, this.w, bottom - yFar + 1);
        bands = true;
      }
      if (bands) {
        ctx.fillStyle = fog.fieldShade[shade + 1]![level]!;
        ctx.fill();
      }
    }

    // Verges, shaded like the land.
    for (const shade of SHADES) {
      ctx.beginPath();
      let any2 = false;
      for (let k = 1; k < n; k++) {
        if (!inLevel(k) || shadeOf(k) !== shade) continue;
        const s0 = this.nearEnd(k);
        this.quad(f, s0, s[k]!, -vergeOut, -hw + 0.01);
        this.quad(f, s0, s[k]!, hw - 0.01, vergeOut);
        any2 = true;
      }
      if (any2) {
        ctx.fillStyle = fog.vergeShade[shade + 1]![level]!;
        ctx.fill();
      }
    }

    // Asphalt.
    ctx.beginPath();
    for (let k = 1; k < n; k++) {
      if (!inLevel(k)) continue;
      this.quad(f, this.nearEnd(k), s[k]!, -hw, hw);
    }
    ctx.fillStyle = fog.road[level]!;
    ctx.fill();

    // Edge lines.
    const e0 = hw - ROAD.edgeInsetM;
    const e1 = e0 - ROAD.edgeWidthM;
    ctx.beginPath();
    for (let k = 1; k < n; k++) {
      if (!inLevel(k)) continue;
      const s0 = this.nearEnd(k);
      this.quad(f, s0, s[k]!, -e0, -e1);
      this.quad(f, s0, s[k]!, e1, e0);
    }
    ctx.fillStyle = fog.edge[level]!;
    ctx.fill();

    // Centre dashes, fixed to the road.
    const half = ROAD.dashWidthM / 2;
    const period = ROAD.dashPeriodM;
    ctx.beginPath();
    let dashes = false;
    for (let k = 1; k < n; k++) {
      if (!inLevel(k)) continue;
      const s0 = this.nearEnd(k);
      const s1 = s[k]!;
      for (let j = Math.floor(s0 / period); j * period < s1; j++) {
        const a0 = Math.max(s0, j * period);
        const a1 = Math.min(s1, j * period + ROAD.dashM);
        if (a1 <= a0) continue;
        this.quad(f, a0, a1, -half, half);
        dashes = true;
      }
    }
    if (dashes) {
      ctx.fillStyle = fog.mark[level]!;
      ctx.fill();
    }

    // Finish / lap line: a band of checks across the asphalt.
    if (Number.isFinite(f.finishM)) {
      const k = strip.indexAt(f.finishM);
      if (k > 0 && inLevel(k) && f.finishM >= this.nearEnd(k)) {
        const cols = 10;
        const depth = 0.9;
        for (let row = 0; row < 2; row++) {
          for (let parity = 0; parity < 2; parity++) {
            ctx.beginPath();
            for (let i = 0; i < cols; i++) {
              if ((i + row) % 2 !== parity) continue;
              const l0 = -hw + (2 * hw * i) / cols;
              this.quad(
                f,
                f.finishM + row * depth,
                f.finishM + (row + 1) * depth,
                l0,
                l0 + (2 * hw) / cols,
              );
            }
            ctx.fillStyle = parity === 0 ? fog.mark[level]! : fog.edge[level]!;
            ctx.fill();
          }
        }
      }
    }
  }

  // ─────────── roadside ───────────

  private objectsLevel(f: RoadFrame, level: number, fog: FogColours): void {
    const strip = this.strip;
    if (strip.count < 2) return;
    const d = f.camera.distanceM;
    const sMin = d + 1.5;
    const sMax = strip.s[strip.count - 1]!;
    const hw = ROAD.halfWidthM;
    const ctx = this.ctx;

    // Trees: slots every 13 m per side, about half of them used, far to near.
    const slot = 13;
    ctx.fillStyle = fog.trees[level]!;
    const last = Math.floor(sMax / slot);
    const first = Math.floor(sMin / slot);
    for (let i = last; i >= first; i--) {
      for (let side = -1; side <= 1; side += 2) {
        const seed = side < 0 ? 11 : 23;
        if (hash01(i, seed) < 0.5) continue;
        const s = i * slot + hash01(i, seed + 1) * (slot - 2);
        if (s < sMin || s > sMax) continue;
        const lat = side * (hw + ROAD.vergeM + 2.5 + hash01(i, seed + 2) * 18);
        const k = strip.pointAt(this.vp, f.camera, s, lat, 0, this.a);
        if (k === 0 || fogLevel(this.a.depth, FOG_LEVELS) !== level) continue;
        const size = 0.8 + hash01(i, seed + 3) * 0.6;
        const cypress = hash01(i, seed + 4) > 0.78;
        this.tree(k, this.a, size, cypress, cypress ? fog.treesDark[level]! : fog.trees[level]!);
      }
    }

    // Marker posts every 50 m on both sides.
    const every = 50;
    ctx.fillStyle = fog.posts[level]!;
    for (let i = Math.floor(sMax / every); i * every >= sMin; i--) {
      for (let side = -1; side <= 1; side += 2) {
        const k = strip.pointAt(this.vp, f.camera, i * every, side * (hw + 0.55), 0, this.a);
        if (k === 0 || fogLevel(this.a.depth, FOG_LEVELS) !== level) continue;
        const ppm = this.vp.focalPx / this.a.depth;
        const ph = 1.0 * ppm;
        const pw = Math.max(1, 0.12 * ppm);
        this.clipped(k, this.a.y, this.a.y - ph, () => {
          ctx.fillStyle = fog.posts[level]!;
          ctx.fillRect(this.a.x - pw / 2, this.a.y - ph, pw, ph);
        });
      }
    }

    // Gradient signs on the right verge.
    for (const sign of f.signs) {
      const at = this.wrapNear(f, sign.atM);
      if (at < sMin || at > Math.min(sMax, d + 420)) continue;
      const k = strip.pointAt(this.vp, f.camera, at, hw + 0.9, 0, this.a);
      if (k === 0 || fogLevel(this.a.depth, FOG_LEVELS) !== level) continue;
      this.sign(k, this.a, sign.gradePercent, fog, level);
    }
  }

  /** A route distance moved into the lap the rider is on (for loops). */
  private wrapNear(f: RoadFrame, atM: number): number {
    const total = (f.track.count - 1) * f.track.stepM;
    if (!f.track.loop || total <= 0) return atM;
    const d = f.camera.distanceM;
    let v = atM + Math.floor(d / total) * total;
    if (v < d) v += total;
    return v;
  }

  /** Runs `draw` clipped to above the crest line when the object's base is hidden. */
  private clipped(k: number, baseY: number, topY: number, draw: () => void): void {
    const strip = this.strip;
    if (!strip.hiddenAt(k, baseY)) {
      draw();
      return;
    }
    const clipY = strip.clip[k]!;
    if (topY >= clipY) return; // entirely behind the crest
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.w, clipY);
    ctx.clip();
    draw();
    ctx.restore();
  }

  private tree(k: number, at: ScreenPoint, size: number, cypress: boolean, colour: string): void {
    const ctx = this.ctx;
    const ppm = this.vp.focalPx / at.depth;
    const x = at.x;
    const y = at.y;
    const height = (cypress ? 9 : 7) * size * ppm;
    if (height < 1.5) return;
    this.clipped(k, y, y - height, () => {
      ctx.fillStyle = colour;
      ctx.beginPath();
      if (cypress) {
        const half = 1.1 * size * ppm;
        ctx.moveTo(x, y - height);
        ctx.bezierCurveTo(x + half * 1.2, y - height * 0.62, x + half, y - height * 0.1, x, y);
        ctx.bezierCurveTo(
          x - half,
          y - height * 0.1,
          x - half * 1.2,
          y - height * 0.62,
          x,
          y - height,
        );
      } else {
        const cr = 2.2 * size * ppm;
        const cy = y - height + cr;
        const tw = Math.max(1, 0.35 * size * ppm);
        ctx.rect(x - tw / 2, cy, tw, y - cy);
        ctx.moveTo(x + cr, cy);
        ctx.arc(x, cy, cr, 0, TAU);
        ctx.moveTo(x - cr * 0.45 + cr * 0.75, cy + cr * 0.45);
        ctx.arc(x - cr * 0.45, cy + cr * 0.45, cr * 0.75, 0, TAU);
      }
      ctx.fill();
    });
  }

  /** A roadside plate on a post: "+8 %", readable before it gets close. */
  private sign(k: number, at: ScreenPoint, grade: number, fog: FogColours, level: number): void {
    const ctx = this.ctx;
    const p = this.pal!;
    const ppm = this.vp.focalPx / at.depth;
    const postH = 1.6 * ppm;
    const text = gradeWord(grade);
    // The plate grows with nearness but never below a readable size.
    const scale = Math.max(0.45, Math.min(1.3, ppm / 30));
    ctx.font = this.signFont;
    const tw = ctx.measureText(text).width;
    const fs = Number.parseFloat(this.signFont.split(' ')[1] ?? '13');
    const pw = (tw + fs * 0.9) * scale;
    const ph = fs * 1.5 * scale;
    const top = at.y - postH - ph;
    this.clipped(k, at.y, top, () => {
      ctx.fillStyle = fog.posts[level]!;
      ctx.fillRect(
        at.x - Math.max(1, 0.08 * ppm) / 2,
        at.y - postH,
        Math.max(1, 0.08 * ppm),
        postH,
      );
      ctx.fillStyle = fog.sign[level]!;
      ctx.strokeStyle = fog.edge[level]!;
      ctx.lineWidth = Math.max(1, 1.5 * scale);
      ctx.beginPath();
      ctx.roundRect(at.x - pw / 2, top, pw, ph, ph * 0.22);
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.translate(at.x, top + ph / 2);
      ctx.scale(scale, scale);
      ctx.fillStyle = level <= 2 ? p.ink : fog.edge[level]!;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 1);
      ctx.restore();
    });
  }

  // ─────────── riders ───────────

  private others(f: RoadFrame, fog: FogColours): void {
    const ctx = this.ctx;
    const strip = this.strip;
    const d = f.camera.distanceM;
    const p = this.pal!;
    // Farthest first.
    for (let i = f.others.length - 1; i >= 0; i--) {
      const o = f.others[i]!;
      if (!(o.gapM > 1.5) || o.gapM > 420) continue;
      const k = strip.pointAt(this.vp, f.camera, d + o.gapM, otherLateralM(o.id), 0, this.a);
      if (k === 0) continue;
      const ppm = this.vp.focalPx / this.a.depth;
      const level = fogLevel(this.a.depth, FOG_LEVELS);
      const headY = this.a.y - 1.62 * ppm;
      if (strip.hiddenAt(k, headY)) continue;
      const colours: RiderColours = {
        ...this.ghost!,
        tyre: fog.ghost[level]!,
        frame: fog.ghost[level]!,
        frameFar: fog.ghost[level]!,
        shorts: fog.ghost[level]!,
        skin: fog.ghost[level]!,
        helmet: fog.ghost[level]!,
        shoe: fog.ghost[level]!,
        jersey: fog.ghostJersey[level]!,
        jerseyShade: fog.ghost[level]!,
      };
      ctx.globalAlpha = o.stale ? 0.45 : 1;
      this.clipped(k, this.a.y, headY, () => {
        this.riderFromBehind(this.a.x, this.a.y, ppm, 0, o.crank, 0, 0, colours, false);
      });
      ctx.globalAlpha = 1;
      const label = o.gapM >= 100 ? `${o.name} · ${Math.round(o.gapM)} m` : o.name;
      this.labels.push({ x: this.a.x, y: headY - 4, text: label, stale: o.stale });
    }
    // Names above the heads, nearest first; a name that would overlap a nearer one is left out.
    ctx.font = this.nameFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    const fs = Number.parseFloat(this.nameFont.split(' ')[1] ?? '12');
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const l = this.labels[i]!;
      const tw = ctx.measureText(l.text).width;
      const box = { x0: l.x - tw / 2 - 3, x1: l.x + tw / 2 + 3, y0: l.y - fs - 2, y1: l.y + 2 };
      if (placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1))
        continue;
      placed.push(box);
      ctx.strokeStyle = p.surface;
      ctx.strokeText(l.text, l.x, l.y);
      ctx.fillStyle = l.stale ? p.ink3 : p.ink2;
      ctx.fillText(l.text, l.x, l.y);
    }
    this.labels.length = 0;
  }

  private localRider(f: RoadFrame): void {
    const k = this.strip.pointAt(this.vp, f.camera, f.camera.distanceM, f.riderX, 0, this.a);
    if (k === 0) return;
    const ppm = this.vp.focalPx / this.a.depth;
    // Shadow: a soft ellipse on the road, shifted towards the lean.
    const ctx = this.ctx;
    ctx.fillStyle = this.pal!.shadow;
    ctx.beginPath();
    ctx.ellipse(
      this.a.x + f.lean * ppm * 0.5,
      this.a.y + 0.02 * ppm,
      0.38 * ppm,
      0.07 * ppm,
      0,
      0,
      TAU,
    );
    ctx.fill();
    this.riderFromBehind(
      this.a.x,
      this.a.y,
      ppm,
      f.lean,
      f.crank,
      f.standing,
      f.tuck,
      this.local!,
      true,
    );
  }

  /**
   * Bike and rider seen from behind, in metres (x right, y up) at contact
   * point (x, y), `ppm` pixels per metre, leaning by `lean` (+ = right).
   * Heights come from the side-view pose, so the legs pedal at cadence and
   * the rider rises out of the saddle exactly as in the side-on scene.
   */
  private riderFromBehind(
    x: number,
    y: number,
    ppm: number,
    lean: number,
    crank: number,
    standing: number,
    tuck: number,
    c: RiderColours,
    detailed: boolean,
  ): void {
    const ctx = this.ctx;
    const pose = this.pose;
    computePose(pose, crank, standing, tuck, 0);
    const k = ppm * this.dpr;
    // Out of the saddle the bike rocks under the rider, twice per revolution.
    const rock = standing * 0.09 * Math.sin(crank);
    ctx.setTransform(k, 0, 0, -k, x * this.dpr, y * this.dpr);
    ctx.rotate(-(lean + rock));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const r = 0.336;
    const hipY = pose.hip.y;
    const shoulderY = pose.shoulder.y;
    const headY = pose.head.y;
    const handY = pose.hand.y;
    // The body counter-rocks a little, so the bike moves more than the rider.
    const bodyShift = -rock * 0.5;

    // Front wheel peeking out above the rear one (it is further away, so higher).
    ctx.fillStyle = c.frameFar;
    ctx.beginPath();
    ctx.ellipse(0, r + 0.1, 0.022, r * 0.92, 0, 0, TAU);
    ctx.fill();

    // Handlebar, hands on the hoods.
    ctx.strokeStyle = c.frame;
    ctx.lineWidth = 0.028;
    ctx.beginPath();
    ctx.moveTo(-0.2, handY + 0.06);
    ctx.lineTo(0.2, handY + 0.06);
    ctx.stroke();

    ctx.save();
    ctx.translate(bodyShift, 0);
    // Arms: shoulder → elbow (out a little) → hand.
    for (const side of [-1, 1]) {
      this.capsule(
        side * 0.17,
        shoulderY - 0.04,
        side * 0.235,
        (shoulderY + handY) / 2 - 0.02,
        0.05,
        0.043,
        c.jerseyShade,
      );
      this.capsule(
        side * 0.235,
        (shoulderY + handY) / 2 - 0.02,
        side * 0.2,
        handY + 0.06,
        0.04,
        0.034,
        c.skin,
      );
      ctx.fillStyle = c.shoe;
      ctx.beginPath();
      ctx.arc(side * 0.2, handY + 0.06, 0.035, 0, TAU);
      ctx.fill();
    }

    // Legs: the near pedal (index 0) is the right foot.
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const knee = pose.knee[i]!;
      const ankle = pose.ankle[i]!;
      const pedal = pose.pedal[i]!;
      const kx = side * 0.125;
      const ax = side * 0.115;
      this.capsule(side * 0.09, hipY - 0.02, kx, knee.y, 0.08, 0.055, c.shorts);
      this.capsule(kx, knee.y, ax, ankle.y, 0.055, 0.035, c.skin);
      // Shoe seen from behind: a small rounded heel.
      ctx.fillStyle = c.shoe;
      ctx.beginPath();
      ctx.ellipse(ax, Math.min(ankle.y, pedal.y + 0.02), 0.045, 0.04, 0, 0, TAU);
      ctx.fill();
    }

    // Shorts over the saddle, then the back.
    ctx.fillStyle = c.shorts;
    ctx.beginPath();
    ctx.ellipse(0, hipY, 0.16, 0.085, 0, 0, TAU);
    ctx.fill();
    const waistW = 0.15;
    const shoulderW = 0.2;
    ctx.fillStyle = c.jersey;
    ctx.beginPath();
    ctx.moveTo(-waistW, hipY + 0.02);
    ctx.bezierCurveTo(
      -waistW - 0.02,
      (hipY + shoulderY) / 2,
      -shoulderW - 0.02,
      shoulderY - 0.08,
      -shoulderW + 0.02,
      shoulderY + 0.02,
    );
    ctx.quadraticCurveTo(0, shoulderY + 0.1, shoulderW - 0.02, shoulderY + 0.02);
    ctx.bezierCurveTo(
      shoulderW + 0.02,
      shoulderY - 0.08,
      waistW + 0.02,
      (hipY + shoulderY) / 2,
      waistW,
      hipY + 0.02,
    );
    ctx.quadraticCurveTo(0, hipY - 0.03, -waistW, hipY + 0.02);
    ctx.closePath();
    ctx.fill();
    if (detailed) {
      // Jersey pockets: one quiet line across the lower back.
      ctx.strokeStyle = c.jerseyShade;
      ctx.lineWidth = 0.012;
      ctx.beginPath();
      ctx.moveTo(-waistW + 0.02, hipY + 0.11);
      ctx.quadraticCurveTo(0, hipY + 0.085, waistW - 0.02, hipY + 0.11);
      ctx.stroke();
    }

    // Helmet: the back of the shell above the shoulders.
    const hy = Math.max(headY, shoulderY + 0.06);
    ctx.fillStyle = c.skin;
    ctx.beginPath();
    ctx.ellipse(0, hy - 0.05, 0.065, 0.06, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = c.helmet;
    ctx.beginPath();
    ctx.ellipse(0, hy + 0.02, 0.115, 0.095, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Rear wheel, edge-on, nearest to the camera: drawn last.
    ctx.fillStyle = c.tyre;
    ctx.beginPath();
    ctx.ellipse(0, r, 0.03, r, 0, 0, TAU);
    ctx.fill();
    // Seat stays and the saddle's tail.
    ctx.strokeStyle = c.frame;
    ctx.lineWidth = 0.022;
    ctx.beginPath();
    ctx.moveTo(-0.065, r);
    ctx.lineTo(-0.02, hipY - 0.17);
    ctx.moveTo(0.065, r);
    ctx.lineTo(0.02, hipY - 0.17);
    ctx.stroke();
    if (detailed) {
      // Cassette and derailleur on the right.
      ctx.fillStyle = c.frameFar;
      ctx.beginPath();
      ctx.roundRect(0.035, r - 0.13, 0.035, 0.17, 0.012);
      ctx.fill();
      // A small rear light.
      ctx.fillStyle = this.pal!.dark ? '#ff6159' : '#cc2b22';
      ctx.beginPath();
      ctx.roundRect(-0.02, hipY - 0.2, 0.04, 0.05, 0.01);
      ctx.fill();
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private capsule(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r0: number,
    r1: number,
    colour: string,
  ): void {
    const ctx = this.ctx;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x0, y0, r0, ang + Math.PI / 2, ang + (3 * Math.PI) / 2);
    ctx.arc(x1, y1, r1, ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  }

  // ─────────── labels ───────────

  /** Gradient now and the next change: a calm label in the top-right corner. */
  private hud(f: RoadFrame, p: ScenePalette): void {
    const ctx = this.ctx;
    const pad = Math.max(8, this.h * 0.03);
    ctx.font = this.labelFont;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = p.surface;
    const now = formatGrade(f.gradeLabel);
    ctx.strokeText(now, this.w - pad, pad);
    ctx.fillStyle = p.ink;
    ctx.fillText(now, this.w - pad, pad);
    if (f.next && f.next.inM >= 50) {
      const fs = Number.parseFloat(this.nameFont.split(' ')[1] ?? '12');
      ctx.font = this.nameFont;
      const text = `${gradeWord(f.next.gradePercent)} in ${Math.round(f.next.inM / 50) * 50} m`;
      const y = pad + fs * 1.9;
      ctx.lineWidth = 3;
      ctx.strokeText(text, this.w - pad, y);
      ctx.fillStyle = p.ink2;
      ctx.fillText(text, this.w - pad, y);
    }
  }

  private pill(text: string, p: ScenePalette, wash: boolean): void {
    const ctx = this.ctx;
    if (wash) {
      ctx.fillStyle = p.wash;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    ctx.font = this.pillFont;
    const tw = ctx.measureText(text).width;
    const fs = Math.max(11, Math.min(17, this.h * 0.04));
    const ph = fs * 1.9;
    const pw = tw + fs * 1.8;
    const x = (this.w - pw) / 2;
    const y = Math.max(8, this.h * 0.06);
    ctx.fillStyle = p.surface;
    ctx.beginPath();
    ctx.roundRect(x, y, pw, ph, ph / 2);
    ctx.fill();
    ctx.strokeStyle = p.roadEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = wash ? p.ink : p.ink2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.w / 2, y + ph / 2 + 0.5);
  }
}
