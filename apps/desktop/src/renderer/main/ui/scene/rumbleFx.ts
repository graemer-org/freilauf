/**
 * Freilauf Rumble drawn in the ride scenes, shared by both renderers (docs/rumble.md): the feed
 * bag at the roadside, a water bottle (a cyclist's bidon) in flight, the mud puddle on the road,
 * a small swarm of hornets, the rain cape, the faint protection ring with its countdown, and the
 * splash of a hit — water, mud, or a buzz. Plain canvas calls; positions and sizes come from the
 * renderer. With reduced motion nothing moves: every cue is drawn still.
 */
import type { PowerUpKind, RoughVariant } from '../../../../shared/powerUps';
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
  if (item === 'tacks') {
    drawPuff(ctx, p, x, y + r * 0.55, r, tt, reduced);
    ctx.restore();
    return;
  }
  const colour =
    item === 'puddle'
      ? p.mud
      : item === 'hornets'
        ? p.hornet
        : item === 'chain'
          ? p.metal
          : p.water;
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
  if (fx.hit === 'tacks') drawFlatMark(ctx, p, x - r * 0.3, y + r * 0.82, r * 0.55, timeS, reduced);
  if (fx.hit === 'chain') drawLooseChain(ctx, p, x, y + r * 0.3, r * 0.6, timeS, reduced);
  if (fx.repair)
    drawWrench(
      ctx,
      p,
      x + r * 0.55,
      y + r * 0.35,
      r * 0.4,
      reduced ? 0 : Math.sin(timeS * 9) * 0.5,
    );
  if (fx.cape) drawCape(ctx, p, x, y, r * 1.05, r * 0.95, 0.9);
  if (fx.protected) drawProtection(ctx, p, x, y, r * 1.1, r * 1.0, 0);
}

// ───────────── Rumble v3 (ADR 0009) ─────────────

/**
 * Tacks scattered on the road, centred at (x, y) within an `rx` × `ry` ellipse: small drawing
 * pins lying about, their round heads catching the light now and then (still with reduced
 * motion).
 */
export function drawTacks(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  rx: number,
  ry: number,
  timeS: number,
  reduced: boolean,
  alpha = 1,
): void {
  if (rx < 1) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  const n = 14;
  const head = Math.max(1.6, rx * 0.1);
  for (let i = 0; i < n; i++) {
    const a = hash01(i, 101) * TAU;
    const d = Math.sqrt(hash01(i, 102));
    const tx = x + Math.cos(a) * rx * d;
    const ty = y + Math.sin(a) * ry * d;
    const turn = hash01(i, 103) * TAU;
    // The pin: a short spike, then the round head.
    ctx.strokeStyle = p.ink2;
    ctx.lineWidth = Math.max(0.8, head * 0.35);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + Math.cos(turn) * head * 1.6, ty + Math.sin(turn) * head * 0.7);
    ctx.stroke();
    ctx.fillStyle = p.metal;
    ctx.strokeStyle = p.ink;
    ctx.lineWidth = Math.max(0.6, head * 0.2);
    ctx.beginPath();
    ctx.ellipse(tx, ty, head, head * 0.7, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    // A glint that wanders from pin to pin.
    const glint = reduced ? (i % 4 === 0 ? 0.8 : 0) : Math.max(0, Math.sin(timeS * 3 + i * 1.7));
    if (glint > 0.4) {
      ctx.globalAlpha = alpha * glint;
      ctx.strokeStyle = p.surface;
      ctx.lineWidth = Math.max(0.8, head * 0.3);
      const g = head * 1.6;
      ctx.beginPath();
      ctx.moveTo(tx - g, ty - head * 0.3);
      ctx.lineTo(tx + g, ty - head * 0.3);
      ctx.moveTo(tx, ty - head * 0.3 - g);
      ctx.lineTo(tx, ty - head * 0.3 + g);
      ctx.stroke();
      ctx.globalAlpha = alpha;
    }
  }
  ctx.restore();
}

