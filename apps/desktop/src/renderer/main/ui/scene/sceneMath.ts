import type { RiderCards } from '@freilauf/p2p';
import { riderFx, type RiderFx } from './powerUpScene';
/**
 * Pure maths behind the ride scene: easing, gradient exaggeration, wheel and
 * crank integration, parallax, the elevation history and lateral steering.
 * No DOM, no React — everything here is unit-tested in node.
 *
 * Hot-path functions take and mutate small state objects instead of
 * returning fresh ones, so the 60 fps loop stays allocation-free.
 */

const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Frame-rate independent exponential easing: moves `current` towards
 * `target` so that after `tauS` seconds 63 % of the gap is closed, whatever
 * the frame timing. `tauS <= 0` jumps straight to the target.
 */
export function easeToward(current: number, target: number, dtS: number, tauS: number): number {
  if (tauS <= 0 || !Number.isFinite(current)) return target;
  if (dtS <= 0) return current;
  return target + (current - target) * Math.exp(-dtS / tauS);
}

// ───────────────────────── gradient ─────────────────────────

/**
 * Real gradients look flat when drawn true to scale (3 % is 1.7°), so the
 * slope is exaggerated by GRADE_EXAGGERATION and then softly limited to
 * MAX_VISUAL_SLOPE with tanh, so a 15 % wall does not tip the rider over:
 *
 *   visual slope = MAX · tanh(grade/100 · EXAG / MAX)
 *
 * Near zero this is linear (3 % → ≈ 5° on screen); it approaches
 * atan(MAX) ≈ 21° asymptotically (15 % → ≈ 15°, −10 % → ≈ −12°).
 */
export const GRADE_EXAGGERATION = 3;
export const MAX_VISUAL_SLOPE = 0.38;

/** Visual slope (rise over run) for a gradient in percent. */
export function visualSlope(gradePercent: number): number {
  if (!Number.isFinite(gradePercent)) return 0;
  const raw = (gradePercent / 100) * GRADE_EXAGGERATION;
  return MAX_VISUAL_SLOPE * Math.tanh(raw / MAX_VISUAL_SLOPE);
}

/** Visual road angle in radians (positive = climbing to the right). */
export function visualAngle(gradePercent: number): number {
  return Math.atan(visualSlope(gradePercent));
}

/** The gradient as printed on the slope: "+4.5 %", "−2.0 %", "0.0 %". */
export function formatGrade(gradePercent: number): string {
  const g = Math.round(gradePercent * 10) / 10;
  const sign = g > 0 ? '+' : g < 0 ? '−' : '';
  return `${sign}${Math.abs(g).toFixed(1)} %`;
}

// ───────────────────────── rotation ─────────────────────────

/** 700×28c wheel with tyre. */
export const WHEEL_RADIUS_M = 0.336;

/** Wheel angular velocity in rad/s for a road speed. */
export const wheelRate = (speedMps: number): number => Math.max(0, speedMps) / WHEEL_RADIUS_M;

/** Crank angular velocity in rad/s for a cadence. */
export const crankRate = (cadenceRpm: number): number => (Math.max(0, cadenceRpm) / 60) * TAU;

/** Advances an angle by rate·dt and wraps it into [0, 2π). */
export function integrateAngle(angle: number, ratePerS: number, dtS: number): number {
  const next = (angle + ratePerS * dtS) % TAU;
  return next < 0 ? next + TAU : next;
}

// ───────────────────────── parallax ─────────────────────────

/**
 * Horizontal offset of a repeating layer in metres within [0, period):
 * layers further away use a smaller factor and so scroll more slowly.
 * Derived from distance only, so it never depends on frame timing.
 */
export function parallaxOffset(distanceM: number, factor: number, periodM: number): number {
  const v = (distanceM * factor) % periodM;
  return v < 0 ? v + periodM : v;
}

