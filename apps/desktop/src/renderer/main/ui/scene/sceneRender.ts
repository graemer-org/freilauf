/**
 * Thin imperative rendering layer of the ride scene: draws one frame into a
 * 2D canvas from a `SceneFrame`. All maths lives in sceneMath / riderPose;
 * this file only turns numbers into paths. Per-frame work allocates nothing
 * beyond what the canvas API does internally (gradients and fonts are cached).
 */

import type { ScenePalette } from './palette';
import { GATE_DRAW_M, type PowerUpSceneFrame } from './powerUpScene';
import {
  arcPoint,
  drawBottle,
  drawCape,
  drawDrips,
  drawFeedBag,
  drawMudSpatter,
  drawProtection,
  drawPuddle,
  drawRiderFx,
  drawEnergy,
  drawProgressRing,
  drawRoughPatch,
  drawSplash,
  drawSwarm,
  drawTacks,
  drawTeamCarSide,
  drawWrench,
} from './rumbleFx';
import { BIKE, BODY, computePose, createPose, type Point, type Pose } from './riderPose';
import {
  formatGrade,
  hash01,
  leanFor,
  type PlacedRider,
  valueNoise,
  visualSlope,
} from './sceneMath';

export interface SceneFrame {
  state: 'idle' | 'riding' | 'paused';
  /** The scene's odometer in metres (drives parallax). */
  distanceM: number;
  /** Eased gradient for the tilt, percent. */
  grade: number;
  /** Live gradient for the label, percent. */
  gradeLabel: number;
  wheel: number;
  crank: number;
  lateral: number;
  lateralVel: number;
  standing: number;
  tuck: number;
  reducedMotion: boolean;
  others: readonly PlacedRider[];
  /** Wheel/crank angles of other riders, by id. */
  otherAngles: ReadonlyMap<string, { wheel: number; crank: number }>;
  /** Power-up gates ahead and the effect in progress (absent: none). */
  powerUps?: PowerUpSceneFrame;
}

interface Colours {
  frame: string;
  frameFar: string;
  tyre: string;
  spokes: string;
  jersey: string;
  jerseyFar: string;
  shorts: string;
  shortsFar: string;
  skin: string;
  skinFar: string;
  helmet: string;
  shoe: string;
}

const TAU = Math.PI * 2;

/** Rumble damage drawn on the local bike: a flat rear tyre (the bike sags, wobbles), the chain off. */
interface Damage {
  flat: boolean;
  chain: boolean;
  timeS: number;
  reduced: boolean;
}

/** Parallax depth factors (1 = the road plane). Further layers move slower and are drawn smaller. */
export const LAYERS = {
  clouds: 0.006,
  farHills: 0.015,
  nearHills: 0.04,
  treesFar: 0.09,
  trees: 0.17,
  road: 1,
} as const;