/**
 * The "pssst" of a tyre going flat at (x, y), size `r`, `t` 0 … 1: a few grey puffs blowing
 * out of the tyre and the word itself, fading.
 */
export function drawPuff(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  r: number,
  t: number,
  reduced: boolean,
): void {
  const tt = reduced ? 0.45 : t;
  ctx.save();
  ctx.globalAlpha = reduced ? 0.7 : Math.max(0, 1 - tt);
  ctx.fillStyle = p.surface;
  ctx.strokeStyle = p.ink2;
  ctx.lineWidth = Math.max(1, r * 0.025);
  for (let i = 0; i < 5; i++) {
    const a = Math.PI * (0.95 + i * 0.12);
    const d = r * (0.15 + tt * (0.45 + hash01(i, 111) * 0.3));
    const pr = r * (0.1 + tt * 0.12 + hash01(i, 112) * 0.05);
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.6, pr, 0, TAU);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = p.ink;
  ctx.strokeStyle = p.surface;
  ctx.lineWidth = 3;
  ctx.font = `700 ${Math.max(11, Math.round(r * 0.32))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.strokeText('pssst', x - r * 0.55, y - r * (0.25 + tt * 0.2));
  ctx.fillText('pssst', x - r * 0.55, y - r * (0.25 + tt * 0.2));
  ctx.restore();
}

/** A flat rear tyre as a mark at a rider's wheel (others' riders): a squashed, bulging tyre. */
export function drawFlatMark(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  r: number,
  timeS: number,
  reduced: boolean,
): void {
  const wob = reduced ? 0 : Math.sin(timeS * 7) * r * 0.04;
  ctx.save();
  ctx.strokeStyle = p.attack;
  ctx.lineWidth = Math.max(1.4, r * 0.08);
  ctx.beginPath();
  ctx.ellipse(x + wob, y, r * 0.62, r * 0.2, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/**
 * A chain off its chainring: a sagging, swinging loop of links below (x, y), `len` px long
 * (in screen space; flaps unless reduced motion).
 */
export function drawLooseChain(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  len: number,
  timeS: number,
  reduced: boolean,
): void {
  const swing = reduced ? 0.3 : Math.sin(timeS * 6.5);
  ctx.save();
  ctx.strokeStyle = p.ink2;
  ctx.lineWidth = Math.max(1.2, len * 0.06);
  ctx.setLineDash([Math.max(1.5, len * 0.07), Math.max(1, len * 0.04)]);
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(x - len * 0.5, y);
  ctx.quadraticCurveTo(x + swing * len * 0.35, y + len * 0.75, x + len * 0.5, y + len * 0.05);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** A small wrench at (x, y), `size` px long, turned by `angle` (the mini tool at work). */
export function drawWrench(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  size: number,
  angle: number,
): void {
  const s = Math.max(6, size);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle - 0.7);
  ctx.fillStyle = p.metal;
  ctx.strokeStyle = p.ink;
  ctx.lineWidth = Math.max(0.8, s * 0.05);
  // Handle.
  ctx.beginPath();
  ctx.roundRect(-s * 0.08, -s * 0.1, s * 0.16, s * 0.6, s * 0.06);
  ctx.fill();
  ctx.stroke();
  // Open jaw.
  ctx.beginPath();
  ctx.arc(0, -s * 0.22, s * 0.2, Math.PI * 0.7, Math.PI * 2.3);
  ctx.lineTo(s * 0.06, -s * 0.3);
  ctx.lineTo(-s * 0.06, -s * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** A progress ring around (x, y), radius `r`, filled to `progress` (0 … 1), in the cape's colour. */
export function drawProgressRing(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  r: number,
  progress: number,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, r * 0.14);
  ctx.strokeStyle = p.guardFaint;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = p.guard;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0, Math.min(1, progress)));
  ctx.stroke();
  ctx.restore();
}

/**
 * The energy bar at (x, y), `k` px per metre, `ageS` since it was eaten: for the first 1.4 s the
 * bar is unwrapped (the two halves of the wrapper peel apart); then, while it acts, a soft
 * glow and a few sparkles around the rider (still with reduced motion).
 */
export function drawEnergy(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  y: number,
  k: number,
  ageS: number,
  timeS: number,
  reduced: boolean,
): void {
  ctx.save();
  const g = ctx.createRadialGradient(x, y, 0.1 * k, x, y, 1.2 * k);
  g.addColorStop(0, p.boostGlow);
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, 1.2 * k, 0, TAU);
  ctx.fill();
  // Sparkles: small four-pointed stars that come and go around the rider.
  ctx.fillStyle = p.boost;
  for (let i = 0; i < 7; i++) {
    const a = hash01(i, 121) * TAU + (reduced ? 0 : timeS * 0.6);
    const d = (0.55 + hash01(i, 122) * 0.5) * k;
    const life = reduced ? 0.7 : (timeS * (0.8 + hash01(i, 123)) + hash01(i, 124)) % 1;
    const sz = Math.max(1.5, 0.08 * k * Math.sin(life * Math.PI));
    const sx = x + Math.cos(a) * d;
    const sy = y + Math.sin(a) * d * 0.9;
    ctx.globalAlpha = reduced ? 0.8 : Math.sin(life * Math.PI);
    ctx.beginPath();
    ctx.moveTo(sx, sy - sz * 2);
    ctx.lineTo(sx + sz * 0.5, sy - sz * 0.5);
    ctx.lineTo(sx + sz * 2, sy);
    ctx.lineTo(sx + sz * 0.5, sy + sz * 0.5);
    ctx.lineTo(sx, sy + sz * 2);
    ctx.lineTo(sx - sz * 0.5, sy + sz * 0.5);
    ctx.lineTo(sx - sz * 2, sy);
    ctx.lineTo(sx - sz * 0.5, sy - sz * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (ageS < 1.4) {
    // Unwrapping, above the rider's hands.
    const u = reduced ? 0.5 : Math.min(1, ageS / 1.2);
    const bx = x + 0.45 * k;
    const by = y - 0.75 * k;
    const w = 0.42 * k;
    const h = 0.11 * k;
    ctx.translate(bx, by);
    ctx.rotate(-0.35);
    ctx.fillStyle = p.mud;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, h * 0.3);
    ctx.fill();
    // The wrapper's halves slide off both ends and tilt away.
    ctx.fillStyle = p.boost;
    ctx.strokeStyle = p.surface;
    ctx.lineWidth = Math.max(0.8, h * 0.12);
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(side * (w * 0.25 + u * w * 0.45), -u * h * 1.6);
      ctx.rotate(side * u * 0.7);
      ctx.beginPath();
      ctx.rect(-w * 0.27, -h * 0.62, w * 0.54, h * 1.24);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * The team car from the side at (x, yRoad) facing right, `len` px long: an estate with a spare
 * bike on the roof rack; an arm out of the window hands up `kinds` while `t` (0 … 1) is in the
 * middle of the visit.
 */
export function drawTeamCarSide(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  yRoad: number,
  len: number,
  t: number,
  kinds: readonly PowerUpKind[],
): void {
  const L = Math.max(20, len);
  const H = L * 0.3;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const x0 = x - L / 2;
  const top = yRoad - H;
  // Body: bonnet low at the front (right), roof, rear hatch.
  ctx.fillStyle = p.car;
  ctx.beginPath();
  ctx.moveTo(x0, yRoad - H * 0.25);
  ctx.lineTo(x0, top + H * 0.15);
  ctx.lineTo(x0 + L * 0.12, top);
  ctx.lineTo(x0 + L * 0.66, top);
  ctx.lineTo(x0 + L * 0.8, top + H * 0.42);
  ctx.lineTo(x0 + L, top + H * 0.52);
  ctx.lineTo(x0 + L, yRoad - H * 0.25);
  ctx.closePath();
  ctx.fill();
  // Windows.
  ctx.fillStyle = p.haze;
  ctx.beginPath();
  ctx.moveTo(x0 + L * 0.14, top + H * 0.12);
  ctx.lineTo(x0 + L * 0.64, top + H * 0.12);
  ctx.lineTo(x0 + L * 0.75, top + H * 0.4);
  ctx.lineTo(x0 + L * 0.14, top + H * 0.4);
  ctx.closePath();
  ctx.fill();
  // Wheels.
  ctx.fillStyle = p.ink;
  for (const wx of [0.2, 0.8]) {
    ctx.beginPath();
    ctx.arc(x0 + L * wx, yRoad - H * 0.18, H * 0.2, 0, TAU);
    ctx.fill();
  }
  // Roof rack with a bike: two wheels and a frame line.
  ctx.strokeStyle = p.ink2;
  ctx.lineWidth = Math.max(1, L * 0.012);
  const ry = top - H * 0.32;
  ctx.beginPath();
  ctx.arc(x0 + L * 0.22, ry, H * 0.26, 0, TAU);
  ctx.arc(x0 + L * 0.55, ry, H * 0.26, 0, TAU);
  ctx.moveTo(x0 + L * 0.22, ry);
  ctx.lineTo(x0 + L * 0.38, ry - H * 0.05);
  ctx.lineTo(x0 + L * 0.55, ry);
  ctx.moveTo(x0 + L * 0.1, top);
  ctx.lineTo(x0 + L * 0.66, top);
  ctx.stroke();
  // The hand-up: an arm out of the front window, the items floating up to the rider.
  const hand = Math.sin(Math.min(1, Math.max(0, (t - 0.2) / 0.6)) * Math.PI);
  if (hand > 0.05) {
    ctx.strokeStyle = p.skin;
    ctx.lineWidth = Math.max(2, L * 0.035);
    ctx.beginPath();
    ctx.moveTo(x0 + L * 0.62, top + H * 0.3);
    ctx.lineTo(x0 + L * 0.62 + L * 0.12 * hand, top - H * 0.25 * hand);
    ctx.stroke();
    kinds.forEach((_, i) => {
      ctx.globalAlpha = hand;
      ctx.fillStyle = p.boost;
      ctx.beginPath();
      ctx.arc(
        x0 + L * (0.72 + i * 0.12) * 1,
        top - H * (0.4 + hand * 0.6 + i * 0.15),
        Math.max(2, L * 0.04),
        0,
        TAU,
      );
      ctx.fill();
    });
  }
  ctx.restore();
}

/**
 * The team car seen from behind at (x, yRoad), `w` px wide: the rear hatch, lights, the bike
 * on the roof; the items handed up drawn as dots rising towards the rider.
 */
export function drawTeamCarBehind(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  x: number,
  yRoad: number,
  w: number,
  t: number,
  kinds: readonly PowerUpKind[],
): void {
  const W = Math.max(16, w);
  const H = W * 0.72;
  ctx.save();
  ctx.fillStyle = p.shadow;
  ctx.beginPath();
  ctx.ellipse(x, yRoad, W * 0.58, W * 0.06, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = p.car;
  ctx.beginPath();
  ctx.roundRect(x - W / 2, yRoad - H * 0.62, W, H * 0.56, W * 0.06);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - W * 0.42, yRoad - H * 0.62);
  ctx.lineTo(x - W * 0.34, yRoad - H);
  ctx.lineTo(x + W * 0.34, yRoad - H);
  ctx.lineTo(x + W * 0.42, yRoad - H * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = p.haze;
  ctx.beginPath();
  ctx.moveTo(x - W * 0.36, yRoad - H * 0.66);
  ctx.lineTo(x - W * 0.3, yRoad - H * 0.94);
  ctx.lineTo(x + W * 0.3, yRoad - H * 0.94);
  ctx.lineTo(x + W * 0.36, yRoad - H * 0.66);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = p.dark ? '#ff6159' : '#cc2b22';
  ctx.fillRect(x - W * 0.48, yRoad - H * 0.5, W * 0.12, H * 0.08);
  ctx.fillRect(x + W * 0.36, yRoad - H * 0.5, W * 0.12, H * 0.08);
  ctx.fillStyle = p.ink;
  ctx.fillRect(x - W * 0.46, yRoad - H * 0.08, W * 0.14, H * 0.1);
  ctx.fillRect(x + W * 0.32, yRoad - H * 0.08, W * 0.14, H * 0.1);
  // The bike on the roof, edge-on.
  ctx.strokeStyle = p.ink2;
  ctx.lineWidth = Math.max(1, W * 0.025);
  ctx.beginPath();
  ctx.moveTo(x - W * 0.05, yRoad - H);
  ctx.lineTo(x - W * 0.05, yRoad - H * 1.35);
  ctx.moveTo(x - W * 0.2, yRoad - H * 1.33);
  ctx.lineTo(x + W * 0.1, yRoad - H * 1.33);
  ctx.stroke();
  const hand = Math.sin(Math.min(1, Math.max(0, (t - 0.2) / 0.6)) * Math.PI);
  kinds.forEach((_, i) => {
    if (hand < 0.05) return;
    ctx.globalAlpha = hand;
    ctx.fillStyle = p.boost;
    ctx.beginPath();
    ctx.arc(
      x + W * (0.55 + i * 0.12),
      yRoad - H * (1.0 + hand * 0.5 + i * 0.2),
      Math.max(2.5, W * 0.06),
      0,
      TAU,
    );
    ctx.fill();
  });
  ctx.restore();
}

/**
 * A patch of rough road in the quad a0 (near left), a1 (near right), b1 (far right), b0 (far
 * left), screen px: cobbles in rows, a gravel track (loose stones, a grassy middle), a forest
 * path with roots across it, or branches and leaves strewn on the road. `seed` keeps the
 * pattern still while the patch moves.
 */
export function drawRoughPatch(
  ctx: CanvasRenderingContext2D,
  p: ScenePalette,
  variant: RoughVariant,
  a0: { x: number; y: number },
  a1: { x: number; y: number },
  b1: { x: number; y: number },
  b0: { x: number; y: number },
  seed: number,
  alpha = 1,
): void {
  const at = (u: number, v: number) => {
    const nx = a0.x + (a1.x - a0.x) * u;
    const ny = a0.y + (a1.y - a0.y) * u;
    const fx = b0.x + (b1.x - b0.x) * u;
    const fy = b0.y + (b1.y - b0.y) * u;
    return { x: nx + (fx - nx) * v, y: ny + (fy - ny) * v };
  };
  const width = Math.hypot(a1.x - a0.x, a1.y - a0.y);
  const depth = Math.max(1, Math.abs(a0.y - b0.y), Math.abs(a0.x - b0.x) * 0.2);
  if (width < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(a0.x, a0.y);
  ctx.lineTo(a1.x, a1.y);
  ctx.lineTo(b1.x, b1.y);
  ctx.lineTo(b0.x, b0.y);
  ctx.closePath();
  ctx.fillStyle =
    variant === 'cobbles'
      ? p.stone
      : variant === 'gravel'
        ? p.gravel
        : variant === 'roots'
          ? p.mudFill
          : p.road;
  ctx.fill();
  ctx.clip();
  const cols = Math.max(3, Math.min(14, Math.round(width / 9)));
  const rows = Math.max(1, Math.min(6, Math.round(depth / 5)));
  const rnd = (i: number, j: number) => hash01(seed * 131 + i, j);
  ctx.lineCap = 'round';
  if (variant === 'cobbles') {
    // Rows of setts, each row offset by half a stone, dark joints between them.
    ctx.strokeStyle = p.stoneLine;
    ctx.lineWidth = Math.max(0.8, width / cols / 7);
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      const s0 = at(0, v);
      const s1 = at(1, v);
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
      ctx.stroke();
      if (r === rows) break;
      for (let c = 0; c <= cols; c++) {
        const u = (c + (r % 2) * 0.5) / cols;
        const t0 = at(u, v);
        const t1 = at(u, (r + 1) / rows);
        ctx.beginPath();
        ctx.moveTo(t0.x, t0.y);
        ctx.lineTo(t1.x, t1.y);
        ctx.stroke();
      }
    }
  } else if (variant === 'gravel') {
    // A grassy strip down the middle and loose stones everywhere else.
    ctx.fillStyle = p.leaf;
    ctx.globalAlpha = alpha * 0.55;
    const m0 = at(0.42, 0);
    const m1 = at(0.58, 0);
    const m2 = at(0.58, 1);
    const m3 = at(0.42, 1);
    ctx.beginPath();
    ctx.moveTo(m0.x, m0.y);
    ctx.lineTo(m1.x, m1.y);
    ctx.lineTo(m2.x, m2.y);
    ctx.lineTo(m3.x, m3.y);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.mud;
    const n = cols * rows * 5;
    const r0 = Math.max(0.8, width / cols / 9);
    for (let i = 0; i < n; i++) {
      const q = at(rnd(i, 1), rnd(i, 2));
      ctx.beginPath();
      ctx.arc(q.x, q.y, r0 * (0.6 + rnd(i, 3)), 0, TAU);
      ctx.fill();
    }
  } else if (variant === 'roots') {
    // Dark roots snaking across the path.
    ctx.strokeStyle = p.mud;
    ctx.lineWidth = Math.max(1.2, width / cols / 4);
    for (let r = 0; r < rows + 1; r++) {
      const v = (r + 0.5) / (rows + 1);
      const s0 = at(-0.05, v + (rnd(r, 4) - 0.5) * 0.2);
      const c1 = at(0.35, v + (rnd(r, 5) - 0.5) * 0.6);
      const c2 = at(0.7, v + (rnd(r, 6) - 0.5) * 0.6);
      const s1 = at(1.05, v + (rnd(r, 7) - 0.5) * 0.2);
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, s1.x, s1.y);
      ctx.stroke();
    }
    ctx.fillStyle = p.leaf;
    for (let i = 0; i < cols * 2; i++) {
      const q = at(rnd(i, 8), rnd(i, 9));
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, width / cols / 5, width / cols / 10, rnd(i, 10) * 3, 0, TAU);
      ctx.fill();
    }
  } else {
    // Branches and leaves strewn on the road.
    ctx.strokeStyle = p.mud;
    ctx.lineWidth = Math.max(1.2, width / cols / 5);
    for (let i = 0; i < cols; i++) {
      const q = at(rnd(i, 11), rnd(i, 12));
      const ang = rnd(i, 13) * Math.PI;
      const l = (width / cols) * (1 + rnd(i, 14));
      ctx.beginPath();
      ctx.moveTo(q.x - Math.cos(ang) * l, q.y - Math.sin(ang) * l * 0.35);
      ctx.lineTo(q.x + Math.cos(ang) * l, q.y + Math.sin(ang) * l * 0.35);
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x + l * 0.4, q.y - l * 0.25);
      ctx.stroke();
    }
    for (let i = 0; i < cols * rows * 4; i++) {
      const q = at(rnd(i, 15), rnd(i, 16));
      ctx.fillStyle = rnd(i, 17) < 0.5 ? p.leaf : p.hornet;
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, width / cols / 4, width / cols / 8, rnd(i, 18) * 3, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}
