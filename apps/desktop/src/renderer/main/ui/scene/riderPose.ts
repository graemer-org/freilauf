/**
 * Geometry of the bike and the rider, in metres, side view facing right,
 * y up, origin on the ground halfway between the wheel contact points.
 * Pure: `computePose` fills a preallocated `Pose` so the render loop does
 * not allocate. Proportions follow a medium road bike and a ~1.78 m rider.
 */

import { WHEEL_RADIUS_M } from './sceneMath';

const deg = Math.PI / 180;

export interface Point {
  x: number;
  y: number;
}

const pt = (x: number, y: number): Point => ({ x, y });

/** Fixed bike geometry (does not depend on pose). */
export const BIKE = (() => {
  const r = WHEEL_RADIUS_M;
  const rear = pt(-0.5, r);
  const front = pt(0.5, r);
  const bb = pt(-0.08, 0.27);
  const seatDir = pt(-Math.cos(73.5 * deg), Math.sin(73.5 * deg));
  const forkDir = pt(-Math.cos(72 * deg), Math.sin(72 * deg));
  const along = (o: Point, d: Point, t: number): Point => pt(o.x + d.x * t, o.y + d.y * t);
  return {
    wheelRadius: r,
    rear,
    front,
    bb,
    crankLength: 0.172,
    chainringRadius: 0.1,
    cassetteRadius: 0.045,
    seatTop: along(bb, seatDir, 0.53),
    saddle: along(bb, seatDir, 0.73),
    seatStayTop: along(bb, seatDir, 0.5),
    crown: along(front, forkDir, 0.37),
    headBottom: along(front, forkDir, 0.39),
    headTop: along(front, forkDir, 0.53),
    stemBase: along(front, forkDir, 0.57),
    stemEnd: pt(0.44, 0.875),
    hoods: pt(0.525, 0.89),
    drops: pt(0.488, 0.772),
  };
})();

/** Body segment lengths. */
export const BODY = {
  thigh: 0.45,
  shin: 0.44,
  torso: 0.55,
  upperArm: 0.32,
  forearm: 0.3,
  neck: 0.2,
  headRadius: 0.104,
  /** Ankle relative to the pedal spindle. */
  ankle: pt(-0.055, 0.07),
};

export interface Pose {
  hip: Point;
  shoulder: Point;
  head: Point;
  /** Torso angle above horizontal, radians. */
  torsoAngle: number;
  hand: Point;
  /** Near (+0) and far (+π) leg. */
  pedal: [Point, Point];
  knee: [Point, Point];
  ankle: [Point, Point];
  elbow: Point;
}

export function createPose(): Pose {
  return {
    hip: pt(0, 0),
    shoulder: pt(0, 0),
    head: pt(0, 0),
    torsoAngle: 0,
    hand: pt(0, 0),
    pedal: [pt(0, 0), pt(0, 0)],
    knee: [pt(0, 0), pt(0, 0)],
    ankle: [pt(0, 0), pt(0, 0)],
    elbow: pt(0, 0),
  };
}

/**
 * Two-bone inverse kinematics: places the middle joint `out` between `a`
 * and `c` with segment lengths l1, l2. `side` = +1 bends the joint to the
 * left of a→c (counter-clockwise), −1 to the right. Out-of-reach targets
 * straighten the limb towards the target; never NaN.
 */
export function solveJoint(
  a: Point,
  c: Point,
  l1: number,
  l2: number,
  side: 1 | -1,
  out: Point,
): void {
  const dx = c.x - a.x;
  const dy = c.y - a.y;
  const dRaw = Math.hypot(dx, dy);
  const d = Math.min(Math.max(dRaw, Math.abs(l1 - l2) + 1e-6), l1 + l2 - 1e-6);
  const ux = dRaw > 1e-9 ? dx / dRaw : 1;
  const uy = dRaw > 1e-9 ? dy / dRaw : 0;
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  out.x = a.x + ux * along - uy * h * side;
  out.y = a.y + uy * along + ux * h * side;
}

/**
 * Fills `p` for a crank angle (radians, the near pedal's angle measured
 * counter-clockwise from +x; forward pedalling decreases it), and posture
 * blends: `standing` 0…1 (out of the saddle), `tuck` 0…1 (low and narrow).
 * `pitch` is the bike's visual angle (radians, + uphill): riders lean into a
 * climb and sit back on a descent, so the torso and the gaze compensate part of it.
 */
export function computePose(
  p: Pose,
  crank: number,
  standing: number,
  tuck: number,
  pitch = 0,
): void {
  const L = BIKE.crankLength;
  const s = standing;
  const t = tuck * (1 - s);
  // Small fore-aft sway when standing, twice per crank revolution.
  const sway = s * 0.025 * Math.sin(2 * crank + 0.6);

  // Hip: seated on the saddle; forward when tucked; up and over the BB standing.
  const seatedX = -0.268 + 0.03 * t;
  const seatedY = 1.03 - 0.015 * t;
  p.hip.x = seatedX + (-0.115 - seatedX) * s + sway;
  p.hip.y = seatedY + (1.075 - seatedY) * s - s * 0.012 * Math.cos(2 * crank);

  // Torso: 38° on the hoods, 22° tucked, 41° standing.
  const angle = (38 + (22 - 38) * t + (34 - 38) * s) * deg - pitch * (0.45 + 0.25 * s);
  p.torsoAngle = angle;
  p.shoulder.x = p.hip.x + Math.cos(angle) * BODY.torso;
  p.shoulder.y = p.hip.y + Math.sin(angle) * BODY.torso;

  // Head: looking up the road; the neck rises more the lower the torso.
  const neckAngle = angle + (24 + 18 * t) * deg - pitch * 0.35;
  p.head.x = p.shoulder.x + Math.cos(neckAngle) * BODY.neck;
  p.head.y = p.shoulder.y + Math.sin(neckAngle) * BODY.neck;

  // Hands: hoods, or the drops when tucked.
  p.hand.x = BIKE.hoods.x + (BIKE.drops.x - BIKE.hoods.x) * t;
  p.hand.y = BIKE.hoods.y + (BIKE.drops.y - BIKE.hoods.y) * t;
  // Elbow bends down and back (to the right of shoulder→hand).
  solveJoint(p.shoulder, p.hand, BODY.upperArm, BODY.forearm, -1, p.elbow);

  for (let i = 0; i < 2; i++) {
    const a = crank + (i === 0 ? 0 : Math.PI);
    const pedal = p.pedal[i]!;
    const ankle = p.ankle[i]!;
    pedal.x = BIKE.bb.x + Math.cos(a) * L;
    pedal.y = BIKE.bb.y + Math.sin(a) * L;
    // Gentle ankling: the heel drops a little on the downstroke.
    const ank = 0.25 * Math.sin(a);
    const c = Math.cos(ank);
    const sn = Math.sin(ank);
    ankle.x = pedal.x + BODY.ankle.x * c - BODY.ankle.y * sn;
    ankle.y = pedal.y + BODY.ankle.x * sn + BODY.ankle.y * c;
    // Knee forward of the hip→ankle line (to the left of hip→ankle, which points down).
    solveJoint(p.hip, ankle, BODY.thigh, BODY.shin, 1, p.knee[i]!);
  }
}
