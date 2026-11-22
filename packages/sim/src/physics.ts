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

/** Force (N) opposing motion at speed v (m/s) on the given gradient. Negative downhill. */
export function resistingForce(speedMps: number, gradePercent: number, bike: BikeParams): number {
  const theta = Math.atan(gradePercent / 100);
  const gravity = bike.totalMassKg * GRAVITY * Math.sin(theta);
  const rolling = speedMps > 0 ? bike.totalMassKg * GRAVITY * bike.crr * Math.cos(theta) : 0;
  const aero = windResistanceKgM(bike) * speedMps * Math.abs(speedMps);
  return gravity + rolling + aero;
}

const MAX_SUBSTEP_S = 0.1;
/** Below this speed the P/v drive force is capped to avoid a singularity at standstill. */
const MIN_DRIVE_SPEED = 1;

/**
 * Advances the virtual bike by dt seconds with the rider producing powerW.
 * Returns the new speed and the distance covered. Speed never goes negative
 * (no rolling backwards on a climb).
 */
export function stepBike(
  speedMps: number,
  powerW: number,
  gradePercent: number,
  bike: BikeParams,
  dtS: number,
): { speedMps: number; distanceM: number } {
  let v = Math.max(0, speedMps);
  let distance = 0;
  let remaining = Math.max(0, Math.min(dtS, 5)); // a stalled clock must not teleport the rider
  const power = Number.isFinite(powerW) ? Math.max(0, powerW) : 0;
  while (remaining > 1e-9) {
    const dt = Math.min(remaining, MAX_SUBSTEP_S);
    const drive = power / Math.max(v, MIN_DRIVE_SPEED);
    const accel = (drive - resistingForce(v, gradePercent, bike)) / bike.totalMassKg;
    const next = Math.max(0, v + accel * dt);
    distance += ((v + next) / 2) * dt;
    v = next;
    remaining -= dt;
  }
  return { speedMps: v, distanceM: distance };
}

/** Speed (m/s) at which powerW exactly balances resistance. Bisection; 0 if the rider cannot move. */
export function steadyStateSpeed(powerW: number, gradePercent: number, bike: BikeParams): number {
  const net = (v: number) => powerW - resistingForce(v, gradePercent, bike) * v;
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
