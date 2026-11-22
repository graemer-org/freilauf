import { createEmitter } from './emitter';
import type { Unsubscribe } from './emitter';
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

export interface ManagedDeviceOptions {
  schedule?: Schedule;
  backoff?: BackoffOptions;
}

/** Delay before reconnect attempt number `attempt` (0-based). */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const initial = options.initialMs ?? 1000;
  const max = options.maxMs ?? 15000;
  const factor = options.factor ?? 2;
  return Math.min(max, initial * factor ** attempt);
}

export class DeviceDisconnectedError extends Error {
  constructor(message = 'device disconnected') {
    super(message);
    this.name = 'DeviceDisconnectedError';
  }
}

/**
 * Connection lifecycle shared by all BLE drivers.
 *
 * disconnected → connecting → connected; on unexpected link loss →
 * reconnecting, retried forever with exponential backoff until disconnect().
 * `setup()` runs after every successful link (initial and each reconnect);
 * `onLinkDown()` runs whenever a link that reached setup goes away.
 *
 * connect() rejects if the first attempt (link or setup) fails, leaving the
 * device `disconnected`. Calling connect() while already connecting returns
 * the same promise; while connected/reconnecting it resolves immediately.
 */
export abstract class ManagedDevice<K extends DeviceKind> implements Device {
  abstract readonly kind: K;
  readonly id: string;
  readonly name: string;

  protected readonly peripheral: BlePeripheral;
  protected readonly schedule: Schedule;
  private readonly backoff: BackoffOptions;
  private readonly stateEmitter = createEmitter<ConnectionState>();
  private currentState: ConnectionState = 'disconnected';
  private conn: GattConnection | null = null;
  private linkUnsub: Unsubscribe | null = null;
  /** Bumped on every disconnect() so stale async attempts can tell they lost. */
  private generation = 0;
  private attempt = 0;
  private cancelRetry: (() => void) | null = null;
  private connecting: Promise<void> | null = null;

  constructor(peripheral: BlePeripheral, options: ManagedDeviceOptions = {}) {
    this.peripheral = peripheral;
    this.id = peripheral.id;
    this.name = peripheral.name;
    this.schedule = options.schedule ?? defaultSchedule;
    this.backoff = options.backoff ?? {};
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

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.currentState !== 'disconnected') return Promise.resolve();
    const gen = this.generation;
    this.setState('connecting');
    const p = this.tryLink(gen).then(
      () => {
        this.connecting = null;
        if (gen !== this.generation) throw new DeviceDisconnectedError('disconnected while connecting');
        this.attempt = 0;
        this.setState('connected');
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

  /** Establishes a link and runs setup. Resolves only if `gen` is still current. */
  private async tryLink(gen: number): Promise<void> {
    const conn = await this.peripheral.connect();
    if (gen !== this.generation) {
      await conn.disconnect().catch(() => {});
      throw new DeviceDisconnectedError('disconnected while connecting');
    }
    let lost = false;
    this.conn = conn;
    this.linkUnsub = conn.onDisconnect(() => {
      lost = true;
      this.handleLinkLost(conn);
    });
    try {
      await this.setup(conn);
    } catch (err) {
      if (this.conn === conn) {
        this.releaseLink();
        await conn.disconnect().catch(() => {});
      }
      throw err;
    }
    if (lost || this.conn !== conn) throw new DeviceDisconnectedError('link lost during setup');
  }

  private releaseLink(): void {
    if (!this.conn) return;
    this.linkUnsub?.();
    this.linkUnsub = null;
    this.conn = null;
    this.onLinkDown();
  }

  private handleLinkLost(conn: GattConnection): void {
    if (this.conn !== conn) return;
    const wasConnected = this.currentState === 'connected';
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
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null;
      if (gen !== this.generation) return;
      this.tryLink(gen).then(
        () => {
          if (gen !== this.generation) return;
          this.attempt = 0;
          this.setState('connected');
        },
        () => {
          if (gen !== this.generation) return;
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
