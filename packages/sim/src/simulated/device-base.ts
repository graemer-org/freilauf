import { clampBatteryPercent, createEmitter } from '@freilauf/devices';
import type {
  BatterySide,
  BatterySource,
  BatteryState,
  ConnectionState,
  DeviceKind,
  Unsubscribe,
} from '@freilauf/devices';
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
  /**
   * Battery level(s) in %, as a real device would report them: `percent` for
   * the device as a whole, `left` / `right` per grip (controllers). Default:
   * no battery. Change later with setBattery().
   */
  battery?: SimulatedBattery;
}

export interface SimulatedBattery {
  percent?: number;
  left?: number;
  right?: number;
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
  private readonly batteryEmitter = createEmitter<BatteryState>();
  private batteryLevels: SimulatedBattery = {};
  private batteryAt = 0;
  private batteryState: BatteryState | null = null;

  constructor(defaults: { id: string; name: string }, options: SimulatedDeviceOptions) {
    this.id = options.id ?? defaults.id;
    this.name = options.name ?? defaults.name;
    this.connectDelayMs = options.connectDelayMs ?? 300;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2000;
    this.failConnect = options.failConnect ?? false;
    this.scheduler = options.scheduler ?? globalScheduler;
    if (options.battery) {
      this.batteryLevels = { ...options.battery };
      this.batteryAt = this.scheduler.now();
    }
  }

  /** The current simulated battery level; null for none. */
  get battery(): BatteryState | null {
    // Built lazily: `kind` is not set yet while the base constructor runs.
    if (!this.batteryState) this.batteryState = this.buildBattery();
    return this.batteryState;
  }

  onBattery(listener: (state: BatteryState) => void): Unsubscribe {
    return this.batteryEmitter.on(listener);
  }

  /**
   * Test hook: sets the battery level in % (null removes it). With `side`,
   * only that grip changes; without, the device as a whole (and both grips
   * are forgotten).
   */
  setBattery(percent: number | null, side?: BatterySide): void {
    const next: SimulatedBattery = side ? { ...this.batteryLevels } : {};
    if (side) {
      if (percent === null) delete next[side];
      else next[side] = clampBatteryPercent(percent);
    } else if (percent !== null) {
      next.percent = clampBatteryPercent(percent);
    }
    this.applyBattery(next);
  }

  private applyBattery(levels: SimulatedBattery): void {
    this.batteryLevels = levels;
    this.batteryAt = this.scheduler.now();
    this.batteryState = null;
    const state = this.battery;
    if (state) this.batteryEmitter.emit(state);
  }

  private buildBattery(): BatteryState | null {
    const levels = this.batteryLevels;
    const known = [levels.percent, levels.left, levels.right]
      .filter((v): v is number => v !== undefined)
      .map(clampBatteryPercent);
    if (known.length === 0) return null;
    // Controllers report through their own protocol, everything else through the Battery Service.
    const source: BatterySource =
      this.kind === 'controller' ? 'controller-protocol' : 'battery-service';
    return {
      percent: Math.min(...known),
      ...(levels.left !== undefined ? { left: clampBatteryPercent(levels.left) } : {}),
      ...(levels.right !== undefined ? { right: clampBatteryPercent(levels.right) } : {}),
      source,
      updatedAt: this.batteryAt,
    };
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
