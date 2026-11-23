/**
 * Builds synthetic `RouteTrack`s from a list of legs (length, total turn,
 * gradient) for the scene's unit tests. Not used by the app.
 */
import type { RouteTrack } from '@freilauf/routes';

export interface Leg {
  lengthM: number;
  /** Total heading change over the leg, degrees; + = right. */
  turnDeg?: number;
  gradePercent?: number;
}

export function syntheticTrack(
  legs: readonly Leg[],
  opts: { stepM?: number; loop?: boolean; startHeadingDeg?: number } = {},
): RouteTrack {
  const stepM = opts.stepM ?? 10;
  const elevationM = [100];
  const headingRad = [((opts.startHeadingDeg ?? 0) * Math.PI) / 180];
  const x = [0];
  const y = [0];
  for (const leg of legs) {
    const steps = Math.max(1, Math.round(leg.lengthM / stepM));
    const dh = ((leg.turnDeg ?? 0) * Math.PI) / 180 / steps;
    const de = ((leg.gradePercent ?? 0) / 100) * stepM;
    for (let i = 0; i < steps; i++) {
      const h = headingRad[headingRad.length - 1]! + dh;
      const mid = h - dh / 2;
      headingRad.push(h);
      elevationM.push(elevationM[elevationM.length - 1]! + de);
      x.push(x[x.length - 1]! + Math.sin(mid) * stepM);
      y.push(y[y.length - 1]! + Math.cos(mid) * stepM);
    }
  }
  const count = elevationM.length;
  let ascentM = 0;
  let descentM = 0;
  for (let i = 1; i < count; i++) {
    const d = elevationM[i]! - elevationM[i - 1]!;
    if (d > 0) ascentM += d;
    else descentM -= d;
  }
  return {
    id: 'synthetic',
    name: 'Synthetic',
    stepM,
    count,
    totalDistanceM: (count - 1) * stepM,
    elevationM,
    x,
    y,
    headingRad,
    lat: elevationM.map(() => 0),
    lon: elevationM.map(() => 0),
    ascentM,
    descentM,
    loop: opts.loop ?? false,
  };
}