export class SceneRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private px = 100;
  private riderX = 0;
  private roadY0 = 0;
  private halfDepth = 10;
  private horizonY = 0;
  private sky: CanvasGradient | null = null;
  private pal: ScenePalette | null = null;
  private local: Colours | null = null;
  private ghost: Colours | null = null;
  private labelFont = '';
  private nameFont = '';
  private pillFont = '';
  private readonly pose: Pose = createPose();
  private readonly ghostPose: Pose = createPose();
  private readonly tmp: Point = { x: 0, y: 0 };

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  get context(): CanvasRenderingContext2D {
    return this.ctx;
  }

  /** Resizes the backing store; CSS pixels in, device pixels stored. */
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
    // ~2.5 rider heights fit the canvas height; never wider than ~1/5 of the width.
    this.px = Math.max(8, Math.min(h * 0.32, w * 0.17));
    this.riderX = w * 0.4;
    this.roadY0 = h * 0.77;
    this.halfDepth = Math.max(4, Math.min(h * 0.085, this.px * 0.5));
    this.horizonY = this.roadY0 - this.halfDepth - h * 0.1;
    this.sky = null;
    this.fonts();
  }

  setPalette(p: ScenePalette, fontFamily: string): void {
    this.pal = p;
    this.sky = null;
    this.local = {
      frame: p.frame,
      frameFar: p.frameFar,
      tyre: p.tyre,
      spokes: p.spokes,
      jersey: p.jersey,
      jerseyFar: p.jerseyFar,
      shorts: p.shorts,
      shortsFar: p.frameFar,
      skin: p.skin,
      skinFar: p.skinFar,
      helmet: p.ink,
      shoe: p.ink,
    };
    this.ghost = {
      frame: p.ghost,
      frameFar: p.ghost,
      tyre: p.ghost,
      spokes: p.ghost,
      jersey: p.ghostJersey,
      jerseyFar: p.ghost,
      shorts: p.ghost,
      shortsFar: p.ghost,
      skin: p.ghost,
      skinFar: p.ghost,
      helmet: p.ghost,
      shoe: p.ghost,
    };
    this.family = fontFamily || 'system-ui, sans-serif';
    this.fonts();
  }

  private family = 'system-ui, sans-serif';

  private fonts(): void {
    const size = Math.round(Math.max(12, Math.min(24, this.h * 0.045)));
    this.labelFont = `650 ${size}px ${this.family}`;
    this.nameFont = `600 ${Math.round(Math.max(10, Math.min(16, this.h * 0.035)))}px ${this.family}`;
    this.pillFont = `600 ${Math.round(Math.max(11, Math.min(17, this.h * 0.04)))}px ${this.family}`;
  }

  private roadY(x: number, slope: number): number {
    return this.roadY0 - slope * (x - this.riderX);
  }

  draw(f: SceneFrame): void {
    const ctx = this.ctx;
    const p = this.pal;
    if (!p || this.w <= 1) return;
    const { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;

    if (!this.sky) {
      const g = ctx.createLinearGradient(0, 0, 0, this.horizonY);
      g.addColorStop(0, p.skyTop);
      g.addColorStop(1, p.skyBottom);
      this.sky = g;
    }
    ctx.fillStyle = this.sky;
    ctx.fillRect(0, 0, w, h);

    const d = f.reducedMotion ? 0 : f.distanceM;
    const slope = visualSlope(f.grade);

    this.clouds(d * LAYERS.clouds, p.clouds);
    this.hills(d * LAYERS.farHills, p.farHills, h * 0.2, 0.55, 17, 0.6);
    this.hills(d * LAYERS.nearHills, p.nearHills, h * 0.12, 0.3, 29, 0.85);
    // Level fields up to the horizon.
    ctx.fillStyle = p.field;
    ctx.fillRect(0, this.horizonY, w, h - this.horizonY);
    this.trees(d, LAYERS.treesFar, p.treesFar, 41, 2.6);
    this.trees(d, LAYERS.trees, p.trees, 53, 3.4);

    this.road(d, slope, p);
    const pu = f.powerUps;
    if (pu) this.boostRoad(f, pu, slope, p);

    // Riders: those on the far side of the local rider first.
    const localLat = f.lateral;
    const otherLat = -0.62;
    if (pu?.effect === 'slipstream' && pu.phase === 'active') this.slipstreamGhost(f, slope);
    if (localLat < otherLat) this.localRider(f, slope);
    this.others(f, slope, otherLat);
    if (pu) this.boostAura(f, pu, slope, p);
    if (localLat >= otherLat) this.localRider(f, slope);
    if (pu && !pu.feedBags) this.gates(pu, slope, p, true);
    // The feed bag hangs over the lane: drawn over the riders, who ride past it.
    if (pu?.feedBags) this.feedBags(pu, slope, p);
    if (pu?.rumble) this.rumbleLocal(f, pu, slope, p);

    this.gradeLabel(f.gradeLabel, slope, p);
    if (pu) this.gateTag(pu, slope, p);

    if (f.state === 'paused') this.pill('Paused', p, true);
    else if (f.state === 'idle') this.pill('Ready', p, false);
  }

  // ─────────── background ───────────

  private hills(
    offsetM: number,
    colour: string,
    amp: number,
    lift: number,
    seed: number,
    scale: number,
  ): void {
    const ctx = this.ctx;
    const { w, h, px } = this;
    const base = this.horizonY + h * 0.005;
    const step = Math.max(4, w / 160);
    // World metres per screen pixel at this layer, so the shape does not change with size.
    const unit = 1 / (px * scale);
    ctx.beginPath();
    ctx.moveTo(0, base + 2);
    for (let x = 0; x <= w + step; x += step) {
      const u = (x * unit + offsetM) / 6;
      const n = 0.62 * valueNoise(u, seed) + 0.38 * valueNoise(u * 2.7 + 11, seed + 1);
      ctx.lineTo(x, base - amp * (lift + (1 - lift) * n));
    }
    ctx.lineTo(w, base + 2);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
  }

  /** A few long, soft clouds high in the sky, seeded by slot index. */
  private clouds(offsetM: number, colour: string): void {
    const ctx = this.ctx;
    const k = this.px * 0.35;
    const slot = 26; // metres at this depth
    const first = Math.floor((offsetM / 0.35 - this.w / k) / slot) - 1;
    const last = Math.ceil((offsetM / 0.35 + this.w / k) / slot) + 1;
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (let i = first; i <= last; i++) {
      if (hash01(i, 71) < 0.45) continue;
      const x = ((i + hash01(i, 72) * 0.6) * slot - offsetM / 0.35) * k;
      const y = this.horizonY * (0.18 + hash01(i, 73) * 0.38);
      // Long, thin streaks: a main band with a shorter one stacked on it.
      const len = (5 + hash01(i, 74) * 7) * k;
      const th = Math.max(2, (0.22 + hash01(i, 75) * 0.18) * k);
      ctx.roundRect(x, y, len, th, th / 2);
      ctx.roundRect(x + len * (0.15 + hash01(i, 76) * 0.3), y - th * 0.8, len * 0.4, th, th / 2);
    }
    ctx.fill();
  }

  /** A row of trees standing on the horizon, seeded by slot index. */
  private trees(d: number, s: number, colour: string, seed: number, slotM: number): void {
    const ctx = this.ctx;
    const k = this.px * s; // pixels per metre at this depth
    const slot = slotM / s; // world metres between slots (dense when far)
    const base = this.horizonY + 1;
    const first = Math.floor((d - this.riderX / k) / slot) - 1;
    const last = Math.ceil((d + (this.w - this.riderX) / k) / slot) + 1;
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (let i = first; i <= last; i++) {
      const r = hash01(i, seed);
      if (r < 0.38) continue;
      const jitter = hash01(i, seed + 7) * 0.8;
      const x = this.riderX + ((i + jitter) * slot - d) * k;
      const size = 0.75 + hash01(i, seed + 3) * 0.5;
      if (r < 0.8) {
        // Broadleaf: short trunk, crown of three overlapping discs.
        const th = 1.3 * size * k;
        const cr = 1.25 * size * k;
        const cy = base - th - cr * 0.8;
        ctx.rect(x - 0.1 * k, base - th - cr * 0.3, 0.2 * k, th + cr * 0.3);
        ctx.moveTo(x + cr, cy);
        ctx.arc(x, cy, cr, 0, TAU);
        ctx.moveTo(x - cr * 0.35 + cr * 0.8, cy + cr * 0.35);
        ctx.arc(x - cr * 0.35, cy + cr * 0.35, cr * 0.8, 0, TAU);
        ctx.moveTo(x + cr * 0.5 + cr * 0.75, cy + cr * 0.4);
        ctx.arc(x + cr * 0.5, cy + cr * 0.4, cr * 0.75, 0, TAU);
      } else {
        // Cypress: tall, narrow, pointed.
        const hgt = 6.5 * size * k;
        const half = 0.7 * size * k;
        ctx.moveTo(x, base - hgt);
        ctx.bezierCurveTo(x + half * 1.2, base - hgt * 0.62, x + half, base - hgt * 0.1, x, base);
        ctx.bezierCurveTo(
          x - half,
          base - hgt * 0.1,
          x - half * 1.2,
          base - hgt * 0.62,
          x,
          base - hgt,
        );
      }
    }
    ctx.fill();
  }

  // ─────────── road ───────────

  private road(d: number, slope: number, p: ScenePalette): void {
    const ctx = this.ctx;
    const { w, h, halfDepth } = this;
    const yl = this.roadY(0, slope);
    const yr = this.roadY(w, slope);
    const far = halfDepth;
    const verge = halfDepth * 0.55;

    // Far verge (grass strip behind the road).
    ctx.fillStyle = p.verge;
    ctx.beginPath();
    ctx.moveTo(0, yl - far - verge);
    ctx.lineTo(w, yr - far - verge);
    ctx.lineTo(w, yr - far);
    ctx.lineTo(0, yl - far);
    ctx.closePath();
    ctx.fill();

    // Road surface.
    ctx.fillStyle = p.road;
    ctx.beginPath();
    ctx.moveTo(0, yl - far);
    ctx.lineTo(w, yr - far);
    ctx.lineTo(w, yr + far);
    ctx.lineTo(0, yl + far);
    ctx.closePath();
    ctx.fill();

    // Ground in front of the road, down to the bottom edge, with a verge strip.
    ctx.fillStyle = p.field;
    ctx.beginPath();
    ctx.moveTo(0, yl + far);
    ctx.lineTo(w, yr + far);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = p.verge;
    ctx.beginPath();
    ctx.moveTo(0, yl + far);
    ctx.lineTo(w, yr + far);
    ctx.lineTo(w, yr + far + verge * 0.7);
    ctx.lineTo(0, yl + far + verge * 0.7);
    ctx.closePath();
    ctx.fill();

    // Edge lines.
    ctx.strokeStyle = p.roadEdge;
    ctx.lineWidth = Math.max(1, halfDepth * 0.06);
    ctx.beginPath();
    ctx.moveTo(0, yl - far * 0.86);
    ctx.lineTo(w, yr - far * 0.86);
    ctx.moveTo(0, yl + far * 0.86);
    ctx.lineTo(w, yr + far * 0.86);
    ctx.stroke();

    // Centre dashes: 2 m every 5 m, moving with the road.
    const k = this.px;
    const period = 5;
    const dash = 2;
    const first = Math.floor((d - this.riderX / k) / period) - 1;
    const last = Math.ceil((d + (w - this.riderX) / k) / period) + 1;
    ctx.strokeStyle = p.roadMark;
    ctx.lineWidth = Math.max(1, halfDepth * 0.09);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (let i = first; i <= last; i++) {
      const x0 = this.riderX + (i * period - d) * k;
      const x1 = x0 + dash * k;
      ctx.moveTo(x0, this.roadY(x0, slope));
      ctx.lineTo(x1, this.roadY(x1, slope));
    }
    ctx.stroke();

    // Marker posts on the far verge every 25 m, and grass tufts on the near side.
    const postEvery = 25;
    const pf = Math.floor((d - this.riderX / k) / postEvery) - 1;
    const pl = Math.ceil((d + (w - this.riderX) / k) / postEvery) + 1;
    ctx.fillStyle = p.roadEdge;
    ctx.beginPath();
    for (let i = pf; i <= pl; i++) {
      const x = this.riderX + (i * postEvery - d) * k;
      const y = this.roadY(x, slope) - far - verge * 0.45;
      const ph = 0.5 * k;
      const pw = Math.max(1.5, 0.045 * k);
      ctx.rect(x - pw / 2, y - ph, pw, ph);
    }
    ctx.fill();

    const tuftEvery = 1.7;
    const tf = Math.floor((d - this.riderX / k) / tuftEvery) - 1;
    const tl = Math.ceil((d + (w - this.riderX) / k) / tuftEvery) + 1;
    ctx.strokeStyle = p.road;
    ctx.lineWidth = Math.max(1, 0.012 * k);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = tf; i <= tl; i++) {
      if (hash01(i, 5) < 0.45) continue;
      const x = this.riderX + ((i + hash01(i, 6)) * tuftEvery - d) * k;
      const y = this.roadY(x, slope) + far + verge * (0.4 + hash01(i, 8) * 1.1);
      const th = (0.06 + hash01(i, 9) * 0.06) * k;
      ctx.moveTo(x - th * 0.35, y);
      ctx.lineTo(x - th * 0.5, y - th);
      ctx.moveTo(x, y);
      ctx.lineTo(x + th * 0.05, y - th * 1.2);
      ctx.moveTo(x + th * 0.35, y);
      ctx.lineTo(x + th * 0.55, y - th * 0.9);
    }
    ctx.stroke();
  }

  private gradeLabel(grade: number, slope: number, p: ScenePalette): void {
    const ctx = this.ctx;
    const x = this.riderX + Math.min(this.w * 0.36, this.px * 2.6);
    const y = this.roadY(x, slope) - this.halfDepth * 1.85;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-Math.atan(slope));
    ctx.font = this.labelFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const text = formatGrade(grade);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = p.surface;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = p.ink2;
    ctx.fillText(text, 0, 0);
    ctx.restore();
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

  // ─────────── power-ups ───────────

  /** Screen x of a point `aheadM` metres ahead of the rider on the road plane. */
  private aheadX(aheadM: number): number {
    return this.riderX + aheadM * this.px;
  }

  /**
   * Pick-up gates in view: a slim, softly lit arch across the lane, seen from the side as a
   * band of light from the far road edge to the near one. Far half first (behind the rider),
   * near half after the rider, so the rider rides through it.
   */
  private gates(pu: PowerUpSceneFrame, slope: number, p: ScenePalette, near: boolean): void {
    const ctx = this.ctx;
    const k = this.px;
    const reach = (this.w - this.riderX) / k + 1;
    const back = this.riderX / k + 1;
    for (const g of pu.gates) {
      if (g > reach || g < -back) continue;
      const x = this.aheadX(g);
      const yRoad = this.roadY(x, slope);
      const yFar = yRoad - this.halfDepth;
      const yNear = yRoad + this.halfDepth;
      const hgt = 1.05 * k;
      // Seen a little from the side: the far post sits to the right of the near one, so the
      // arch between them reads as an arch.
      const skew = 0.32 * k;
      const xFar = x + skew;
      const xNear = x - skew;
      const lift = 0.5 * k;
      ctx.save();
      ctx.globalAlpha = pu.holding ? 0.45 : 1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (!near) {
        // The light inside the gate: a soft curtain from the far post to the near one.
        const grad = ctx.createLinearGradient(0, yFar - hgt - lift, 0, yNear);
        grad.addColorStop(0, p.boostGlow);
        grad.addColorStop(1, p.boostFaint);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(xNear, yNear);
        ctx.lineTo(xNear, yNear - hgt);
        ctx.bezierCurveTo(xNear, yNear - hgt - lift, xFar, yFar - hgt - lift, xFar, yFar - hgt);
        ctx.lineTo(xFar, yFar);
        ctx.closePath();
        ctx.fill();
        // Its threshold across the road.
        ctx.strokeStyle = p.boostGlow;
        ctx.lineWidth = Math.max(3, 0.12 * k);
        ctx.beginPath();
        ctx.moveTo(xNear, yNear);
        ctx.lineTo(xFar, yFar);
        ctx.stroke();
        ctx.strokeStyle = p.boost;
        ctx.lineWidth = Math.max(1.5, 0.04 * k);
        ctx.beginPath();
        ctx.moveTo(xFar, yFar);
        ctx.lineTo(xFar, yFar - hgt);
        ctx.stroke();
      } else {
        ctx.strokeStyle = p.boost;
        ctx.lineWidth = Math.max(2, 0.055 * k);
        ctx.beginPath();
        ctx.moveTo(xNear, yNear);
        ctx.lineTo(xNear, yNear - hgt);
        ctx.bezierCurveTo(xNear, yNear - hgt - lift, xFar, yFar - hgt - lift, xFar, yFar - hgt);
        ctx.stroke();
        // A chevron in the curtain at rider height: "through here".
        const cy = yRoad - hgt * 0.5;
        const c = Math.max(3, 0.12 * k);
        ctx.lineWidth = Math.max(1.5, 0.04 * k);
        ctx.beginPath();
        ctx.moveTo(x - c * 0.45, cy - c);
        ctx.lineTo(x + c * 0.45, cy);
        ctx.lineTo(x - c * 0.45, cy + c);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** The next gate beyond the edge of the view: a quiet tag at the road's right end. */
  private gateTag(pu: PowerUpSceneFrame, slope: number, p: ScenePalette): void {
    const reach = (this.w - this.riderX) / this.px;
    const next = pu.gates.find((g) => g > -1);
    // Only while the next gate is still beyond the view: then the gate itself shows.
    if (next === undefined || next < reach - 0.5 || next > GATE_DRAW_M + 180) return;
    const ctx = this.ctx;
    ctx.font = this.pillFont;
    const text = `${Math.max(10, Math.round(next / 10) * 10)} m`;
    const fs = Math.max(11, Math.min(17, this.h * 0.04));
    const tw = ctx.measureText(text).width;
    const ph = fs * 1.75;
    const chev = fs * 0.9;
    const pw = tw + chev + fs * 1.6;
    const x = this.w - pw - Math.max(8, this.h * 0.03);
    const y = this.roadY(this.w, slope) - this.halfDepth - ph - this.halfDepth * 0.9;
    ctx.save();
    ctx.globalAlpha = pu.holding ? 0.6 : 1;
    ctx.fillStyle = p.surface;
    ctx.strokeStyle = p.boost;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.roundRect(x, y, pw, ph, ph / 2);
    ctx.fill();
    ctx.stroke();
    // A small glyph (an arch, or the feed bag in a Rumble), then the distance.
    const gx = x + fs * 0.75;
    const gy = y + ph / 2;
    if (pu.feedBags) {
      drawFeedBag(ctx, p, gx + chev / 2, gy - chev * 0.62, chev * 0.62);
    } else {
      ctx.strokeStyle = p.boost;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(gx, gy + chev * 0.45);
      ctx.lineTo(gx, gy - chev * 0.1);
      ctx.quadraticCurveTo(gx + chev * 0.5, gy - chev * 0.75, gx + chev, gy - chev * 0.1);
      ctx.lineTo(gx + chev, gy + chev * 0.45);
      ctx.stroke();
    }
    ctx.fillStyle = p.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, gx + chev + fs * 0.45, gy + 0.5);
    ctx.restore();
  }

  /**
   * On the road: the far halves of gates (or, in a Rumble, the feed bags and the mud puddles),
   * and Downhill momentum's chevrons while armed/active.
   */
  private boostRoad(f: SceneFrame, pu: PowerUpSceneFrame, slope: number, p: ScenePalette): void {
    if (!pu.feedBags) this.gates(pu, slope, p, false);
    if (pu.rumble) this.roughRoad(pu, slope, p);
    if (pu.rumble) this.puddles(pu, slope, p, f.reducedMotion);
    if (pu.effect !== 'downhill' || pu.phase === null) return;
    const ctx = this.ctx;
    const k = this.px;
    const armed = pu.phase === 'armed';
    // Chevrons painted on the lane ahead, drifting forward while active.
    const drift = f.reducedMotion || armed ? 0 : (pu.timeS * 2) % 1.2;
    ctx.save();
    ctx.strokeStyle = p.boost;
    ctx.globalAlpha = armed ? 0.45 : 0.9;
    ctx.lineWidth = Math.max(1.5, 0.05 * k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const c = Math.max(4, this.halfDepth * 0.45);
    for (let i = 0; i < 3; i++) {
      const x = this.aheadX(0.8 + i * 0.45 + drift * 0.375);
      const y = this.roadY(x, slope) + this.halfDepth * 0.12;
      ctx.beginPath();
      ctx.moveTo(x - c * 0.5, y - c * 0.55);
      ctx.lineTo(x + c * 0.2, y);
      ctx.lineTo(x - c * 0.5, y + c * 0.55);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Around the rider: the pick-up flash (a ring that opens and fades), Light load's soft glow
   * and lift, and Tailwind's light streaks (none with reduced motion).
   */
  private boostAura(f: SceneFrame, pu: PowerUpSceneFrame, slope: number, p: ScenePalette): void {
    const ctx = this.ctx;
    const k = this.px;
    const x = this.riderX + 0.05 * k;
    const y = this.roadY(this.riderX, slope) + f.lateral * this.halfDepth * 0.62 - 0.85 * k;
    const active = pu.phase === 'active';
    if (pu.effect === 'lightLoad' && active) {
      const g = ctx.createRadialGradient(x, y, 0.1 * k, x, y, 1.15 * k);
      g.addColorStop(0, p.boostGlow);
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 1.15 * k, 0, TAU);
      ctx.fill();
    }
    if (pu.effect === 'energyBar' && active) {
      drawEnergy(ctx, p, x, y, k, pu.effectAgeS, pu.timeS, f.reducedMotion);
    }
    if (pu.effect === 'tailwind' && active && !f.reducedMotion) {
      ctx.save();
      ctx.strokeStyle = p.streak;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, 0.02 * k);
      const span = this.w + 2 * k;
      for (let i = 0; i < 14; i++) {
        const speed = 0.8 + hash01(i, 91) * 0.6;
        const phase = (pu.timeS * speed * 0.9 + hash01(i, 92)) % 1;
        const sx = this.w + k - phase * span;
        const sy = this.horizonY * 0.45 + hash01(i, 93) * (this.roadY0 - this.horizonY * 0.45);
        const len = (0.5 + hash01(i, 94) * 0.9) * k;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + len, sy);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (pu.flash >= 0) {
      const t = pu.flash;
      const r = f.reducedMotion ? 1.0 * k : (0.4 + t * 1.1) * k;
      ctx.save();
      ctx.globalAlpha = f.reducedMotion ? 0.6 : 1 - t;
      ctx.strokeStyle = p.boost;
      ctx.lineWidth = Math.max(1.5, 0.05 * k);
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.92, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Freilauf Rumble's pick-ups: a feed bag held out over the lane from a slim stand at the far
   * road edge, at shoulder height, so the rider rides past and takes it. Quieter while both
   * slots are full (riding past it then takes nothing).
   */
  private feedBags(pu: PowerUpSceneFrame, slope: number, p: ScenePalette): void {
    const ctx = this.ctx;
    const k = this.px;
    const reach = (this.w - this.riderX) / k + 1;
    const back = this.riderX / k + 1;
    for (const g of pu.gates) {
      if (g > reach || g < -back) continue;
      const x = this.aheadX(g);
      const yRoad = this.roadY(x, slope);
      const yFar = yRoad - this.halfDepth;
      const postX = x + 0.35 * k;
      const top = yFar - 1.75 * k;
      const hookX = x - 0.05 * k;
      const hookY = yRoad - 1.55 * k;
      ctx.save();
      ctx.globalAlpha = pu.holding ? 0.45 : 1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // The stand and its arm reaching over the lane.
      ctx.strokeStyle = p.ink2;
      ctx.lineWidth = Math.max(1.5, 0.045 * k);
      ctx.beginPath();
      ctx.moveTo(postX, yFar);
      ctx.lineTo(postX, top);
      ctx.lineTo(hookX, hookY - 0.12 * k);
      ctx.lineTo(hookX, hookY);
      ctx.stroke();
      // A soft marker on the road where to ride past.
      ctx.fillStyle = p.boostFaint;
      ctx.beginPath();
      ctx.ellipse(x, yRoad + 0.1 * this.halfDepth, 0.6 * k, this.halfDepth * 0.35, 0, 0, TAU);
      ctx.fill();
      drawFeedBag(ctx, p, hookX, hookY, 0.55 * k, Math.sin(pu.timeS * 1.6 + g) * 0.06);
      ctx.restore();
    }
  }

  /**
   * Mud puddles and tacks on the road (own ones behind the rider, others' ahead), lying across
   * the lane.
   */
  private puddles(pu: PowerUpSceneFrame, slope: number, p: ScenePalette, reduced: boolean): void {
    const reach = (this.w - this.riderX) / this.px + 1;
    const back = this.riderX / this.px + 1;
    for (const pd of pu.rumble!.puddles) {
      if (pd.aheadM > reach || pd.aheadM < -back) continue;
      const x = this.aheadX(pd.aheadM);
      const y = this.roadY(x, slope) + 0.12 * this.halfDepth;
      const alpha = pd.own ? 0.8 : 1;
      if (pd.kind === 'tacks') {
        drawTacks(this.ctx, p, x, y, 0.7 * this.px, this.halfDepth * 0.5, pu.timeS, reduced, alpha);
      } else drawPuddle(this.ctx, p, x, y, 0.8 * this.px, this.halfDepth * 0.42, alpha);
    }
  }

  /** Rough sections on the road, in one-metre patches (the pattern stays put on the road). */
  private roughRoad(pu: PowerUpSceneFrame, slope: number, p: ScenePalette): void {
    const reach = (this.w - this.riderX) / this.px + 1;
    const back = this.riderX / this.px + 1;
    const d = this.halfDepth * 0.92;
    for (const r of pu.rumble!.rough) {
      const from = Math.max(r.fromM, -back);
      const to = Math.min(r.toM, reach);
      if (to <= from) continue;
      for (let j = Math.floor(from - r.fromM); r.fromM + j < to; j++) {
        const m0 = Math.max(from, r.fromM + j);
        const m1 = Math.min(to, r.fromM + j + 1);
        const x0 = this.aheadX(m0);
        const x1 = this.aheadX(m1);
        const y0 = this.roadY(x0, slope);
        const y1 = this.roadY(x1, slope);
        drawRoughPatch(
          this.ctx,
          p,
          r.variant,
          { x: x0, y: y0 + d },
          { x: x1, y: y1 + d },
          { x: x1, y: y1 - d },
          { x: x0, y: y0 - d },
          j,
          r.own ? 0.75 : 1,
        );
      }
    }
  }

  /** Where another rider is drawn (contact point) and their scale, or null when not on screen. */
  private otherPoint(
    f: SceneFrame,
    id: string | null,
    slope: number,
  ): { x: number; y: number; k: number } | null {
    if (!id) return null;
    const o = f.others.find((r) => r.id === id);
    if (!o || !o.onRoad) return null;
    const ahead = this.w - this.riderX - this.px * 0.9;
    const behind = this.riderX - this.px * 0.9;
    const x = this.riderX + o.offset * (o.offset >= 0 ? ahead : behind);
    if (x < 0 || x > this.w) return null;
    const pt = { x: 0, y: 0 };
    const scale = this.place(x, -0.62, slope, pt) * 0.94;
    return {
      x: pt.x + 0.05 * this.px * scale,
      y: pt.y - 0.85 * this.px * scale,
      k: this.px * scale,
    };
  }

  /**
   * Freilauf Rumble on the local rider: what slows it (water dripping off, mud spattered,
   * hornets buzzing round the head), the rain cape, the protection ring with its countdown, the
   * splash when a hit lands; a bottle or the swarm flying in from behind (the left); and this
   * rider's own bottle arcing to the rider ahead, or the swarm flying along the road to the
   * leader — out of the frame ahead when they are further than the view.
   */
  private rumbleLocal(f: SceneFrame, pu: PowerUpSceneFrame, slope: number, p: ScenePalette): void {
    const c = pu.rumble!;
    const ctx = this.ctx;
    const k = this.px;
    const reduced = f.reducedMotion;
    const x = this.riderX + 0.05 * k;
    const y = this.roadY(this.riderX, slope) + f.lateral * this.halfDepth * 0.62 - 0.85 * k;
    if (c.hit === 'bottle') drawDrips(ctx, p, x, y, k, pu.timeS, reduced);
    if (c.hit === 'puddle') drawMudSpatter(ctx, p, x, y, k);
    if (c.hit === 'hornets')
      drawSwarm(ctx, p, x + 0.1 * k, y - 0.8 * k, 0.6 * k, pu.timeS, reduced);
    if (c.cape) drawCape(ctx, p, x, y, 1.2 * k, 1.08 * k);
    if (c.protection >= 0) drawProtection(ctx, p, x, y, 1.25 * k, 1.12 * k, c.protection);
    // The rear wheel (the bike faces right): where the flat is, and the mini tool works.
    const wx = this.riderX - 0.5 * k;
    const wy = y + 0.85 * k - BIKE.wheelRadius * k;
    if (c.pulse >= 0 && c.pulseKind) {
      if (c.pulseItem === 'tacks' && c.pulseKind === 'hit') {
        drawSplash(ctx, p, wx, wy, 1.0 * k, c.pulse, c.pulseKind, c.pulseItem, reduced);
      } else {
        drawSplash(ctx, p, x, y - 0.2 * k, 1.0 * k, c.pulse, c.pulseKind, c.pulseItem, reduced);
      }
    }
    if (c.repair >= 0) {
      drawProgressRing(ctx, p, wx, wy, 0.46 * k, c.repair);
      const swing = reduced ? 0 : Math.sin(pu.timeS * 9) * 0.6;
      drawWrench(ctx, p, wx + 0.12 * k, wy - 0.05 * k, 0.42 * k, swing);
    }
    if (c.supply >= 0) {
      // The team car pulls up on the near side, hands the items up, and drops back.
      const t = c.supply;
      const inT = Math.min(1, t / 0.25);
      const outT = Math.max(0, (t - 0.8) / 0.2);
      const at = reduced ? 0 : (1 - inT) * -this.riderX - outT * (this.riderX + 3 * k);
      const carX = this.riderX - 0.4 * k + at;
      const carY = this.roadY(carX, slope) + this.halfDepth * 0.95;
      drawTeamCarSide(ctx, p, carX, carY, 4.2 * k, reduced ? 0.5 : t, c.supplyKinds);
    }
    const inc = c.incoming;
    if (inc) {
      // From behind: in from the left edge.
      const t = reduced ? 0.8 : inc.t;
      if (inc.kind === 'bottle') {
        const y0 = y - 0.6 * k;
        const pt = arcPoint(-0.4 * k, y0, x, y - 0.3 * k, this.arcLift(y0, k), t);
        drawBottle(ctx, p, pt.x, pt.y, 0.36 * k, reduced ? 0.6 : t * 9);
      } else {
        const sx = -0.6 * k + (x + 0.6 * k) * t;
        drawSwarm(ctx, p, sx, y - 0.8 * k, 0.45 * k, pu.timeS, reduced, 6);
      }
    }
    const th = c.throw;
    if (th) {
      const target = this.otherPoint(f, th.targetId, slope);
      const tx = target?.x ?? this.w + 1.5 * k;
      const ty = target?.y ?? y - 1.2 * k;
      if (th.splash < 0) {
        const t = reduced ? 0.55 : th.t;
        if (th.kind === 'bottle') {
          const y0 = y - 0.5 * k;
          const pt = arcPoint(x + 0.3 * k, y0, tx, ty, this.arcLift(Math.min(y0, ty), k), t);
          drawBottle(ctx, p, pt.x, pt.y, 0.36 * k, reduced ? 0.6 : t * 10);
        } else {
          const sx = x + (tx - x) * t;
          const sy = y - 0.9 * k + (ty - 0.6 * (target?.k ?? k) - (y - 0.9 * k)) * t;
          drawSwarm(ctx, p, sx, sy, 0.45 * k, pu.timeS, reduced, 6);
        }
      } else if (target && th.splashKind) {
        drawSplash(
          ctx,
          p,
          tx,
          ty - 0.2 * target.k,
          target.k,
          th.splash,
          th.splashKind,
          th.kind,
          reduced,
        );
      }
    }
  }

  /** How high a thrown bottle arcs: about a metre, but its top stays inside the scene. */
  private arcLift(fromY: number, k: number): number {
    return Math.max(0.2 * k, Math.min(1.0 * k, fromY - this.h * 0.1));
  }

  /** Slipstream: a faint rider just ahead, as if riding in their wheel. */
  private slipstreamGhost(f: SceneFrame, slope: number): void {
    const x = this.riderX + 1.85 * this.px;
    const scale = this.place(x, Math.min(0.6, f.lateral + 0.1), slope, this.tmp) * 0.99;
    computePose(this.ghostPose, f.crank + 1.1, 0, f.tuck, Math.atan(slope));
    this.ctx.globalAlpha = 0.32;
    this.rider(
      this.tmp.x,
      this.tmp.y,
      scale,
      slope,
      0,
      this.ghostPose,
      f.wheel,
      this.ghost!,
      false,
    );
    this.ctx.globalAlpha = 1;
  }

  // ─────────── riders ───────────

  /** Screen-space position and scale of a rider at lateral `lat` and screen x. */
  private place(x: number, lat: number, slope: number, out: Point): number {
    out.x = x;
    out.y = this.roadY(x, slope) + lat * this.halfDepth * 0.62;
    return 1 + lat * 0.06;
  }

  private localRider(f: SceneFrame, slope: number): void {
    const scale = this.place(this.riderX, f.lateral, slope, this.tmp);
    const c = f.powerUps?.rumble;
    const damage: Damage | null =
      c && (c.hit === 'tacks' || c.hit === 'chain')
        ? {
            flat: c.hit === 'tacks',
            chain: c.hit === 'chain',
            timeS: f.powerUps!.timeS,
            reduced: f.reducedMotion,
          }
        : null;
    // Chain off: the legs spin freely, faster than the road would turn them.
    const crank = damage?.chain && !f.reducedMotion ? f.crank + damage.timeS * 11 : f.crank;
    computePose(this.pose, crank, f.standing, f.tuck, Math.atan(slope));
    const lean = f.reducedMotion ? 0 : leanFor(f.lateralVel);
    this.shadow(this.tmp.x, this.tmp.y, scale, lean, slope);
    this.rider(
      this.tmp.x,
      this.tmp.y,
      scale,
      slope,
      lean,
      this.pose,
      f.wheel,
      this.local!,
      true,
      damage,
    );
  }

  private others(f: SceneFrame, slope: number, lat: number): void {
    const ctx = this.ctx;
    const p = this.pal!;
    const ahead = this.w - this.riderX - this.px * 0.9;
    const behind = this.riderX - this.px * 0.9;
    for (const o of f.others) {
      if (!o.onRoad) continue;
      const x = this.riderX + o.offset * (o.offset >= 0 ? ahead : behind);
      const scale = this.place(x, lat, slope, this.tmp) * 0.94;
      const angles = f.otherAngles.get(o.id);
      computePose(this.ghostPose, angles?.crank ?? 0, 0, 0, Math.atan(slope));
      ctx.globalAlpha = o.ghost ? 0.38 : o.stale ? 0.45 : 0.9;
      this.rider(
        this.tmp.x,
        this.tmp.y,
        scale,
        slope,
        0,
        this.ghostPose,
        angles?.wheel ?? 0,
        this.ghost!,
        false,
      );
      ctx.globalAlpha = 1;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (o.fx) {
        const k = this.px * scale;
        drawRiderFx(
          ctx,
          p,
          o.fx,
          this.tmp.x + 0.05 * k,
          this.tmp.y - 0.85 * k,
          k,
          f.powerUps?.timeS ?? 0,
          f.reducedMotion,
        );
      }
      // Name above the head.
      ctx.font = this.nameFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = p.ink2;
      const headY = this.tmp.y - 1.78 * this.px * scale;
      ctx.fillText(o.name, this.tmp.x, headY);
    }
  }

  private shadow(x: number, y: number, scale: number, lean: number, slope: number): void {
    const ctx = this.ctx;
    const k = this.px * scale;
    const dx = lean * k * 0.4;
    ctx.fillStyle = this.pal!.shadow;
    ctx.beginPath();
    ctx.ellipse(
      x + dx,
      y - dx * slope + 0.02 * k,
      0.95 * k,
      Math.max(1.5, 0.05 * k),
      -Math.atan(slope),
      0,
      TAU,
    );
    ctx.fill();
  }

  /**
   * Bike and rider in model space (metres, y up), placed at contact point
   * (x, y), tilted with the road and leaning towards (+) or away from the viewer.
   */
  private rider(
    x: number,
    y: number,
    scale: number,
    slope: number,
    lean: number,
    pose: Pose,
    wheel: number,
    c: Colours,
    detailed: boolean,
    damage: Damage | null = null,
  ): void {
    const ctx = this.ctx;
    const k = this.px * scale * this.dpr;
    ctx.setTransform(k, 0, 0, -k, x * this.dpr, y * this.dpr);
    ctx.rotate(Math.atan(slope));
    if (damage?.flat) {
      // A flat rear tyre: the bike sags at the back (about the front contact) and wobbles.
      const wobble = damage.reduced ? 0 : Math.sin(damage.timeS * 7.5) * 0.012;
      ctx.translate(BIKE.front.x, 0);
      ctx.rotate(0.034 + wobble);
      ctx.translate(-BIKE.front.x, 0);
    }
    // Leaning towards the viewer foreshortens and lowers the figure a little.
    ctx.scale(1, Math.cos(lean) - 0.35 * Math.sin(lean));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Far side: arm, leg, crank.
    this.limb(pose.shoulder, pose.elbow, 0.042, 0.036, c.jerseyFar);
    this.limb(pose.elbow, pose.hand, 0.034, 0.028, c.skinFar);
    this.leg(1, pose, c.shortsFar, c.skinFar, c.frameFar);
    this.crankArm(pose.pedal[1]!, c.frameFar);

    // Wheels.
    this.wheel(BIKE.rear, wheel, c, detailed, damage?.flat === true);
    this.wheel(BIKE.front, wheel, c, detailed);

    // Drivetrain.
    ctx.strokeStyle = c.frameFar;
    ctx.lineWidth = 0.008;
    ctx.beginPath();
    if (damage?.chain) {
      // Off the chainring: the chain hangs from the cassette in a loose, flapping loop.
      const flap = damage.reduced ? 0.3 : Math.sin(damage.timeS * 6.5);
      ctx.lineWidth = 0.012;
      ctx.moveTo(BIKE.rear.x, BIKE.rear.y + BIKE.cassetteRadius);
      ctx.bezierCurveTo(
        BIKE.rear.x + 0.2,
        BIKE.rear.y + 0.02,
        BIKE.bb.x - 0.05 + flap * 0.05,
        0.05 + flap * 0.02,
        BIKE.bb.x - 0.12 + flap * 0.04,
        0.07,
      );
      ctx.moveTo(BIKE.rear.x, BIKE.rear.y - BIKE.cassetteRadius);
      ctx.quadraticCurveTo(
        BIKE.rear.x + 0.12,
        0.04 - flap * 0.02,
        BIKE.bb.x - 0.12 + flap * 0.04,
        0.07,
      );
    } else {
      ctx.moveTo(BIKE.bb.x, BIKE.bb.y + BIKE.chainringRadius);
      ctx.lineTo(BIKE.rear.x, BIKE.rear.y + BIKE.cassetteRadius);
      ctx.moveTo(BIKE.bb.x, BIKE.bb.y - BIKE.chainringRadius);
      ctx.lineTo(BIKE.rear.x, BIKE.rear.y - BIKE.cassetteRadius);
    }
    ctx.stroke();
    ctx.lineWidth = 0.014;
    ctx.beginPath();
    ctx.arc(BIKE.rear.x, BIKE.rear.y, BIKE.cassetteRadius, 0, TAU);
    ctx.stroke();

    this.frame(c);
    if (detailed) this.bottle(c);

    ctx.strokeStyle = c.frame;
    ctx.lineWidth = 0.016;
    ctx.beginPath();
    ctx.arc(BIKE.bb.x, BIKE.bb.y, BIKE.chainringRadius, 0, TAU);
    ctx.stroke();

    // Near side: crank, leg, torso, head, arm.
    this.crankArm(pose.pedal[0]!, c.frame);
    this.leg(0, pose, c.shorts, c.skin, c.shoe);
    this.torso(pose, c);
    this.head(pose, c, detailed);
    this.limb(pose.shoulder, pose.elbow, 0.05, 0.042, c.jersey);
    this.limb(pose.elbow, pose.hand, 0.04, 0.033, c.skin);
    ctx.fillStyle = c.shoe;
    ctx.beginPath();
    ctx.arc(pose.hand.x, pose.hand.y, 0.034, 0, TAU);
    ctx.fill();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** A tapered capsule from a (radius ra) to b (radius rb). */
  private limb(a: Point, b: Point, ra: number, rb: number, colour: string): void {
    const ctx = this.ctx;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(a.x, a.y, ra, ang + Math.PI / 2, ang + (3 * Math.PI) / 2);
    ctx.arc(b.x, b.y, rb, ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  }

  private leg(i: 0 | 1, pose: Pose, shorts: string, skin: string, shoe: string): void {
    const knee = pose.knee[i]!;
    const ankle = pose.ankle[i]!;
    const pedal = pose.pedal[i]!;
    this.limb(pose.hip, knee, 0.075, 0.052, shorts);
    // Shorts end above the knee; the leg below is skin.
    const t = 0.72;
    this.tmp2.x = pose.hip.x + (knee.x - pose.hip.x) * t;
    this.tmp2.y = pose.hip.y + (knee.y - pose.hip.y) * t;
    this.limb(this.tmp2, knee, 0.05, 0.046, skin);
    this.limb(knee, ankle, 0.046, 0.03, skin);
    // Shoe: heel behind the ankle to the toe in front of the pedal.
    const dx = pedal.x - ankle.x;
    const dy = pedal.y - ankle.y;
    const len = Math.hypot(dx, dy) || 1;
    this.tmp2.x = ankle.x - (dx / len) * 0.035;
    this.tmp2.y = ankle.y - (dy / len) * 0.035;
    this.tmp3.x = pedal.x + (dx / len) * 0.085;
    this.tmp3.y = pedal.y + (dy / len) * 0.085;
    this.limb(this.tmp2, this.tmp3, 0.036, 0.026, shoe);
  }

  private readonly tmp2: Point = { x: 0, y: 0 };
  private readonly tmp3: Point = { x: 0, y: 0 };

  private crankArm(pedal: Point, colour: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 0.026;
    ctx.beginPath();
    ctx.moveTo(BIKE.bb.x, BIKE.bb.y);
    ctx.lineTo(pedal.x, pedal.y);
    ctx.stroke();
    ctx.lineWidth = 0.02;
    ctx.beginPath();
    ctx.moveTo(pedal.x - 0.045, pedal.y);
    ctx.lineTo(pedal.x + 0.045, pedal.y);
    ctx.stroke();
  }

  private wheel(at: Point, angle: number, c: Colours, detailed: boolean, flat = false): void {
    const ctx = this.ctx;
    const r = BIKE.wheelRadius;
    // Tyre (flat: squashed and bulging where it meets the road).
    ctx.strokeStyle = c.tyre;
    ctx.lineWidth = flat ? 0.036 : 0.028;
    ctx.beginPath();
    if (flat) {
      ctx.arc(at.x, at.y, r - 0.014, -Math.PI * 0.18, Math.PI * 1.18);
      ctx.bezierCurveTo(
        at.x - r * 1.05,
        at.y - r * 0.78,
        at.x - r * 0.4,
        at.y - r * 0.9,
        at.x,
        at.y - r * 0.9,
      );
      ctx.bezierCurveTo(
        at.x + r * 0.4,
        at.y - r * 0.9,
        at.x + r * 1.05,
        at.y - r * 0.78,
        at.x + Math.cos(-Math.PI * 0.18) * (r - 0.014),
        at.y + Math.sin(-Math.PI * 0.18) * (r - 0.014),
      );
    } else ctx.arc(at.x, at.y, r - 0.014, 0, TAU);
    ctx.stroke();
    // Deep rim.
    ctx.lineWidth = 0.022;
    ctx.globalAlpha *= 0.55;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r - 0.05, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha /= 0.55;
    // Spokes (16), rotating clockwise when moving right.
    if (detailed) {
      ctx.strokeStyle = c.spokes;
      ctx.lineWidth = 0.0045;
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = -angle + (i * TAU) / 16;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // Tangential lacing: offset at the hub.
        const off = i % 2 === 0 ? 0.35 : -0.35;
        ctx.moveTo(at.x + Math.cos(a + off) * 0.022, at.y + Math.sin(a + off) * 0.022);
        ctx.lineTo(at.x + ca * (r - 0.062), at.y + sa * (r - 0.062));
      }
      ctx.stroke();
      // A valve mark on the rim makes rotation readable at any speed.
      ctx.strokeStyle = c.tyre;
      ctx.lineWidth = 0.022;
      ctx.beginPath();
      const v = -angle;
      ctx.arc(at.x, at.y, r - 0.05, v - 0.16, v + 0.16);
      ctx.stroke();
    }
    ctx.fillStyle = c.frame;
    ctx.beginPath();
    ctx.arc(at.x, at.y, 0.024, 0, TAU);
    ctx.fill();
  }

  private frame(c: Colours): void {
    const ctx = this.ctx;
    const b = BIKE;
    ctx.strokeStyle = c.frame;
    // Stays.
    ctx.lineWidth = 0.018;
    ctx.beginPath();
    ctx.moveTo(b.rear.x, b.rear.y);
    ctx.lineTo(b.bb.x, b.bb.y);
    ctx.moveTo(b.rear.x, b.rear.y);
    ctx.lineTo(b.seatStayTop.x, b.seatStayTop.y);
    ctx.stroke();
    // Main triangle.
    ctx.lineWidth = 0.034;
    ctx.beginPath();
    ctx.moveTo(b.bb.x, b.bb.y);
    ctx.lineTo(b.seatTop.x, b.seatTop.y);
    ctx.lineTo(b.headTop.x, b.headTop.y - 0.02);
    ctx.stroke();
    ctx.lineWidth = 0.042;
    ctx.beginPath();
    ctx.moveTo(b.bb.x, b.bb.y);
    ctx.lineTo(b.headBottom.x, b.headBottom.y);
    ctx.stroke();
    // Head tube.
    ctx.lineWidth = 0.046;
    ctx.beginPath();
    ctx.moveTo(b.headBottom.x, b.headBottom.y);
    ctx.lineTo(b.headTop.x, b.headTop.y);
    ctx.stroke();
    // Fork with a gentle rake.
    ctx.lineWidth = 0.026;
    ctx.beginPath();
    ctx.moveTo(b.crown.x, b.crown.y);
    ctx.quadraticCurveTo(b.front.x - 0.05, (b.crown.y + b.front.y) / 2, b.front.x, b.front.y);
    ctx.stroke();
    // Seatpost and saddle.
    ctx.lineWidth = 0.022;
    ctx.beginPath();
    ctx.moveTo(b.seatTop.x, b.seatTop.y);
    ctx.lineTo(b.saddle.x, b.saddle.y);
    ctx.stroke();
    ctx.fillStyle = c.frame;
    ctx.beginPath();
    ctx.moveTo(b.saddle.x - 0.13, b.saddle.y + 0.03);
    ctx.quadraticCurveTo(
      b.saddle.x - 0.02,
      b.saddle.y + 0.005,
      b.saddle.x + 0.12,
      b.saddle.y + 0.012,
    );
    ctx.lineTo(b.saddle.x + 0.12, b.saddle.y - 0.004);
    ctx.quadraticCurveTo(b.saddle.x - 0.03, b.saddle.y - 0.02, b.saddle.x - 0.12, b.saddle.y);
    ctx.closePath();
    ctx.fill();
    // Stem and drop bar.
    ctx.lineWidth = 0.028;
    ctx.beginPath();
    ctx.moveTo(b.stemBase.x, b.stemBase.y);
    ctx.lineTo(b.stemEnd.x, b.stemEnd.y);
    ctx.stroke();
    ctx.lineWidth = 0.024;
    ctx.beginPath();
    ctx.moveTo(b.stemEnd.x, b.stemEnd.y);
    ctx.lineTo(b.stemEnd.x + 0.055, b.stemEnd.y + 0.004);
    ctx.bezierCurveTo(
      b.stemEnd.x + 0.15,
      b.stemEnd.y,
      b.stemEnd.x + 0.12,
      b.drops.y - 0.03,
      b.drops.x,
      b.drops.y,
    );
    ctx.stroke();
    // Brake hood.
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(b.hoods.x - 0.03, b.hoods.y - 0.012);
    ctx.lineTo(b.hoods.x + 0.012, b.hoods.y + 0.004);
    ctx.stroke();
  }

  /** A bottle on the down tube. */
  private bottle(c: Colours): void {
    const ctx = this.ctx;
    const b = BIKE;
    const dx = b.headBottom.x - b.bb.x;
    const dy = b.headBottom.y - b.bb.y;
    const len = Math.hypot(dx, dy);
    ctx.save();
    ctx.translate(b.bb.x + dx * 0.28, b.bb.y + dy * 0.28);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = c.skinFar;
    ctx.beginPath();
    ctx.roundRect(0, 0.026, len * 0.36, 0.068, 0.02);
    ctx.fill();
    ctx.fillStyle = c.frameFar;
    ctx.beginPath();
    ctx.roundRect(len * 0.36 - 0.005, 0.042, 0.03, 0.036, 0.008);
    ctx.fill();
    ctx.restore();
  }

  private torso(pose: Pose, c: Colours): void {
    const ctx = this.ctx;
    const { hip, shoulder } = pose;
    // Shorts over the hip.
    ctx.fillStyle = c.shorts;
    ctx.beginPath();
    ctx.arc(hip.x, hip.y, 0.085, 0, TAU);
    ctx.fill();
    // Jersey: a bean shape with an arched back and a straighter chest.
    const dx = shoulder.x - hip.x;
    const dy = shoulder.y - hip.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // n points to the back (up and rearwards of the torso axis).
    const nx = -uy;
    const ny = ux;
    const bx = hip.x + ux * 0.02;
    const by = hip.y + uy * 0.02;
    ctx.fillStyle = c.jersey;
    ctx.beginPath();
    ctx.moveTo(bx + nx * 0.075, by + ny * 0.075);
    // Back.
    ctx.quadraticCurveTo(
      (bx + shoulder.x) / 2 + nx * 0.15,
      (by + shoulder.y) / 2 + ny * 0.15,
      shoulder.x + nx * 0.06,
      shoulder.y + ny * 0.06,
    );
    // Round shoulder.
    ctx.quadraticCurveTo(
      shoulder.x + ux * 0.1 + nx * 0.01,
      shoulder.y + uy * 0.1 + ny * 0.01,
      shoulder.x - nx * 0.065 + ux * 0.01,
      shoulder.y - ny * 0.065 + uy * 0.01,
    );
    // Chest and belly.
    ctx.quadraticCurveTo(
      (bx + shoulder.x) / 2 - nx * 0.07,
      (by + shoulder.y) / 2 - ny * 0.07,
      bx - nx * 0.07,
      by - ny * 0.07,
    );
    ctx.quadraticCurveTo(bx - ux * 0.05, by - uy * 0.05, bx + nx * 0.075, by + ny * 0.075);
    ctx.closePath();
    ctx.fill();
  }

  private head(pose: Pose, c: Colours, detailed: boolean): void {
    const ctx = this.ctx;
    const { shoulder, head } = pose;
    // Neck.
    this.limb(shoulder, head, 0.042, 0.036, c.skin);
    const r = BODY.headRadius;
    ctx.fillStyle = c.skin;
    ctx.beginPath();
    ctx.arc(head.x, head.y, r * 0.92, 0, TAU);
    ctx.fill();
    // Helmet: an aero shell over the top and back, the tail sweeping down-back.
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(-0.12 - pose.torsoAngle * 0.25);
    ctx.fillStyle = c.helmet;
    ctx.beginPath();
    ctx.moveTo(r * 1.12, r * 0.18);
    ctx.bezierCurveTo(r * 1.0, r * 1.15, -r * 0.9, r * 1.25, -r * 1.55, r * 0.15);
    ctx.quadraticCurveTo(-r * 1.6, -r * 0.12, -r * 1.2, -r * 0.05);
    ctx.quadraticCurveTo(-r * 0.2, r * 0.25, r * 1.12, r * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (detailed) {
      // Glasses.
      ctx.fillStyle = c.helmet;
      ctx.beginPath();
      ctx.ellipse(head.x + r * 0.7, head.y - r * 0.05, r * 0.32, r * 0.15, -0.1, 0, TAU);
      ctx.fill();
    }
  }
}

// ───────────────────────── profile strip ─────────────────────────

export interface ProfileFrame {
  /** Oldest → newest stored points. */
  length: number;
  distAt: (i: number) => number;
  elevAt: (i: number) => number;
  currentDistanceM: number;
  currentElevationM: number;
  gradePercent: number;
  others: readonly PlacedRider[];
  climbedM: number;
}

/** Metres of history (at most) and of projected slope shown on the strip. */
export const PROFILE_BACK_M = 1500;
export const PROFILE_MIN_BACK_M = 400;
export const PROFILE_AHEAD_M = 250;

/** Width of the history window for the distance ridden so far. */
export function profileWindow(distanceM: number): number {
  return Math.min(PROFILE_BACK_M, Math.max(PROFILE_MIN_BACK_M, Math.ceil(distanceM / 100) * 100));
}

export class ProfileRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private pal: ScenePalette | null = null;
  private font = '';
  private fontPx = 12;
  private family = 'system-ui, sans-serif';

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.w = Math.max(1, Math.round(cssW));
    this.h = Math.max(1, Math.round(cssH));
    this.dpr = dpr;
    const bw = Math.max(1, Math.round(this.w * dpr));
    const bh = Math.max(1, Math.round(this.h * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.setFont();
  }

  setPalette(p: ScenePalette, family: string): void {
    this.pal = p;
    this.family = family || this.family;
    this.setFont();
  }

  private setFont(): void {
    this.fontPx = Math.round(Math.max(10, Math.min(14, this.h * 0.24)));
    this.font = `600 ${this.fontPx}px ${this.family}`;
  }

  draw(f: ProfileFrame): void {
    const ctx = this.ctx;
    const p = this.pal;
    if (!p || this.w <= 1) return;
    const { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const now = f.currentDistanceM;
    // Early in a ride the window grows with it, so the strip is never mostly empty.
    const back = profileWindow(now);
    const x0 = now - back;
    const x1 = now + PROFILE_AHEAD_M;
    const sx = (dist: number): number => ((dist - x0) / (x1 - x0)) * w;
    const aheadElev = f.currentElevationM + (PROFILE_AHEAD_M * f.gradePercent) / 100;

    // Vertical range over what is visible.
    let lo = Math.min(f.currentElevationM, aheadElev);
    let hi = Math.max(f.currentElevationM, aheadElev);
    let firstVisible = f.length;
    for (let i = 0; i < f.length; i++) {
      if (f.distAt(i) < x0) continue;
      if (firstVisible === f.length) firstVisible = Math.max(0, i - 1);
      const e = f.elevAt(i);
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
    const span = Math.max(hi - lo, 24);
    const mid = (lo + hi) / 2;
    // Keep the plot clear of the caption line.
    const top = Math.max(h * 0.3, this.fontPx + 8);
    const bottom = h - 3;
    const sy = (e: number): number => bottom - ((e - (mid - span / 2)) / span) * (bottom - top);

    const nowX = sx(now);
    const nowY = sy(f.currentElevationM);

    // Ridden: filled area and line.
    if (firstVisible < f.length) {
      ctx.beginPath();
      ctx.moveTo(Math.max(0, sx(f.distAt(firstVisible))), h);
      for (let i = firstVisible; i < f.length; i++) {
        ctx.lineTo(Math.max(0, sx(f.distAt(i))), sy(f.elevAt(i)));
      }
      ctx.lineTo(nowX, nowY);
      ctx.lineTo(nowX, h);
      ctx.closePath();
      ctx.fillStyle = p.profileFill;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(Math.max(0, sx(f.distAt(firstVisible))), sy(f.elevAt(firstVisible)));
      for (let i = firstVisible + 1; i < f.length; i++) {
        ctx.lineTo(Math.max(0, sx(f.distAt(i))), sy(f.elevAt(i)));
      }
      ctx.lineTo(nowX, nowY);
      ctx.strokeStyle = p.profileLine;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    // Ahead: unknown, so only the current slope continued, dashed.
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = p.ink3;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(nowX, nowY);
    ctx.lineTo(sx(x1), sy(aheadElev));
    ctx.stroke();
    ctx.setLineDash([]);

    // Other riders.
    for (const o of f.others) {
      const d = now + o.gapM;
      const clamped = Math.min(x1, Math.max(x0, d));
      const x = Math.min(w - 4, Math.max(4, sx(clamped)));
      // Elevation unknown for others ahead: put them on the line (or ahead slope).
      let e = f.currentElevationM;
      if (d > now) e = f.currentElevationM + ((Math.min(d, x1) - now) * f.gradePercent) / 100;
      else e = this.elevationAt(f, d, firstVisible);
      ctx.fillStyle = o.stale ? p.ink3 : p.ink2;
      ctx.beginPath();
      ctx.arc(x, sy(e), 3, 0, TAU);
      ctx.fill();
    }

    // Now marker.
    ctx.strokeStyle = p.roadEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(nowX + 0.5, top - 4);
    ctx.lineTo(nowX + 0.5, h);
    ctx.stroke();
    ctx.fillStyle = p.surface;
    ctx.beginPath();
    ctx.arc(nowX, nowY, 4.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = p.accent;
    ctx.beginPath();
    ctx.arc(nowX, nowY, 3.2, 0, TAU);
    ctx.fill();

    // Caption.
    ctx.font = this.font;
    ctx.fillStyle = p.ink2;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const climbed = Math.round(f.climbedM);
    ctx.fillText(`Last ${(back / 1000).toFixed(1)} km · ↑ ${climbed} m`, 2, 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = p.ink3;
    ctx.fillText('ahead unknown', w - 2, 2);
  }

  private elevationAt(f: ProfileFrame, d: number, from: number): number {
    for (let i = Math.max(0, from); i < f.length; i++) {
      if (f.distAt(i) >= d) return f.elevAt(i);
    }
    return f.currentElevationM;
  }
}
