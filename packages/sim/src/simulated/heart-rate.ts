import { createEmitter } from '@freilauf/devices';
import type { ConnectionState, HeartRateSensor, Unsubscribe } from '@freilauf/devices';
import type { TimerHandle } from './clock';
import { SimulatedDevice } from './device-base';
import type { SimulatedDeviceOptions } from './device-base';
import { createSeededRandom, SmoothNoise } from './random';
import type { RandomSource } from './random';

export interface SimulatedHeartRateOptions extends SimulatedDeviceOptions {
  /** Default 1000 ms (1 Hz). */
  intervalMs?: number;
  /** Default 60 bpm. */
  restBpm?: number;
  /** Steady-state increase per watt. Default 0.45 bpm/W. */
  bpmPerWatt?: number;
  /** Default 190 bpm. */
  maxBpm?: number;
  /** First-order lag time constant. Default 30 s. */
  timeConstantS?: number;
  /** Smooth noise std dev in bpm. Default 1; 0 disables. */
  noiseBpm?: number;
  /** Initial heart rate. Default restBpm. */
  initialBpm?: number;
  seed?: number;
  random?: RandomSource;
}

/** A chest strap whose heart rate follows the rider's power with a first-order lag. */
export class SimulatedHeartRate extends SimulatedDevice<'heartRate'> implements HeartRateSensor {
  readonly kind = 'heartRate' as const;

  private readonly hrEmitter = createEmitter<number>();
  private readonly intervalMs: number;
  private readonly restBpm: number;
  private readonly bpmPerWatt: number;
  private readonly maxBpm: number;
  private readonly timeConstantS: number;
  private readonly noise: SmoothNoise;
  private powerW = 0;
  private hr: number;
  private ticker: TimerHandle | undefined;
  private lastTickAt = 0;
  private _latest: number | undefined;

  constructor(options: SimulatedHeartRateOptions = {}) {
    super({ id: 'sim-hr', name: 'Simulated HR' }, options);
    this.intervalMs = options.intervalMs ?? 1000;
    this.restBpm = options.restBpm ?? 60;
    this.bpmPerWatt = options.bpmPerWatt ?? 0.45;
    this.maxBpm = options.maxBpm ?? 190;
    this.timeConstantS = options.timeConstantS ?? 30;
    this.hr = options.initialBpm ?? this.restBpm;
    const random = options.random ?? createSeededRandom(options.seed ?? 2);
    this.noise = new SmoothNoise(random, options.noiseBpm ?? 1, 5);
  }

  onHeartRate(listener: (bpm: number) => void): Unsubscribe {
    return this.hrEmitter.on(listener);
  }

  /** The power the rider is producing; drives the heart rate. */
  setPower(watts: number): void {
    this.powerW = Math.max(0, watts);
  }

  /** Heart rate the model converges to at the current power. */
  get targetBpm(): number {
    return Math.min(this.maxBpm, this.restBpm + this.bpmPerWatt * this.powerW);
  }

  /** Current modelled heart rate (without noise, unrounded). */
  get modelBpm(): number {
    return this.hr;
  }

  get latest(): number | undefined {
    return this._latest;
  }

  protected override onConnected(_prev: ConnectionState): void {
    this.lastTickAt = this.scheduler.now();
    this.ticker = this.scheduler.setInterval(() => this.tick(), this.intervalMs);
  }

  protected override onLinkLost(): void {
    if (this.ticker !== undefined) this.scheduler.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private tick(): void {
    const now = this.scheduler.now();
    const dt = Math.min(5, Math.max(0, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;
    this.hr += (this.targetBpm - this.hr) * (1 - Math.exp(-dt / this.timeConstantS));
    const noisy = this.hr + this.noise.step(dt);
    const bpm = Math.round(Math.min(this.maxBpm, Math.max(30, noisy)));
    this._latest = bpm;
    this.hrEmitter.emit(bpm);
  }
}
