/**
 * Pure display formatting for live values. No React, no DOM — shared by the
 * main window and the overlay.
 *
 * Conventions: `formatX` helpers include the unit ("12.34 km"); `statValue`
 * returns the bare number string and `statUnit` the unit, so tiles can style
 * them separately. Missing or non-finite values render as an en dash.
 */
import type { RideSnapshot } from '@freilauf/session';
import type { StatId } from '../../../shared/contract';

/** Shown for any value that is unknown or not a finite number. */
export const MISSING = '–';
/** Typographic minus (U+2212); lines up with "+" in tabular figures. */
const MINUS = '−';

const isFiniteNumber = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Fixed decimals with a typographic minus and no "-0". */
function fixed(value: number, decimals: number): string {
  const text = Math.abs(value).toFixed(decimals);
  const isZero = Number(text) === 0;
  return value < 0 && !isZero ? `${MINUS}${text}` : text;
}

/** `1:02:03` from one hour up, `12:34` / `0:05` below. Negative clamps to 0. */
export function formatDuration(seconds: number): string {
  if (!isFiniteNumber(seconds)) return MISSING;
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Metres → `12.34 km`. */
export function formatDistance(meters: number): string {
  if (!isFiniteNumber(meters)) return MISSING;
  return `${fixed(meters / 1000, 2)} km`;
}

/** Metres per second → `32.1 km/h`. */
export function formatSpeed(mps: number): string {
  if (!isFiniteNumber(mps)) return MISSING;
  return `${fixed(mps * 3.6, 1)} km/h`;
}

/**
 * Gap to the local rider: `+120 m` ahead, `−1.2 km` behind, `0 m` level.
 * Metres are rounded to whole metres below 1 km, kilometres to 0.1 above.
 */
export function formatGap(meters: number): string {
  if (!isFiniteNumber(meters)) return MISSING;
  const abs = Math.abs(meters);
  const rounded = Math.round(abs);
  if (rounded === 0) return '0 m';
  const sign = meters < 0 ? MINUS : '+';
  if (rounded < 1000) return `${sign}${rounded} m`;
  return `${sign}${(abs / 1000).toFixed(1)} km`;
}

const LABELS: Record<StatId, string> = {
  power: 'Power',
  power3s: '3 s power',
  wattsPerKg: 'W/kg',
  cadence: 'Cadence',
  speed: 'Speed',
  heartRate: 'Heart rate',
  gear: 'Gear',
  time: 'Time',
  distance: 'Distance',
  gradient: 'Gradient',
  targetPower: 'Target power',
  intervalRemaining: 'Step left',
  routeRemaining: 'Route left',
  ascentRemaining: 'Climb left',
  elevation: 'Elevation',
  calories: 'Calories',
  fatGrams: 'Fat (est.)',
};

const UNITS: Record<StatId, string> = {
  power: 'W',
  power3s: 'W',
  wattsPerKg: 'W/kg',
  cadence: 'rpm',
  speed: 'km/h',
  heartRate: 'bpm',
  gear: '',
  time: '',
  distance: 'km',
  gradient: '%',
  targetPower: 'W',
  intervalRemaining: '',
  routeRemaining: 'km',
  ascentRemaining: 'm',
  elevation: 'm',
  calories: 'kcal',
  fatGrams: 'g',
};

export function statLabel(stat: StatId): string {
  return LABELS[stat];
}

/** Unit to show next to `statValue`; empty for gear and time. */
export function statUnit(stat: StatId): string {
  return UNITS[stat];
}

const round = (v: number): string => (isFiniteNumber(v) ? fixed(Math.round(v), 0) : MISSING);
const dec = (v: number, d: number): string => (isFiniteNumber(v) ? fixed(v, d) : MISSING);

/** The bare display value of a stat (no unit), `–` when missing. */
export function statValue(
  stat: StatId,
  ride: RideSnapshot,
  workout?: { targetPowerW: number | null; segmentRemainingS: number; finished: boolean } | null,
  route?: { remainingM: number; ascentRemainingM: number; elevationM: number } | null,
  /** Energy estimates of the ride so far (docs/energy.md); null = nothing to show. */
  energy?: { kcal: number | null; fatG: number | null } | null,
): string {
  switch (stat) {
    case 'power':
      return round(ride.powerW);
    case 'power3s':
      return round(ride.power3sW);
    case 'wattsPerKg':
      return dec(ride.wattsPerKg, 1);
    case 'cadence':
      return round(ride.cadenceRpm);
    case 'speed':
      return dec(ride.speedMps * 3.6, 1);
    case 'heartRate':
      return ride.heartRateBpm === null ? MISSING : round(ride.heartRateBpm);
    case 'gear':
      if (!isFiniteNumber(ride.gear) || !isFiniteNumber(ride.gearCount) || ride.gearCount < 1) {
        return MISSING;
      }
      return `${ride.gear} / ${ride.gearCount}`;
    case 'time':
      return formatDuration(ride.elapsedS);
    case 'distance':
      return dec(ride.distanceM / 1000, 2);
    case 'gradient': {
      if (!isFiniteNumber(ride.gradePercent)) return MISSING;
      const text = fixed(ride.gradePercent, 1);
      return ride.gradePercent > 0 && Number(text) !== 0 ? `+${text}` : text;
    }
    case 'targetPower':
      // No workout, or a free-ride block: there is no target to show.
      return workout && !workout.finished && workout.targetPowerW !== null
        ? round(workout.targetPowerW)
        : MISSING;
    case 'intervalRemaining':
      return workout && !workout.finished ? formatDuration(workout.segmentRemainingS) : MISSING;
    case 'routeRemaining':
      return route ? dec(route.remainingM / 1000, 1) : MISSING;
    case 'ascentRemaining':
      return route ? round(route.ascentRemainingM) : MISSING;
    case 'elevation':
      return route ? round(route.elevationM) : MISSING;
    case 'calories':
      return energy?.kcal != null ? round(energy.kcal) : MISSING;
    case 'fatGrams':
      return energy?.fatG != null ? round(energy.fatG) : MISSING;
  }
}

/** `612 kcal`; `–` when unknown. */
export function formatKcal(kcal: number | null | undefined): string {
  return isFiniteNumber(kcal) ? `${fixed(Math.round(kcal), 0)} kcal` : MISSING;
}

/** Grams, whole: `38 g`; `–` when unknown. */
export function formatGrams(grams: number | null | undefined): string {
  return isFiniteNumber(grams) ? `${fixed(Math.round(grams), 0)} g` : MISSING;
}
