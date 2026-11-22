import { createEmitter } from '@freilauf/devices';
import type { ConnectionState, DeviceKind, Unsubscribe } from '@freilauf/devices';
import { globalScheduler } from './clock';
import type { SimScheduler, TimerHandle } from './clock';

export interface SimulatedDeviceOptions {
  id?: string;
  name?: string;
  /** Delay before connect() resolves (and before a reconnect succeeds). Default 300 ms. */
  connectDelayMs?: number;
  /** Time spent in `reconnecting` after simulateDrop() before retrying. Default 2000 ms. */
  reconnectDelayMs?: number;
  /** When true, connect() rejects after the delay and reconnect attempts keep failing. */
  failConnect?: boolean;
  scheduler?: SimScheduler;
}

/** Shared connection lifecycle for all simulated devices. */
export abstract class SimulatedDevice<K extends DeviceKind> {
  readonly id: string;
  readonly name: string;
  abstract readonly kind: K;
  /** Test hook: make connects (and reconnect attempts) fail while true. */
  failConnect: boolean;
  connectDelayMs: number;
  reconnectDelayMs: number;

  protected readonly scheduler: SimScheduler;
  private _state: ConnectionState = 'disconnected';
  private readonly stateEmitter = createEmitter<ConnectionState>();
  private pendingTimer: TimerHandle | undefined;
  private pendingReject: ((err: Error) => void) | undefined;

  constructor(defaults: { id: string; name: string }, options: SimulatedDeviceOptions) {
    this.id = options.id ?? defaults.id;
    this.name = options.name ?? defaults.name;
    this.connectDelayMs = options.connectDelayMs ?? 300;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
    this.failConnect = options.failConnect ?? false;
    this.scheduler = options.scheduler ?? globalScheduler;
  }

  get state(): ConnectionState {
    return this._state;
  }

  onState(listener: (state: ConnectionState) => void): Unsubscribe {
    return this.stateEmitter.on(listener);
  }

  connect(): Promise<void> {
    if (this._state === 'connected') return Promise.resolve();
    if (this._state === 'reconnecting') {
      // Already managed; behave like a real device and wait for the link.
      return new Promise((resolve) => {
        const off = this.onState((s) => {
          if (s === 'connected' || s === 'disconnected') {
            off();
            resolve();
          }
        });
      });
    }
    if (this._state === 'connecting') {
      return new Promise((resolve, reject) => {
        const off = this.onState((s) => {
          if (s === 'connected') {
            off();
            resolve();
          } else if (s === 'disconnected') {
            off();
            reject(new Error(`${this.name}: connect failed`));
          }
        });
      });
    }
    this.setState('connecting');
    return new Promise((resolve, reject) => {
      this.pendingReject = reject;
      this.pendingTimer = this.scheduler.setTimeout(() => {
        this.pendingTimer = undefined;
        this.pendingReject = undefined;
        if (this.failConnect) {
          this.setState('disconnected');
          reject(new Error(`${this.name}: simulated connect failure`));
          return;
        }
        this.setState('connected');
        resolve();
      }, this.connectDelayMs);
    });
  }

  disconnect(): Promise<void> {
    this.cancelPending();
    if (this._state !== 'disconnected') this.setState('disconnected');
    return Promise.resolve();
  }

  /**
   * Test hook: the link drops unexpectedly. Goes to `reconnecting`, then back
   * to `connected` after `reconnectDelayMs` (retrying while `failConnect`).
   */
  simulateDrop(): void {
    if (this._state !== 'connected') return;
    this.setState('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.pendingTimer = this.scheduler.setTimeout(() => {
      this.pendingTimer = undefined;
      if (this._state !== 'reconnecting') return;
      if (this.failConnect) {
        this.scheduleReconnect();
        return;
      }
      this.setState('connected');
    }, this.reconnectDelayMs);
  }

  private cancelPending(): void {
    if (this.pendingTimer !== undefined) {
      this.scheduler.clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    const reject = this.pendingReject;
    this.pendingReject = undefined;
    reject?.(new Error(`${this.name}: connect aborted by disconnect()`));
  }

  private setState(state: ConnectionState): void {
    if (state === this._state) return;
    const prev = this._state;
    this._state = state;
    if (state === 'connected') this.onConnected(prev);
    else if (prev === 'connected') this.onLinkLost();
    this.stateEmitter.emit(state);
  }

  /** Called when entering `connected` (initially or after a drop). */
  protected onConnected(_prev: ConnectionState): void {}
  /** Called when leaving `connected` for any reason. */
  protected onLinkLost(): void {}

  protected requireConnected(what: string): void {
    if (this._state !== 'connected') {
      throw new Error(`${this.name}: cannot ${what} while ${this._state}`);
    }
  }
}
