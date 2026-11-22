/**
 * Injectable time source and timers for the simulated devices, so tests can
 * drive them deterministically. Defaults resolve the globals lazily (at call
 * time), which keeps them compatible with fake-timer libraries.
 */
export type TimerHandle = unknown;

export interface SimScheduler {
  /** Milliseconds; only differences are used. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

interface TimerGlobals {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  Date: { now(): number };
}

const g = (): TimerGlobals => globalThis as unknown as TimerGlobals;

export const globalScheduler: SimScheduler = {
  now: () => g().Date.now(),
  setTimeout: (fn, ms) => g().setTimeout(fn, ms),
  clearTimeout: (h) => g().clearTimeout(h),
  setInterval: (fn, ms) => g().setInterval(fn, ms),
  clearInterval: (h) => g().clearInterval(h),
};
