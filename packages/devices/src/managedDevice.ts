import { BatteryServiceReader, BatteryTracker } from './battery';
import type { BatteryReading, BatteryServiceOptions, BatteryState } from './battery';
import { createEmitter } from './emitter';
import type { Unsubscribe } from './emitter';
import { isTransientLinkError } from './transientErrors';
import type { BlePeripheral, ConnectionState, Device, DeviceKind, GattConnection } from './types';

/** Runs `fn` after `ms`; returns a function that cancels it. */
export type Schedule = (fn: () => void, ms: number) => () => void;

interface TimerGlobals {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** setTimeout-based scheduler (the package has no DOM/Node typings, hence the cast). */
export const defaultSchedule: Schedule = (fn, ms) => {
  const g = globalThis as unknown as TimerGlobals;
  const handle = g.setTimeout(fn, ms);
  return () => g.clearTimeout(handle);
};

export interface BackoffOptions {
  /** Delay before the first reconnect attempt. Default 1000 ms. */
  initialMs?: number;
  /** Upper bound for the delay. Default 15000 ms. */
  maxMs?: number;
  /** Growth factor per failed attempt. Default 2. */
  factor?: number;
}

export interface InitialConnectOptions {
  /** Attempts of the first connect() before it rejects. Default 3. */
  attempts?: number;
  /**
   * Delay before retry n (0-based); the last entry repeats. Default
   * [500, 1000, 2000].
   */
  delaysMs?: number[];
}

export interface ManagedDeviceOptions {
  schedule?: Schedule;
  backoff?: BackoffOptions;
  initialConnect?: InitialConnectOptions;
  /**
   * Standard Battery Service reading after each (re)connect (see
   * BatteryServiceReader); false turns it off. Default on.
   */
  battery?: BatteryServiceOptions | false;
  /** Clock for battery timestamps. Default Date.now. */
  now?: () => number;
}

/** Delay before reconnect attempt number `attempt` (0-based). */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const initial = options.initialMs ?? 1000;
  const max = options.maxMs ?? 15000;
  const factor = options.factor ?? 2;
  return Math.min(max, initial * factor ** attempt);
}

/**
 * A step of a driver's life worth recording in a diagnostic log (link
 * attempts, setup steps, control point exchanges, retries). Purely
 * informational: nothing in the drivers depends on anyone listening.
 */
export interface DeviceDiagnostic {
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Short machine-friendly tag, e.g. "link-up", "retry-scheduled", "cp-response". */
  event: string;
  message: string;
  context?: Record<string, unknown>;
}

export class DeviceDisconnectedError extends Error {
  constructor(message = 'device disconnected') {
    super(message);
    this.name = 'DeviceDisconnectedError';
  }
}

/** A failed link attempt, with whether another attempt may succeed. */
class AttemptFailure {
  readonly error: unknown;
  readonly transient: boolean;
  constructor(error: unknown, transient: boolean) {
    this.error = error;
    this.transient = transient;
  }
}

const unwrap = (err: unknown): unknown => (err instanceof AttemptFailure ? err.error : err);

/**
 * Connection lifecycle shared by all BLE drivers.
 *
 * disconnected → connecting → connected; on unexpected link loss →
 * reconnecting, retried forever with exponential backoff until disconnect().
 * `setup()` runs after every successful link (initial and each reconnect);
 * `onLinkDown()` runs whenever a link that reached setup goes away.
 *
 * connect() retries a bounded number of times (default 3 attempts, 0.5 s /
 * 1 s apart) when an attempt fails with a transient link error — typically
 * Windows dropping the first link right after a scan, while services are
 * being discovered. Other failures (cancelled, not found, not allowed) and
 * the last failed attempt reject connect() and leave the device
 * `disconnected`; disconnect() during the retries rejects it at once.
 * Calling connect() while already connecting returns the same promise;
 * while connected/reconnecting it resolves immediately.
 */
export abstract class ManagedDevice<K extends DeviceKind> implements Device {
  abstract readonly kind: K;
  readonly id: string;
  readonly name: string;

  protected readonly peripheral: BlePeripheral;
  protected readonly schedule: Schedule;
  private readonly backoff: BackoffOptions;
  private readonly initialAttempts: number;
  private readonly initialDelaysMs: number[];
  private readonly stateEmitter = createEmitter<ConnectionState>();
  private readonly diagnosticEmitter = createEmitter<DeviceDiagnostic>();
  private currentState: ConnectionState = 'disconnected';
  private conn: GattConnection | null = null;
  private linkUnsub: Unsubscribe | null = null;
  /** Bumped on every disconnect() so stale async attempts can tell they lost. */
  private generation = 0;
  private attempt = 0;
  private cancelRetry: (() => void) | null = null;
  private connecting: Promise<void> | null = null;
  private readonly batteryOptions: BatteryServiceOptions | false;
  private readonly clock: () => number;
  private readonly batteryTracker = new BatteryTracker();
  private readonly batteryEmitter = createEmitter<BatteryState>();
  private batteryReader: BatteryServiceReader | null = null;

