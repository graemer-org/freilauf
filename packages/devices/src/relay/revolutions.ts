/**
 * Turns a continuous quantity (crank turns from cadence, wheel turns from
 * distance) into what a Bluetooth cycling sensor reports: a cumulative count
 * of whole revolutions and the time of the last revolution event, in 1/1024 s
 * (CSC, CPS crank) or 1/2048 s (CPS wheel). Both wrap like on the wire:
 * the count at 2^16 or 2^32, the event time at 2^16 ticks (64 s or 32 s).
 *
 * When nothing turns, no new event happens: count and event time are held,
 * which is how a receiver sees "stopped" (it then reports 0 after a timeout).
 * Within one update the rate is taken as constant, so the event time of the
 * last whole revolution is interpolated linearly inside the interval. Event
 * times are computed from the absolute time since the counter started, so
 * rounding never accumulates.
 */
export class RevolutionCounter {
  readonly ticksPerSecond: number;
  readonly #modulus: number;
  #revs = 0;
  #count: number;
  #eventS: number;
  #lastS: number | null = null;
  readonly #timeOffsetS: number;
  #epochMs: number | null = null;

  constructor(options: {
    ticksPerSecond: 1024 | 2048;
    countBits: 16 | 32;
    /** Starting count (tests use values just below a wrap). */
    initialCount?: number;
    /** Starting event time in seconds (tests use values just below a wrap). */
    initialTimeS?: number;
  }) {
    this.ticksPerSecond = options.ticksPerSecond;
    this.#modulus = 2 ** options.countBits;
    this.#count = options.initialCount ?? 0;
    this.#timeOffsetS = options.initialTimeS ?? 0;
    this.#eventS = this.#timeOffsetS;
  }

  /**
   * Adds `deltaRevs` revolutions that happened between the previous call and
   * `nowMs`. The first call only sets the time base. Non-positive or
   * non-finite deltas add nothing (time still moves on).
   */
  advance(nowMs: number, deltaRevs: number): void {
    if (this.#epochMs === null) this.#epochMs = nowMs;
    const nowS = (nowMs - this.#epochMs) / 1000 + this.#timeOffsetS;
    const lastS = this.#lastS;
    this.#lastS = nowS;
    if (lastS === null || nowS <= lastS || !(deltaRevs > 0) || !Number.isFinite(deltaRevs)) return;
    const before = this.#revs;
    const after = before + deltaRevs;
    const whole = Math.floor(after) - Math.floor(before);
    if (whole > 0) {
      const lastWhole = Math.floor(after);
      this.#eventS = lastS + ((lastWhole - before) / deltaRevs) * (nowS - lastS);
      this.#count += whole;
    }
    this.#revs = after;
  }

  /** Sets the cumulative count (the CSC "Set Cumulative Value" control point). */
  setCount(value: number): void {
    this.#count = Math.max(0, Math.floor(value));
  }

  get cumulativeRevs(): number {
    return this.#count % this.#modulus;
  }

  get lastEventTime(): number {
    return Math.round(this.#eventS * this.ticksPerSecond) & 0xffff;
  }
}
