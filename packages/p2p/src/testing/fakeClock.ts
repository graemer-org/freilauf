import type { Timers } from '../runtime';

interface Scheduled {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}

/** Deterministic clock + timers. `now` is epoch-like ms; nothing runs until you advance it. */
export class FakeClock {
  #now: number;
  #queue: Scheduled[] = [];
  #nextId = 1;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  /** Pass as a `now` dependency. */
  readonly now = (): number => this.#now;

  readonly timers: Timers = {
    setTimeout: (fn, ms) => this.#schedule(fn, ms, null),
    clearTimeout: (h) => this.#cancel(h),
    setInterval: (fn, ms) => this.#schedule(fn, ms, Math.max(1, ms)),
    clearInterval: (h) => this.#cancel(h),
  };

  get pendingTimers(): number {
    return this.#queue.length;
  }

  /** Moves time forward, running due timers in order (synchronously). */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      this.#queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.#queue[0];
      if (!next || next.at > end) break;
      this.#now = Math.max(this.#now, next.at);
      if (next.every === null) this.#queue.shift();
      else next.at += next.every;
      next.fn();
    }
    this.#now = end;
  }

  /**
   * Like `advance`, but in steps of `stepMs`, letting pending promise callbacks run in between
   * (needed when timers and async code such as WebRTC negotiation interleave).
   */
  async advanceAsync(ms: number, stepMs = 10): Promise<void> {
    let left = ms;
    await flushMicrotasks();
    while (left > 0) {
      const step = Math.min(stepMs, left);
      this.advance(step);
      left -= step;
      await flushMicrotasks();
    }
  }

  #schedule(fn: () => void, ms: number, every: number | null): number {
    const id = this.#nextId++;
    this.#queue.push({ id, at: this.#now + Math.max(0, ms), fn, every });
    return id;
  }

  #cancel(handle: unknown): void {
    this.#queue = this.#queue.filter((t) => t.id !== handle);
  }
}

/** Lets queued promise callbacks (several levels deep) run. */
export async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
