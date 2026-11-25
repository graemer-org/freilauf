/**
 * Card Race effects drawn on a rider, shared by both scenes (docs/card-race.md): Headwind's gust
 * lines arriving from ahead, the Shield's calm bubble, the faint protection ring with its
 * countdown, Fog's haze, and a short pulse when an attack lands or is blocked. Plain canvas
 * calls; positions and sizes come from the renderer. With reduced motion everything is still.
 */
import type { ScenePalette } from './palette';
import type { RiderFx } from './powerUpScene';
import { hash01 } from './sceneMath';

const TAU = Math.PI * 2;

/** The shield: a soft bubble around the rider, a thin rim and a small highlight. */
export function drawShield(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  rx: number,
  ry: number,
  strength = 1,
): void {
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.fillStyle = p.guardFill;
  ctx.strokeStyle = p.guard;
  ctx.lineWidth = Math.max(1.2, rx * 0.035);
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = strength * 0.55;
  ctx.lineWidth = Math.max(1, rx * 0.05);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.ellipse(x, y, rx * 0.8, ry * 0.8, 0, Math.PI * 1.12, Math.PI * 1.42);
  ctx.stroke();
  ctx.restore();
}

/** Protection after a hit: a faint dotted ring, and the part still left as a calm arc. */
export function drawProtection(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  rx: number,
  ry: number,
  left: number,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = p.guardFaint;
  ctx.lineWidth = Math.max(1, rx * 0.022);
  ctx.setLineDash([Math.max(2, rx * 0.05), Math.max(4, rx * 0.09)]);
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  if (left > 0) {
    ctx.strokeStyle = p.guard;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = Math.max(1.5, rx * 0.035);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, left));
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Headwind in the side view: gust lines arriving from the right (ahead) and curling off the
 * rider's front. `k` is pixels per metre at the rider.
 */
export function drawGustsSide(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  k: number,
  timeS: number,
  reduced: boolean,
  count = 6,
): void {
  ctx.save();
  ctx.strokeStyle = p.attack;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.2, 0.017 * k);
  const front = x + 0.45 * k;
  for (let i = 0; i < count; i++) {
    const dy = (i / Math.max(1, count - 1) - 0.55) * 0.95 * k;
    const phase = reduced
      ? 0.2 + hash01(i, 41) * 0.6
      : (timeS * (0.8 + hash01(i, 42) * 0.4) + hash01(i, 43)) % 1;
    const len = (0.3 + hash01(i, 44) * 0.22) * k;
    // From about a bike length ahead to the rider's front edge.
    const head = front + (1 - phase) * 1.3 * k;
    const wave = 0.035 * k;
    ctx.globalAlpha = reduced ? 0.7 : Math.min(1, phase * 4) * Math.min(1, (1 - phase) * 5) * 0.8;
    ctx.beginPath();
    ctx.moveTo(head + len, y + dy);
    ctx.bezierCurveTo(
      head + len * 0.66,
      y + dy - wave,
      head + len * 0.33,
      y + dy + wave,
      head,
      y + dy,
    );
    // The far end curls: the signature of a gust.
    ctx.moveTo(head + len, y + dy);
    ctx.arc(head + len, y + dy - 0.06 * k, 0.06 * k, Math.PI / 2, -Math.PI / 2, true);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Headwind seen from behind: gust lines coming out of the distance (the vanishing point
 * `vx, vy`) towards the rider at (x, y), parting around them. `ppm` at the rider.
 */
export function drawGustsRoad(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  ppm: number,
  timeS: number,
  reduced: boolean,
  count = 10,
): void {
  ctx.save();
  ctx.strokeStyle = p.attack;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.2, 0.022 * ppm);
  for (let i = 0; i < count; i++) {
    // Air arriving head-on parts around the rider: each gust leaves the middle for one side.
    const side = i % 2 === 0 ? -1 : 1;
    const level = (Math.floor(i / 2) / Math.max(1, Math.ceil(count / 2) - 1) - 0.5) * 0.9 * ppm;
    const phase = reduced
      ? 0.3 + hash01(i, 53) * 0.5
      : (timeS * (0.75 + hash01(i, 54) * 0.4) + hash01(i, 55)) % 1;
    const x0 = x + side * (0.12 + phase * 0.75) * ppm;
    const len = (0.22 + hash01(i, 56) * 0.16) * ppm;
    const y0 = y + level - (1 - phase) * 0.12 * ppm;
    const wave = 0.03 * ppm;
    ctx.globalAlpha = reduced ? 0.7 : Math.min(1, phase * 5) * Math.min(1, (1 - phase) * 4) * 0.85;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(
      x0 + side * len * 0.33,
      y0 - wave,
      x0 + side * len * 0.66,
      y0 + wave,
      x0 + side * len,
      y0 + 0.04 * ppm,
    );
    ctx.stroke();
  }
  ctx.restore();
}

/** Fog on this rider: a soft haze over the whole view, thicker towards the distance. */
export function drawHaze(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  w: number,
  h: number,
  horizonY: number,
  strength = 1,
): void {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, strength));
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, p.haze);
  g.addColorStop(Math.max(0.05, Math.min(0.95, horizonY / Math.max(1, h))), p.haze);
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Fog on another rider: a small soft cloud over their head. */
export function drawFogPuff(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  r: number,
): void {
  ctx.save();
  ctx.fillStyle = p.haze;
  for (let i = 0; i < 4; i++) {
    const cx = x + (i - 1.5) * r * 0.55;
    const cy = y - (i === 1 || i === 2 ? r * 0.25 : 0);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (i === 1 || i === 2 ? 0.55 : 0.42), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** A hit (attack colour) or a blocked attack (shield colour): a ring that opens and fades. */
export function drawPulse(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  r: number,
  t: number,
  kind: 'hit' | 'blocked',
  reduced: boolean,
): void {
  ctx.save();
  ctx.globalAlpha = reduced ? 0.6 : 1 - t;
  ctx.strokeStyle = kind === 'hit' ? p.attack : p.guard;
  ctx.lineWidth = Math.max(1.5, r * 0.05);
  const rr = reduced ? r * 1.1 : r * (0.8 + t * 0.6);
  ctx.beginPath();
  ctx.ellipse(x, y, rr, rr * 0.92, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/**
 * Effects on another rider (from their broadcast), centred at (x, y) with radius `r` (about
 * the rider's size). `side`: the side view (gusts horizontal) or from behind (gusts on rays).
 */
export function drawRiderFx(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  fx: RiderFx,
  x: number,
  y: number,
  r: number,
  timeS: number,
  reduced: boolean,
  view: 'side' | 'road',
): void {
  if (fx.attack === 'headwind') {
    if (view === 'side') drawGustsSide(ctx, p, x, y, r, timeS, reduced, 5);
    else drawGustsRoad(ctx, p, x, y, r, timeS, reduced, 8);
  }
  if (fx.attack === 'fog') drawFogPuff(ctx, p, x, y - r * 1.05, r * 0.45);
  if (fx.shield) drawShield(ctx, p, x, y, r * 1.05, r * 0.95, 0.9);
  if (fx.protected) drawProtection(ctx, p, x, y, r * 1.1, r * 1.0, 0);
}
