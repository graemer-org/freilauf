/**
 * Display smoothing for power: a time-based moving average over the incoming
 * power readings. Only for what is shown (the big power number, W/kg, the overlay);
 * nothing recorded or sent to the trainer reads it.
 *
 * Each reading holds its value from the moment it arrived until the next reading, but at most
 * `holdMs` (a dropped sensor). Time after that counts as 0 W, so the average decays to 0 when
 * readings stop instead of hanging on the last value. The average covers the last `windowS`
 * seconds, or less right after the first reading (time before it is not known, not 0 W).
 * Irregular intervals are weighted by the time each reading held. Window 0 = off: the latest
 * reading while it is fresh, else 0.
 */

/** The longest window offered (Settings → Ride → Power smoothing); history kept for it. */
export const MAX_POWER_SMOOTHING_S = 5;

export interface PowerSmootherOptions {
  /** Averaging window in seconds; 0 = off. Clamped to 0 … MAX_POWER_SMOOTHING_S. */
  windowS: number;
  /** How long one reading counts without a newer one (ms). */
  holdMs: number;
}

interface Reading {
  at: number;
  watts: number;
}

export class PowerSmoother {
  #windowMs: number;
  readonly #holdMs: number;
  #readings: Reading[] = [];
  /** When the first reading (since construction or reset) arrived; null = none yet. */
  #since: number | null = null;

  constructor(options: PowerSmootherOptions) {
    this.#windowMs = clampWindowMs(options.windowS);
    this.#holdMs = Math.max(0, options.holdMs);
  }

  get windowS(): number {
    return this.#windowMs / 1000;
  }

  /** Changes the window; takes effect at once (the history covers the longest window). */
  setWindow(windowS: number): void {
    this.#windowMs = clampWindowMs(windowS);
  }

  /** Adds a reading at time `at` (ms). Non-finite values are ignored; negatives count as 0. */
  add(watts: number, at: number): void {
    if (!Number.isFinite(watts) || !Number.isFinite(at)) return;
    const last = this.#readings.at(-1);
    // A clock that steps back must not reorder the history.
    const t = last ? Math.max(at, last.at) : at;
    if (last && last.at === t) last.watts = Math.max(0, watts);
    else this.#readings.push({ at: t, watts: Math.max(0, watts) });
    if (this.#since === null) this.#since = t;
    this.#prune(t);
  }

  /** Forgets all readings (e.g. a new ride session). */
  reset(): void {
    this.#readings = [];
    this.#since = null;
  }

  /** The smoothed power at time `now` (ms). */
  value(now: number): number {
    const readings = this.#readings;
    if (readings.length === 0 || this.#since === null) return 0;
    this.#prune(now);
    if (this.#windowMs === 0) {
      const last = readings.at(-1);
      return last && now - last.at <= this.#holdMs ? last.watts : 0;
    }
    const from = Math.max(now - this.#windowMs, this.#since);
    const span = now - from;
    if (span <= 0) {
      // A reading that arrived just now: nothing has been averaged yet.
      const last = readings.at(-1)!;
      return now - last.at <= this.#holdMs ? last.watts : 0;
    }
    let energy = 0;
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i]!;
      const next = readings[i + 1]?.at ?? Infinity;
      const end = Math.min(next, r.at + this.#holdMs, now);
      const start = Math.max(r.at, from);
      if (end > start) energy += r.watts * (end - start);
    }
    return energy / span;
  }

  /** Drops readings that ended before the longest window, so the history stays small. */
  #prune(now: number): void {
    const horizon = now - MAX_POWER_SMOOTHING_S * 1000;
    const readings = this.#readings;
    let drop = 0;
    while (drop < readings.length) {
      const r = readings[drop]!;
      const next = readings[drop + 1]?.at ?? Infinity;
      if (Math.min(next, r.at + this.#holdMs) > horizon) break;
      drop++;
    }
    if (drop > 0) readings.splice(0, drop);
  }
}

function clampWindowMs(windowS: number): number {
  if (!Number.isFinite(windowS) || windowS <= 0) return 0;
  return Math.min(windowS, MAX_POWER_SMOOTHING_S) * 1000;
}
