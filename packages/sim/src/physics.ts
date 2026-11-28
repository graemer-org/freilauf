/** Parameters of the virtual bike + rider. */
export interface BikeParams {
  /** Rider + bike, kg. */
  totalMassKg: number;
  /** Coefficient of rolling resistance. */
  crr: number;
  /** Drag area CdA in m². */
  cdaM2: number;
  /** Air density in kg/m³. */
  airDensity: number;
}

export const GRAVITY = 9.80665;

export const DEFAULT_BIKE: BikeParams = {
  totalMassKg: 83,
  crr: 0.004,
  cdaM2: 0.32,
  airDensity: 1.225,
};

/** 0.5·ρ·CdA, the "wind resistance coefficient" FTMS talks about, in kg/m. */
export function windResistanceKgM(bike: BikeParams): number {
  return 0.5 * bike.airDensity * bike.cdaM2;
}

/**
 * Head (+) or tail (−) wind along the direction of travel at the rider's height is taken at
 * most this large (m/s, 36 km/h); the route weather already caps it there
 * (docs/adr/0012-historical-wind.md).
 */
export const MAX_HEADWIND_MPS = 10;

const windOf = (headwindMps: number): number =>
  Number.isFinite(headwindMps)
    ? Math.max(-MAX_HEADWIND_MPS, Math.min(MAX_HEADWIND_MPS, headwindMps))
    : 0;

/**
 * Force (N) opposing motion at speed v (m/s) on the given gradient. Negative downhill.
 * `headwindMps` (default 0) is the wind against the direction of travel (negative = tailwind):
 * the air resistance acts on the air speed v + w, so a tailwind faster than the bike pushes.
 */
export function resistingForce(
  speedMps: number,
  gradePercent: number,
  bike: BikeParams,
  headwindMps = 0,
): number {
  const theta = Math.atan(gradePercent / 100);
  const gravity = bike.totalMassKg * GRAVITY * Math.sin(theta);
  const rolling = speedMps > 0 ? bike.totalMassKg * GRAVITY * bike.crr * Math.cos(theta) : 0;
  const air = speedMps + windOf(headwindMps);
  // At a standstill a wind does not roll the bike (the rider holds it): only while moving.
  const aero = speedMps > 0 ? windResistanceKgM(bike) * air * Math.abs(air) : 0;
  return gravity + rolling + aero;
}

/**
 * Deceleration of the virtual bike at full brake, m/s². About 0.5 g: a firm
 * stop on a road bike in the dry (the rear wheel starts to lift at roughly
 * 0.6–0.7 g). From 30 km/h that stops the bike in about 1.6 s over ~7 m.
 */
export const MAX_BRAKE_DECEL_MPS2 = 5;

const MAX_SUBSTEP_S = 0.1;
/** Below this speed the P/v drive force is capped to avoid a singularity at standstill. */
const MIN_DRIVE_SPEED = 1;

/**
 * Advances the virtual bike by dt seconds with the rider producing powerW.
 * Returns the new speed and the distance covered. Speed never goes negative
 * (no rolling backwards on a climb, and a brake only stops the bike).
 *
 * `brake` (0 … 1, default 0) adds a decelerating force proportional to it,
 * up to MAX_BRAKE_DECEL_MPS2 at 1. It only acts while the bike is moving.
 *
 * `headwindMps` (default 0: no wind) is the wind component against the direction of travel at
 * the rider's height (negative = tailwind), capped at ± MAX_HEADWIND_MPS.
 */
export function stepBike(
  speedMps: number,
  powerW: number,
  gradePercent: number,
  bike: BikeParams,
  dtS: number,
  brake = 0,
  headwindMps = 0,
): { speedMps: number; distanceM: number } {
  let v = Math.max(0, speedMps);
  let distance = 0;
  let remaining = Math.max(0, Math.min(dtS, 5)); // a stalled clock must not teleport the rider
  const power = Number.isFinite(powerW) ? Math.max(0, powerW) : 0;
  const brakeForce =
    (Number.isFinite(brake) ? Math.max(0, Math.min(1, brake)) : 0) *
    MAX_BRAKE_DECEL_MPS2 *
    bike.totalMassKg;
  while (remaining > 1e-9) {
    const dt = Math.min(remaining, MAX_SUBSTEP_S);
    const drive = power / Math.max(v, MIN_DRIVE_SPEED);
    const braking = v > 0 ? brakeForce : 0;
    const accel =
      (drive - resistingForce(v, gradePercent, bike, headwindMps) - braking) / bike.totalMassKg;
    const next = Math.max(0, v + accel * dt);
    distance += ((v + next) / 2) * dt;
    v = next;
    remaining -= dt;
  }
  return { speedMps: v, distanceM: distance };
}

/** Speed (m/s) at which powerW exactly balances resistance. Bisection; 0 if the rider cannot move. */
export function steadyStateSpeed(
  powerW: number,
  gradePercent: number,
  bike: BikeParams,
  headwindMps = 0,
): number {
  const net = (v: number) => powerW - resistingForce(v, gradePercent, bike, headwindMps) * v;
  let lo = 0;
  let hi = 40;
  if (net(hi) > 0) return hi;
  // On descents net(v) is positive near 0 even without power; on climbs it is
  // positive only if power > 0. Either way net is decreasing beyond its root.
  if (net(0.01) <= 0) return 0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