  constructor(peripheral: BlePeripheral, options: ManagedDeviceOptions = {}) {
    this.peripheral = peripheral;
    this.id = peripheral.id;
    this.name = peripheral.name;
    this.schedule = options.schedule ?? defaultSchedule;
    this.backoff = options.backoff ?? {};
    this.initialAttempts = Math.max(1, options.initialConnect?.attempts ?? 3);
    const delays = options.initialConnect?.delaysMs ?? [500, 1000, 2000];
    this.initialDelaysMs = delays.length > 0 ? delays : [0];
    this.batteryOptions = options.battery ?? {};
    this.clock = options.now ?? Date.now;
  }

  /** Subscribe to characteristics, request control, etc. Throwing fails the attempt. */
  protected abstract setup(conn: GattConnection): Promise<void>;

  /** Called when an established link goes away (intentionally or not). */
  protected onLinkDown(): void {}

  get state(): ConnectionState {
    return this.currentState;
  }

  /** The live connection while `connected`, else null. */
  protected get connection(): GattConnection | null {
    return this.currentState === 'connected' ? this.conn : null;
  }

  onState(listener: (state: ConnectionState) => void): Unsubscribe {
    return this.stateEmitter.on(listener);
  }

  /** The last known battery level; null until one was read (or if the device has none). */
  get battery(): BatteryState | null {
    return this.batteryTracker.state;
  }

  /**
   * Fires when a battery level changes (not for a repeated reading of the same
   * value). Not a diagnostic event: the app's device monitor logs it.
   */
  onBattery(listener: (state: BatteryState) => void): Unsubscribe {
    return this.batteryEmitter.on(listener);
  }

  /** For drivers whose protocol reports the battery itself (it then wins over the Battery Service). */
  protected reportBattery(reading: BatteryReading): void {
    const changed = this.batteryTracker.update(reading, this.clock());
    if (!changed) return;
    const state = this.batteryTracker.state!;
    this.batteryEmitter.emit(state);
  }

  /** Starts reading the Battery Service of a link that has just become `connected`. */
  private startBattery(): void {
    this.batteryReader?.stop();
    this.batteryReader = null;
    const conn = this.conn;
    if (!conn || this.batteryOptions === false) return;
    const reader = new BatteryServiceReader(
      conn,
      this.schedule,
      (percent) => this.reportBattery({ percent, source: 'battery-service' }),
      (level, event, message, context) => this.diag(level, event, message, context),
      this.batteryOptions,
    );
    this.batteryReader = reader;
    reader.start();
  }

  /** Lifecycle and protocol steps for a diagnostic log. */
  onDiagnostic(listener: (event: DeviceDiagnostic) => void): Unsubscribe {
    return this.diagnosticEmitter.on(listener);
  }

