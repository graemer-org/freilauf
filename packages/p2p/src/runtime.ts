/**
 * Small platform shims. `packages/p2p` is type-checked against the plain ES lib (no DOM, no Node),
 * so the few host globals it needs are reached through `globalThis` here, in one place.
 */

export type Unsubscribe = () => void;

/** Injectable timer functions (real ones by default; tests pass a fake clock). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

interface HostGlobals {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  crypto?: { getRandomValues(array: Uint8Array): Uint8Array };
  console?: { error(...args: unknown[]): void };
}

const host = globalThis as unknown as HostGlobals;

export const defaultTimers: Timers = {
  setTimeout: (fn, ms) => host.setTimeout(fn, ms),
  clearTimeout: (h) => host.clearTimeout(h),
  setInterval: (fn, ms) => host.setInterval(fn, ms),
  clearInterval: (h) => host.clearInterval(h),
};

/** Cryptographically random bytes when available, Math.random otherwise. */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (host.crypto) {
    host.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random peer id, 16 chars of [a-z0-9] (~82 bits). */
export function randomPeerId(): string {
  let out = '';
  for (const b of randomBytes(16)) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

export function reportError(context: string, err: unknown): void {
  host.console?.error(`[freilauf/p2p] ${context}`, err);
}

/** Minimal typed multi-event emitter. A throwing listener does not stop the others. */
export class Events<E extends object> {
  #listeners = new Map<keyof E, Set<(value: never) => void>>();

  on<K extends keyof E>(event: K, listener: (value: E[K]) => void): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  emit<K extends keyof E>(event: K, value: E[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set] as Array<(value: E[K]) => void>) {
      try {
        listener(value);
      } catch (err) {
        reportError(`listener for "${String(event)}" failed`, err);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