/** Deterministic hash of an integer (and a seed) to [0, 1). */
export function hash01(n: number, seed = 0): number {
  let h = (Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Smooth 1-D value noise in [0, 1], seeded; same input → same output. */
export function valueNoise(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(i, seed);
  const b = hash01(i + 1, seed);
  return a + (b - a) * u;
}

// ───────────────────────── elevation history ─────────────────────────

/**
 * The recent elevation profile, accumulated from distance and gradient
 * samples. A ring buffer with a fixed capacity: memory stays bounded however
 * long the ride. One point every `stepM` metres; the newest point is the
 * rider's current position.
 */
export class ProfileHistory {
  readonly capacity: number;
  readonly stepM: number;
  private readonly dist: Float64Array;
  private readonly elev: Float64Array;
  private start = 0;
  private count = 0;
  private lastDistanceM = 0;
  private lastGrade = 0;
  private elevationM = 0;
  private started = false;

  constructor(capacity = 400, stepM = 5) {
    this.capacity = capacity;
    this.stepM = stepM;
    this.dist = new Float64Array(capacity);
    this.elev = new Float64Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  /** Elevation relative to the first sample, metres. */
  get currentElevationM(): number {
    return this.elevationM;
  }

  get currentDistanceM(): number {
    return this.lastDistanceM;
  }

  /** Total metres climbed (positive steps only) within the stored window. */
  climbedM(): number {
    let up = 0;
    for (let i = 1; i < this.count; i++) {
      const d = this.elevAt(i) - this.elevAt(i - 1);
      if (d > 0) up += d;
    }
    const tail = this.elevationM - (this.count > 0 ? this.elevAt(this.count - 1) : 0);
    return up + (tail > 0 ? tail : 0);
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
    this.lastDistanceM = 0;
    this.lastGrade = 0;
    this.elevationM = 0;
    this.started = false;
  }

  /**
   * Feeds a live sample. Distance going backwards (a new ride) restarts the
   * history. Elevation is integrated with the mean of the previous and the
   * current gradient (trapezoid rule).
   */
  add(distanceM: number, gradePercent: number): void {
    if (!Number.isFinite(distanceM) || !Number.isFinite(gradePercent)) return;
    if (!this.started || distanceM < this.lastDistanceM - 1) {
      this.clear();
      this.started = true;
      this.lastDistanceM = distanceM;
      this.lastGrade = gradePercent;
      this.push(distanceM, 0);
      return;
    }
    const dd = distanceM - this.lastDistanceM;
    if (dd > 0) {
      this.elevationM += (dd * (this.lastGrade + gradePercent)) / 200;
      this.lastDistanceM = distanceM;
    }
    this.lastGrade = gradePercent;
    const newest = this.distAt(this.count - 1);
    if (distanceM - newest >= this.stepM) this.push(distanceM, this.elevationM);
  }

  /** i-th stored point from the oldest (0) to the newest (length − 1). */
  distAt(i: number): number {
    return this.dist[(this.start + i) % this.capacity] ?? 0;
  }

  elevAt(i: number): number {
    return this.elev[(this.start + i) % this.capacity] ?? 0;
  }

  private push(d: number, e: number): void {
    const idx = (this.start + this.count) % this.capacity;
    this.dist[idx] = d;
    this.elev[idx] = e;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
  }
}

/**
 * Vertical range for plotting elevation between `lo` and `hi`, padded and
 * at least `minSpanM` tall so a flat road plots flat instead of amplifying
 * centimetre-scale noise.
 */
export function profileRange(lo: number, hi: number, minSpanM = 24): { min: number; max: number } {
  const span = Math.max(hi - lo, minSpanM);
  const mid = (lo + hi) / 2;
  return { min: mid - span * 0.55, max: mid + span * 0.55 };
}

// ───────────────────────── steering ─────────────────────────

/**
 * Lateral position across the lane: −1 is the far edge (rider's left, as the
 * scene looks at the rider's right side), +1 the near edge. The steering
 * input (paddles −1…1, or keys) sets a lateral *velocity*: hold to drift
 * across, let go to hold the line, like steering a real bike. The velocity
 * is eased so the drift starts and stops softly, and scaled down at walking
 * pace (you cannot weave a stationary bike).
 */
export interface LateralState {
  /** −1 … 1 */
  pos: number;
  /** lane widths per second */
  vel: number;
}

export const LATERAL_MAX_RATE = 0.9;
export const LATERAL_TAU_S = 0.18;

export function stepLateral(
  s: LateralState,
  input: number,
  dtS: number,
  speedMps: number,
  instant = false,
): void {
  const steer = clamp(Number.isFinite(input) ? input : 0, -1, 1);
  const mobility = clamp(speedMps / 2.5, 0, 1);
  const target = steer * LATERAL_MAX_RATE * mobility;
  s.vel = instant ? target : easeToward(s.vel, target, dtS, LATERAL_TAU_S);
  const next = s.pos + s.vel * dtS;
  if (next >= 1) {
    s.pos = 1;
    if (s.vel > 0) s.vel = 0;
  } else if (next <= -1) {
    s.pos = -1;
    if (s.vel < 0) s.vel = 0;
  } else {
    s.pos = next;
  }
}

/** Combined steering input from paddles and held keys, −1 … 1. */
export function steeringInput(paddles: number | undefined, left: boolean, right: boolean): number {
  const keys = (right ? 1 : 0) - (left ? 1 : 0);
  const p = paddles !== undefined && Number.isFinite(paddles) ? paddles : 0;
  return clamp(p + keys, -1, 1);
}

/** Lean into the drift in radians, from lateral velocity; ±0.2 rad at most. */
export const leanFor = (vel: number): number => clamp(vel * 0.22, -0.2, 0.2);

// ───────────────────────── posture ─────────────────────────

/** 0…1: how far the rider is out of the saddle (steep, slow cadence, pedalling). */
export function standingTarget(gradePercent: number, cadenceRpm: number, riding: boolean): number {
  if (!riding || cadenceRpm < 20) return 0;
  return gradePercent >= 7 && cadenceRpm < 75 ? 1 : 0;
}

/** 0…1: how tucked the rider is (fast, or coasting downhill). */
export function tuckTarget(speedMps: number, gradePercent: number, cadenceRpm: number): number {
  const fast = clamp((speedMps - 11) / 4, 0, 1);
  const coastingDown = gradePercent <= -3 && cadenceRpm < 20 && speedMps > 4 ? 1 : 0;
  return Math.max(fast, coastingDown);
}

// ───────────────────────── group ─────────────────────────

/** Riders within this gap are drawn on the road; farther ones only on the profile. */
export const SCENE_GROUP_RANGE_M = 100;

/**
 * Screen offset (as a fraction of the half-width available ahead or
 * behind) for a rider `gapM` ahead (+) or behind (−). The scene shows only a
 * few metres of road, so gaps are compressed: close riders are spread out,
 * 100 m sits near the edge, and the order is always preserved.
 */
export function groupOffset(gapM: number): number {
  if (!Number.isFinite(gapM)) return 0;
  return Math.sign(gapM) * (1 - Math.exp(-Math.abs(gapM) / 30));
}

export interface PlacedRider {
  id: string;
  name: string;
  gapM: number;
  /** −1 … 1 of the half-width, see groupOffset. */
  offset: number;
  /** True when within SCENE_GROUP_RANGE_M and drawn on the road. */
  onRoad: boolean;
  speedMps: number;
  cadenceRpm: number;
  stale: boolean;
  /** Card Race effects on that rider (their shield, an attack, protection), if any. */
  fx?: RiderFx;
}

/** Places other riders for the scene; nearest first so close riders draw on top. */
export function placeRiders(
  riders: readonly {
    peerId: string;
    name: string;
    gapM: number;
    speedMps: number;
    cadenceRpm: number;
    stale: boolean;
    cards?: RiderCards;
  }[],
): PlacedRider[] {
  const out: PlacedRider[] = [];
  for (const r of riders) {
    if (!Number.isFinite(r.gapM)) continue;
    out.push({
      id: r.peerId,
      name: r.name,
      gapM: r.gapM,
      offset: groupOffset(r.gapM),
      onRoad: Math.abs(r.gapM) <= SCENE_GROUP_RANGE_M,
      speedMps: r.speedMps,
      cadenceRpm: r.cadenceRpm,
      stale: r.stale,
      ...(r.cards && riderFx(r.cards) ? { fx: riderFx(r.cards) } : {}),
    });
  }
  // Farthest first: drawn first, so nearer riders end up in front.
  out.sort((a, b) => Math.abs(b.gapM) - Math.abs(a.gapM));
  return out;
}

// ───────────────────────── words ─────────────────────────

/** The scene's accessible name: gradient, speed and cadence in words. */
export function describeScene(
  state: 'idle' | 'riding' | 'paused',
  gradePercent: number,
  speedMps: number,
  cadenceRpm: number,
): string {
  const g = Math.round(gradePercent * 10) / 10;
  const slope =
    g === 0
      ? 'Flat road'
      : g > 0
        ? `Climbing at ${Math.abs(g).toFixed(1)} percent`
        : `Descending at ${Math.abs(g).toFixed(1)} percent`;
  const kmh = Math.round(speedMps * 3.6);
  const rpm = Math.round(cadenceRpm);
  const status = state === 'idle' ? 'Ride not started. ' : state === 'paused' ? 'Paused. ' : '';
  return `${status}${slope}, ${kmh} kilometres per hour, cadence ${rpm} rpm.`;
}
