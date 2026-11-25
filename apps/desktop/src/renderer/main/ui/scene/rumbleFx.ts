/**
 * Freilauf Rumble drawn in the ride scenes, shared by both renderers (docs/rumble.md): the feed
 * bag at the roadside, a water bottle (a cyclist's bidon) in flight, the mud puddle on the road,
 * a small swarm of hornets, the rain cape, the faint protection ring with its countdown, and the
 * splash of a hit — water, mud, or a buzz. Plain canvas calls; positions and sizes come from the
 * renderer. With reduced motion nothing moves: every cue is drawn still.
 */
import type { ScenePalette } from './palette';
import type { HitKind, RiderFx } from './powerUpScene';
import { hash01 } from './sceneMath';

const TAU = Math.PI * 2;

/**
 * The rain cape: a soft, clear bubble around the rider with a few raindrops beading on its
 * upper rim (it keeps the next hit off).
 */
export function drawCape(
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
  // A highlight, as on a clear rain cape.
  ctx.globalAlpha = strength * 0.55;
  ctx.lineWidth = Math.max(1, rx * 0.05);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.ellipse(x, y, rx * 0.8, ry * 0.8, 0, Math.PI * 1.12, Math.PI * 1.42);
  ctx.stroke();
  // Raindrops beading on the top of the cape.
  ctx.globalAlpha = strength * 0.9;
  ctx.fillStyle = p.guard;
  for (let i = 0; i < 5; i++) {
    const a = Math.PI * (1.2 + i * 0.15);
    const dx = x + Math.cos(a) * rx;
    const dy = y + Math.sin(a) * ry;
    drawDrop(ctx, dx, dy, Math.max(1.4, rx * 0.045));
  }
  ctx.restore();
}

/** A small drop shape (round bottom, pointed top) in the current fill. */
function drawDrop(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r * 2);
  ctx.quadraticCurveTo(x + r * 1.05, y - r * 0.4, x + r, y);
  ctx.arc(x, y, r, 0, Math.PI);
  ctx.quadraticCurveTo(x - r * 1.05, y - r * 0.4, x, y - r * 2);
  ctx.fill();
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
 * A cyclist's water bottle (bidon), `size` px tall, centred at (x, y), turned by `angle`
 * (radians; it tumbles in flight): a soft body in the water colour, two grip bands, a dark cap
 * with its nozzle.
 */
export function drawBottle(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  size: number,
  angle = 0,
): void {
  const h = Math.max(6, size);
  const w = h * 0.42;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Body.
  ctx.fillStyle = p.surface;
  ctx.strokeStyle = p.water;
  ctx.lineWidth = Math.max(1.2, h * 0.07);
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h * 0.32, w, h * 0.8, w * 0.32);
  ctx.fill();
  ctx.fillStyle = p.waterFaint;
  ctx.fill();
  ctx.stroke();
  // Grip bands.
  ctx.lineWidth = Math.max(1, h * 0.05);
  ctx.beginPath();
  ctx.moveTo(-w / 2, h * 0.05);
  ctx.lineTo(w / 2, h * 0.05);
  ctx.moveTo(-w / 2, h * 0.22);
  ctx.lineTo(w / 2, h * 0.22);
  ctx.stroke();
  // Cap and nozzle.
  ctx.fillStyle = p.ink;
  ctx.beginPath();
  ctx.roundRect(-w * 0.38, -h * 0.46, w * 0.76, h * 0.16, h * 0.04);
  ctx.fill();
  ctx.fillRect(-w * 0.1, -h * 0.55, w * 0.2, h * 0.1);
  ctx.restore();
}

/** A few drops of water running off a rider who was hit by a bottle. `k`: px per metre. */
export function drawDrips(
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
  ctx.fillStyle = p.water;
  for (let i = 0; i < count; i++) {
    const dx = (hash01(i, 61) - 0.5) * 0.7 * k;
    const phase = reduced
      ? hash01(i, 62) * 0.8
      : (timeS * (0.9 + hash01(i, 63) * 0.5) + hash01(i, 64)) % 1;
    const dy = (-0.35 + phase * 0.9) * k;
    ctx.globalAlpha = reduced ? 0.75 : Math.min(1, (1 - phase) * 3) * 0.85;
    drawDrop(ctx, x + dx, y + dy, Math.max(1.3, 0.028 * k));
  }
  ctx.restore();
}

