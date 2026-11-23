import type { ConnectionState } from '@freilauf/devices';
import { formatKm, formatRouteKm } from './routeView';
import { formatStepDuration } from './workoutView';

/** The four ways to ride offered on the start screen. */
export type RideKind = 'free' | 'workout' | 'route' | 'ftp';

/** Which start-screen cards are "on" for the current selection (workout and route combine). */
export function activeKinds(
  workout: { ftpTest: boolean } | null,
  routeSelected: boolean,
): Record<RideKind, boolean> {
  return {
    free: workout === null && !routeSelected,
    workout: workout !== null && !workout.ftpTest,
    ftp: workout !== null && workout.ftpTest,
    route: routeSelected,
  };
}

/** `Sweet spot 3×12 · 1 h 7 min` (an open-ended ramp test says so). */
export function workoutLine(name: string, durationS: number, openEnded: boolean): string {
  return `${name} · ${openEnded ? 'open-ended' : formatStepDuration(durationS)}`;
}

/** `Isar Ursprung · 97.6 km · starts at km 42.3`. */
export function routeLine(route: {
  name: string;
  totalDistanceM: number;
  startM?: number;
}): string {
  const start = route.startM ?? 0;
  return `${route.name} · ${formatKm(route.totalDistanceM)}${start > 0 ? ` · starts at ${formatRouteKm(start)}` : ''}`;
}

/** What combining a workout with a route means, in one line. */
export const COMBINED_NOTE =
  'Together: the workout sets the power, the route brings the road and the scenery — its gradient counts only in free-ride steps.';

export interface TrainerNotice {
  tone: 'info' | 'warn';
  text: string;
  /** What the one button next to it does: pair a trainer, or look for the remembered one again. */
  action: 'pair' | 'retry' | null;
}

/**
 * The trainer line under the device chips: nothing while it is connected; a calm note while it
 * is being looked for; a clear (but non-blocking) warning when there is none.
 */
export function trainerNotice(
  state: ConnectionState | null,
  remembered: boolean,
  busy: 'pairing' | 'searching' | undefined,
  simMode: boolean,
): TrainerNotice | null {
  if (state === 'connected') return null;
  if (busy || state === 'connecting' || state === 'reconnecting') {
    return {
      tone: 'info',
      text: 'Looking for your trainer… You can start already; power reads 0 until it connects.',
      action: null,
    };
  }
  return {
    tone: 'warn',
    text: 'No trainer connected. You can still start — power will read 0.',
    action: simMode ? null : remembered ? 'retry' : 'pair',
  };
}
