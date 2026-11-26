import type { Unsubscribe } from './emitter';
import type { Schedule } from './managedDevice';
import type { GattConnection } from './types';
import { BATTERY_LEVEL, BATTERY_SERVICE } from './uuids';

// Battery levels of connected devices. Two sources: the standard Battery
// Service (0x180F / Battery Level 0x2A19), which HR straps and some trainers
// and controllers expose, and a device's own protocol (the handlebar
// controllers' battery message, per grip). Purely informational: nothing here
// may fail a connect or get in the way of a driver's own GATT traffic.

/** A grip of a two-part controller. */
export type BatterySide = 'left' | 'right';

/** Where a battery level came from. */
export type BatterySource = 'battery-service' | 'controller-protocol';

/** The last known battery level of a device. */
export interface BatteryState {
  /** The lowest known level, 0 … 100 %: what a compact display shows. */
  percent: number;
  /** Per grip, when the device reports each side separately (controllers). */
  left?: number;
  right?: number;
  source: BatterySource;
  /** When the last reading arrived (ms since the epoch), whether or not the value changed. */
  updatedAt: number;
}

export interface BatteryReading {
  percent: number;
  /** Absent: the level of the device as a whole. */
  side?: BatterySide;
  source: BatterySource;
}

/** Rounds and clamps a level to 0 … 100 %. Some devices report more than 100. */
export function clampBatteryPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Battery Level (0x2A19): one unsigned byte, 0 … 100 %. Values above 100
 * (seen on some straps) are clamped; an empty value yields null. Trailing
 * bytes are ignored.
 */
export function parseBatteryLevel(view: DataView): number | null {
  if (view.byteLength < 1) return null;
  return clampBatteryPercent(view.getUint8(0));
}

/**
 * Merges readings into one BatteryState. A device's own protocol wins over the
 * Battery Service: once a controller has sent its battery message, Battery
 * Service values are ignored (the protocol knows both grips).
 */
export class BatteryTracker {
  #state: BatteryState | null = null;
  #whole: number | undefined;
  #left: number | undefined;
  #right: number | undefined;

  get state(): BatteryState | null {
    return this.#state;
  }