/** Mud spattered over the lower half of a rider who rode through a puddle (still). */
export function drawMudSpatter(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  k: number,
  count = 11,
): void {
  ctx.save();
  ctx.fillStyle = p.mud;
  for (let i = 0; i < count; i++) {
    const dx = (hash01(i, 71) - 0.5) * 0.95 * k;
    const dy = (0.1 + hash01(i, 72) * 0.55) * k;
    const r = Math.max(1.1, (0.018 + hash01(i, 73) * 0.03) * k);
    ctx.globalAlpha = 0.65 + hash01(i, 74) * 0.3;
    ctx.beginPath();
    ctx.ellipse(x + dx, y + dy, r * 1.3, r, hash01(i, 75) * Math.PI, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * A small swarm of hornets around (x, y) within radius `r`: striped amber bodies with a light
 * wing each, circling (still with reduced motion). `count` hornets.
 */
export function drawSwarm(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  r: number,
  timeS: number,
  reduced: boolean,
  count = 7,
): void {
  const size = Math.max(2.2, r * 0.13);
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const speed = 1.4 + hash01(i, 81) * 1.2;
    const a = (reduced ? 0 : timeS * speed * (hash01(i, 82) < 0.5 ? 1 : -1)) + hash01(i, 83) * TAU;
    const rr = r * (0.45 + hash01(i, 84) * 0.55);
    const bob = reduced ? 0 : Math.sin(timeS * 9 + i) * size * 0.4;
    const hx = x + Math.cos(a) * rr;
    const hy = y + Math.sin(a) * rr * 0.6 + bob;
    const dir = reduced ? 0 : Math.cos(a) > 0 ? 1 : -1;
    // Wing: a light, see-through oval above the body.
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = p.surface;
    ctx.strokeStyle = p.ink3;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.ellipse(
      hx - dir * size * 0.15,
      hy - size * 0.7,
      size * 0.55,
      size * 0.35,
      -0.5 * dir,
      0,
      TAU,
    );
    ctx.fill();
    ctx.stroke();
    // Body: amber with a dark stripe.
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.hornet;
    ctx.beginPath();
    ctx.ellipse(hx, hy, size, size * 0.6, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = p.ink;
    ctx.lineWidth = Math.max(0.9, size * 0.28);
    ctx.beginPath();
    ctx.moveTo(hx + size * 0.1, hy - size * 0.5);
    ctx.lineTo(hx + size * 0.1, hy + size * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A mud puddle lying on the road, centred at (x, y), `rx` × `ry` px (a flat ellipse, the road
 * seen at an angle): an uneven brown pool with a lighter rim and a glint.
 */
export function drawPuddle(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  rx: number,
  ry: number,
  alpha = 1,
): void {
  if (rx < 1 || ry < 0.5) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = p.mudFill;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.moveTo(x - rx * 0.35 + rx * 0.62, y - ry * 0.25);
  ctx.ellipse(x - rx * 0.35, y - ry * 0.25, rx * 0.62, ry * 0.85, 0, 0, TAU);
  ctx.moveTo(x + rx * 0.5 + rx * 0.55, y + ry * 0.2);
  ctx.ellipse(x + rx * 0.5, y + ry * 0.2, rx * 0.55, ry * 0.8, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = p.mud;
  ctx.lineWidth = Math.max(1, ry * 0.12);
  ctx.globalAlpha = alpha * 0.8;
  ctx.beginPath();
  ctx.ellipse(x, y, rx * 1.02, ry * 1.02, 0, Math.PI * 0.05, Math.PI * 0.95);
  ctx.stroke();
  // A glint on the water.
  ctx.globalAlpha = alpha * 0.7;
  ctx.strokeStyle = p.surface;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, ry * 0.14);
  ctx.beginPath();
  ctx.ellipse(x - rx * 0.1, y - ry * 0.15, rx * 0.4, ry * 0.32, 0, Math.PI * 1.1, Math.PI * 1.55);
  ctx.stroke();
  ctx.restore();
}

/**
 * A feed bag (a cyclist's musette) hanging from its strap at (x, yHook): a cotton bag `size` px
 * tall with a band across it, and the strap's loop above. `swing` turns it a little.
 */
export function drawFeedBag(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  yHook: number,
  size: number,
  swing = 0,
  alpha = 1,
): void {
  const h = Math.max(6, size);
  const w = h * 0.82;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, yHook);
  ctx.rotate(swing);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // The strap: a long thin loop.
  ctx.strokeStyle = p.boost;
  ctx.lineWidth = Math.max(1, h * 0.05);
  ctx.beginPath();
  ctx.moveTo(-w * 0.32, h * 0.62);
  ctx.lineTo(0, 0);
  ctx.lineTo(w * 0.32, h * 0.62);
  ctx.stroke();
  // The bag: a soft cotton pouch, gathered at the top, rounded at the bottom.
  ctx.fillStyle = p.bag;
  ctx.strokeStyle = p.bagLine;
  ctx.lineWidth = Math.max(1, h * 0.045);
  ctx.beginPath();
  ctx.moveTo(-w * 0.36, h * 0.62);
  ctx.quadraticCurveTo(0, h * 0.56, w * 0.36, h * 0.62);
  ctx.quadraticCurveTo(w * 0.56, h * 1.1, w * 0.46, h * 1.42);
  ctx.quadraticCurveTo(0, h * 1.62, -w * 0.46, h * 1.42);
  ctx.quadraticCurveTo(-w * 0.56, h * 1.1, -w * 0.36, h * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // A printed band across it, in the accent.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = p.boost;
  ctx.fillRect(-w, h * 0.9, w * 2, h * 0.14);
  ctx.restore();
  ctx.restore();
}

/**
 * The splash of a hit at (x, y), radius `r`, `t` 0 … 1 through it: drops flying out — water
 * for a bottle, mud for a puddle, a buzzing ring for hornets — or a calm ring in the cape's
 * colour when the rain cape kept it off. Still with reduced motion.
 */
export function drawSplash(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  r: number,
  t: number,
  kind: 'hit' | 'blocked',
  item: HitKind | null,
  reduced: boolean,
): void {
  const tt = reduced ? 0.45 : t;
  ctx.save();
  if (kind === 'blocked') {
    ctx.globalAlpha = reduced ? 0.6 : 1 - tt;
    ctx.strokeStyle = p.guard;
    ctx.lineWidth = Math.max(1.5, r * 0.05);
    const rr = r * (0.8 + tt * 0.6);
    ctx.beginPath();
    ctx.ellipse(x, y, rr, rr * 0.92, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const colour = item === 'puddle' ? p.mud : item === 'hornets' ? p.hornet : p.water;
  ctx.globalAlpha = reduced ? 0.7 : Math.max(0, 1 - tt);
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + hash01(i, 91) * 0.5;
    const d = r * (0.35 + tt * (0.7 + hash01(i, 92) * 0.5));
    const dr = Math.max(1.4, r * (0.06 + hash01(i, 93) * 0.04) * (1 - tt * 0.5));
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8, dr, 0, TAU);
    ctx.fill();
  }
  ctx.lineWidth = Math.max(1.2, r * 0.04);
  ctx.beginPath();
  ctx.ellipse(x, y, r * (0.5 + tt * 0.5), r * (0.45 + tt * 0.45), 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/** Where a thrown bottle is at `t` along an arc from (x0, y0) to (x1, y1), `lift` px high. */
export function arcPoint(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  lift: number,
  t: number,
): { x: number; y: number } {
  const u = Math.max(0, Math.min(1, t));
  return {
    x: x0 + (x1 - x0) * u,
    y: y0 + (y1 - y0) * u - 4 * lift * u * (1 - u),
  };
}

/**
 * Effects on another rider (from their broadcast), centred at (x, y) with radius `r` (about
 * the rider's size): water dripping, mud spattered, hornets around the head, the cape, the
 * protection ring.
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
): void {
  if (fx.hit === 'bottle') drawDrips(ctx, p, x, y, r, timeS, reduced, 5);
  if (fx.hit === 'puddle') drawMudSpatter(ctx, p, x, y, r, 8);
  if (fx.hit === 'hornets') drawSwarm(ctx, p, x, y - r * 0.75, r * 0.5, timeS, reduced, 5);
  if (fx.cape) drawCape(ctx, p, x, y, r * 1.05, r * 0.95, 0.9);
  if (fx.protected) drawProtection(ctx, p, x, y, r * 1.1, r * 1.0, 0);
}