  protected diag(
    level: DeviceDiagnostic['level'],
    event: string,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    this.diagnosticEmitter.emit(
      context ? { level, event, message, context } : { level, event, message },
    );
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.currentState !== 'disconnected') return Promise.resolve();
    const gen = this.generation;
    this.setState('connecting');
    const p = this.connectWithRetries(gen).then(
      () => {
        this.connecting = null;
        if (gen !== this.generation) {
          throw new DeviceDisconnectedError('disconnected while connecting');
        }
        this.attempt = 0;
        this.setState('connected');
        this.startBattery();
      },
      (err: unknown) => {
        this.connecting = null;
        if (gen === this.generation) this.setState('disconnected');
        throw err;
      },
    );
    this.connecting = p;
    return p;
  }

  private async connectWithRetries(gen: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.tryLink(gen);
        return;
      } catch (failure) {
        const err = unwrap(failure);
        if (gen !== this.generation) {
          throw new DeviceDisconnectedError('disconnected while connecting');
        }
        const transient = failure instanceof AttemptFailure && failure.transient;
        if (!transient || attempt >= this.initialAttempts) {
          if (attempt > 1) {
            this.diag('warn', 'connect-failed', `connect failed after ${attempt} attempts`, {
              attempts: attempt,
              error: err,
            });
          }
          throw err;
        }
        const delay = this.initialDelaysMs[Math.min(attempt - 1, this.initialDelaysMs.length - 1)]!;
        this.diag(
          'warn',
          'connect-retry',
          `connect attempt ${attempt} failed, retrying in ${delay} ms`,
          {
            attempt,
            of: this.initialAttempts,
            delayMs: delay,
            error: err,
          },
        );
        await this.sleepUnlessDisconnected(delay, gen);
      }
    }
  }

  /** Waits `ms`; rejects at once if disconnect() is called meanwhile. */
  private sleepUnlessDisconnected(ms: number, gen: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (gen !== this.generation) {
        reject(new DeviceDisconnectedError('disconnected while connecting'));
        return;
      }
      const cancel = this.schedule(() => {
        this.cancelRetry = null;
        if (gen === this.generation) resolve();
        else reject(new DeviceDisconnectedError('disconnected while connecting'));
      }, ms);
      this.cancelRetry = () => {
        cancel();
        reject(new DeviceDisconnectedError('disconnected while connecting'));
      };
    });
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.attempt = 0;
    const conn = this.conn;
    this.releaseLink();
    this.setState('disconnected');
    if (conn) await conn.disconnect().catch(() => {});
  }

  /**
   * Establishes a link and runs setup. Resolves only if `gen` is still
   * current; rejects with an AttemptFailure.
   */
  private async tryLink(gen: number): Promise<void> {
    const started = Date.now();
    this.diag('debug', 'link-attempt', 'opening GATT link');
    let conn: GattConnection;
    try {
      conn = await this.peripheral.connect();
    } catch (err) {
      this.diag('warn', 'link-failed', 'GATT link failed', {
        ms: Date.now() - started,
        error: err,
      });
      throw new AttemptFailure(err, isTransientLinkError(err));
    }
    this.diag('info', 'link-up', 'GATT link open', { ms: Date.now() - started });
    if (gen !== this.generation) {
      await conn.disconnect().catch(() => {});
      throw new AttemptFailure(new DeviceDisconnectedError('disconnected while connecting'), false);
    }
    let lost = false;
    this.conn = conn;
    this.linkUnsub = conn.onDisconnect(() => {
      lost = true;
      this.handleLinkLost(conn);
    });
    const setupStarted = Date.now();
    try {
      await this.setup(conn);
    } catch (err) {
      this.diag('warn', 'setup-failed', 'setup after link failed', {
        ms: Date.now() - setupStarted,
        error: err,
      });
      if (this.conn === conn) {
        this.releaseLink();
        await conn.disconnect().catch(() => {});
      }
      // Whatever setup threw, a link that went away underneath it is worth retrying.
      throw new AttemptFailure(err, lost || isTransientLinkError(err));
    }
    if (lost || this.conn !== conn) {
      this.diag('warn', 'setup-failed', 'link lost during setup');
      throw new AttemptFailure(new DeviceDisconnectedError('link lost during setup'), true);
    }
    this.diag('info', 'setup-done', 'setup complete', { ms: Date.now() - setupStarted });
  }

  private releaseLink(): void {
    this.batteryReader?.stop();
    this.batteryReader = null;
    if (!this.conn) return;
    this.linkUnsub?.();
    this.linkUnsub = null;
    this.conn = null;
    this.onLinkDown();
  }

  private handleLinkLost(conn: GattConnection): void {
    if (this.conn !== conn) return;
    const wasConnected = this.currentState === 'connected';
    this.diag('warn', 'link-lost', 'link lost unexpectedly', { state: this.currentState });
    this.releaseLink();
    // While a link is still in setup (first connect or a reconnect attempt) the
    // pending tryLink() rejects and its caller handles the failure.
    if (wasConnected) {
      this.setState('reconnecting');
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    const gen = this.generation;
    const delay = backoffDelay(this.attempt, this.backoff);
    this.attempt++;
    this.diag('info', 'retry-scheduled', `reconnect attempt ${this.attempt} in ${delay} ms`, {
      attempt: this.attempt,
      delayMs: delay,
    });
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null;
      if (gen !== this.generation) return;
      this.tryLink(gen).then(
        () => {
          if (gen !== this.generation) return;
          this.attempt = 0;
          this.setState('connected');
          this.startBattery();
        },
        (failure: unknown) => {
          if (gen !== this.generation) return;
          const err = unwrap(failure);
          this.diag('warn', 'retry-failed', `reconnect attempt ${this.attempt} failed`, {
            attempt: this.attempt,
            error: err,
          });
          this.scheduleRetry();
        },
      );
    }, delay);
  }

  private setState(state: ConnectionState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.stateEmitter.emit(state);
  }
}
