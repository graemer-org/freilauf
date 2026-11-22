/**
 * Optional group-workout actions, feature-detected on `App`.
 *
 * Sharing workouts with a group (and starting together) is being added to
 * `App` separately. Until those methods exist, this is the ONE place that
 * looks them up, so the rest of the UI typechecks either way and simply hides
 * the buttons when they are missing. Expected shape on `App`:
 *
 *   shareWorkout(id: string): void | Promise<void>
 *   stopSharingWorkout(): void | Promise<void>
 *   useSharedWorkout(peerId: string): boolean | void | Promise<unknown>
 *   startTogether(seconds: number): void | Promise<void>
 *
 * Once they are part of `App`'s type this file can call them directly.
 */
import type { App } from '../appStore';

type AnyMethod = (...args: unknown[]) => unknown;

function method(app: App, name: string): AnyMethod | null {
  const fn = (app as unknown as Record<string, unknown>)[name];
  if (typeof fn !== 'function') return null;
  return (...args: unknown[]) => (fn as AnyMethod).apply(app, args);
}

/** Ignores the result; reports a rejected promise as a notice instead of an unhandled error. */
function fire(app: App, call: () => unknown): void {
  try {
    const result = call();
    if (result instanceof Promise) {
      result.catch((err: unknown) => app.notify('error', String(err)));
    }
  } catch (err) {
    app.notify('error', err instanceof Error ? err.message : String(err));
  }
}

export interface WorkoutSharing {
  share(id: string): void;
  stop(): void;
  /** Selects a workout another rider shared (named so it does not read as a React hook). */
  adopt(peerId: string): void;
}

/** Share/stop/use, or null when this build's `App` cannot share workouts. */
export function workoutSharing(app: App): WorkoutSharing | null {
  const share = method(app, 'shareWorkout');
  const stop = method(app, 'stopSharingWorkout');
  const adopt = method(app, 'useSharedWorkout');
  if (!share || !stop || !adopt) return null;
  return {
    share: (id) => fire(app, () => share(id)),
    stop: () => fire(app, () => stop()),
    adopt: (peerId) => fire(app, () => adopt(peerId)),
  };
}

/** `startTogether(seconds)`, or null when missing. */
export function startTogetherAction(app: App): ((seconds: number) => void) | null {
  const start = method(app, 'startTogether');
  return start ? (seconds) => fire(app, () => start(seconds)) : null;
}