  /** Applies a reading; returns true if a value (not just the time) changed. */
  update(reading: BatteryReading, now: number): boolean {
    const prev = this.#state;
    if (reading.source === 'battery-service' && prev?.source === 'controller-protocol') {
      return false;
    }
    if (reading.source === 'controller-protocol' && prev?.source === 'battery-service') {
      this.#whole = undefined;
    }
    const percent = clampBatteryPercent(reading.percent);
    if (reading.side === 'left') this.#left = percent;
    else if (reading.side === 'right') this.#right = percent;
    else this.#whole = percent;

    const known = [this.#whole, this.#left, this.#right].filter(
      (v): v is number => v !== undefined,
    );
    const next: BatteryState = {
      percent: Math.min(...known),
      ...(this.#left !== undefined ? { left: this.#left } : {}),
      ...(this.#right !== undefined ? { right: this.#right } : {}),
      source: reading.source,
      updatedAt: now,
    };
    this.#state = next;
    return (
      !prev ||
      prev.percent !== next.percent ||
      prev.left !== next.left ||
      prev.right !== next.right ||
      prev.source !== next.source
    );
  }
}

export interface BatteryServiceOptions {
  /** Re-read interval when the device does not notify. Default 5 min. */
  pollMs?: number;
  /**
   * Delay after the link is up before the first battery operation, so it does
   * not race the driver's own setup traffic (e.g. the trainer's control
   * point). Default 2000 ms.
   */
  startDelayMs?: number;
  /** Delay before trying again when a battery operation failed. Default 15 s. */
  retryMs?: number;
  /** Failed attempts at the start before giving up until the next poll. Default 3. */
  retries?: number;
}

export interface BatteryServiceLog {
  (
    level: 'debug' | 'info',
    event: string,
    message: string,
    context?: Record<string, unknown>,
  ): void;
}

/**
 * Reads the standard Battery Level of one connection: once at the start,
 * then from notifications if the device supports them, else every `pollMs`.
 * A device without the Battery Service has no battery level; every GATT
 * error is tolerated (logged and tried again later), since on Windows such
 * operations fail now and then while other traffic runs.
 */
export class BatteryServiceReader {
  readonly #conn: GattConnection;
  readonly #schedule: Schedule;
  readonly #onLevel: (percent: number) => void;
  readonly #log: BatteryServiceLog;
  readonly #pollMs: number;
  readonly #startDelayMs: number;
  readonly #retryMs: number;
  readonly #retries: number;
  #stopped = false;
  #cancelTimer: (() => void) | null = null;
  #unsubscribe: Unsubscribe | null = null;
  #notifying = false;
  #haveValue = false;
  #failures = 0;

  constructor(
    conn: GattConnection,
    schedule: Schedule,
    onLevel: (percent: number) => void,
    log: BatteryServiceLog,
    options: BatteryServiceOptions = {},
  ) {
    this.#conn = conn;
    this.#schedule = schedule;
    this.#onLevel = onLevel;
    this.#log = log;
    this.#pollMs = options.pollMs ?? 5 * 60_000;
    this.#startDelayMs = options.startDelayMs ?? 2000;
    this.#retryMs = options.retryMs ?? 15_000;
    this.#retries = options.retries ?? 3;
  }

  start(): void {
    this.#later(() => void this.#begin(), this.#startDelayMs);
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    const off = this.#unsubscribe;
    this.#unsubscribe = null;
    try {
      off?.();
    } catch {
      // the link is going away anyway
    }
  }

  async #begin(): Promise<void> {
    let has: boolean;
    try {
      has = await this.#conn.hasService(BATTERY_SERVICE);
    } catch (err) {
      this.#failed('battery service lookup failed', err, () => void this.#begin());
      return;
    }
    if (this.#stopped) return;
    if (!has) {
      this.#log('debug', 'no-battery', 'no battery service (no battery level)');
      return;
    }
    await this.#read();
    if (this.#stopped) return;
    try {
      const off = await this.#conn.subscribe(BATTERY_SERVICE, BATTERY_LEVEL, (view) =>
        this.#value(view),
      );
      if (this.#stopped) {
        off();
        return;
      }
      this.#unsubscribe = off;
      this.#notifying = true;
      this.#log('debug', 'battery-subscribed', 'battery level notifications on');
    } catch (err) {
      this.#log('debug', 'battery-no-notify', 'battery level does not notify; polling', {
        everyMs: this.#pollMs,
        error: err,
      });
    }
    this.#next();
  }

  async #read(): Promise<boolean> {
    try {
      const view = await this.#conn.read(BATTERY_SERVICE, BATTERY_LEVEL);
      if (this.#stopped) return false;
      this.#value(view);
      this.#failures = 0;
      return true;
    } catch (err) {
      if (this.#stopped) return false;
      this.#failures++;
      this.#log('debug', 'battery-read-failed', 'battery level read failed (tolerated)', {
        attempt: this.#failures,
        error: err,
      });
      return false;
    }
  }

  #value(view: DataView): void {
    const percent = parseBatteryLevel(view);
    if (percent === null || this.#stopped) return;
    this.#haveValue = true;
    this.#onLevel(percent);
  }

  /** Schedules the next read: a retry while no value came yet, else the poll (without notifications). */
  #next(): void {
    if (this.#stopped) return;
    if (!this.#haveValue && this.#failures > 0 && this.#failures <= this.#retries) {
      this.#later(() => void this.#read().then(() => this.#next()), this.#retryMs);
      return;
    }
    if (this.#notifying) return;
    this.#failures = 0;
    this.#later(() => void this.#read().then(() => this.#next()), this.#pollMs);
  }

  #failed(message: string, err: unknown, again: () => void): void {
    if (this.#stopped) return;
    this.#failures++;
    this.#log('debug', 'battery-failed', `${message} (tolerated)`, {
      attempt: this.#failures,
      error: err,
    });
    this.#later(again, this.#failures <= this.#retries ? this.#retryMs : this.#pollMs);
  }

  #later(fn: () => void, ms: number): void {
    if (this.#stopped) return;
    this.#cancelTimer?.();
    this.#cancelTimer = this.#schedule(() => {
      this.#cancelTimer = null;
      if (!this.#stopped) fn();
    }, ms);
  }
}
