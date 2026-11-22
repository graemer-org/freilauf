import { createEmitter } from '@freilauf/devices';
import type {
  ConnectionState,
  SimulationParams,
  Trainer,
  TrainerData,
  Unsubscribe,
} from '@freilauf/devices';
import type { TimerHandle } from './clock';
import { SimulatedDevice } from './device-base';
import type { SimulatedDeviceOptions } from './device-base';
import { createSeededRandom, SmoothNoise } from './random';
import type { RandomSource } from './random';

const G = 9.81;
/** Physics sub-step; keeps the explicit integration stable at 4 Hz ticks. */
const MAX_SUBSTEP_S = 0.05;
/** Below this flywheel speed the rider's force is capped (torque limit). */
const MIN_FORCE_SPEED_MPS = 1;

export const DEFAULT_SIMULATION_PARAMS: SimulationParams = {
  gradePercent: 0,
  crr: 0.004,
  windResistanceKgM: 0.51,
  windSpeedMps: 0,
};

export type SimulatedTrainerCommand =
  | { type: 'simulation'; params: SimulationParams; at: number }
  | { type: 'targetPower'; watts: number; at: number };

export type SimulatedTrainerMode = 'sim' | 'erg';

export interface SimulatedTrainerOptions extends SimulatedDeviceOptions {
  /** Data rate. Default 250 ms (4 Hz). */
  intervalMs?: number;
  /** Initial rider effort in watts. Default 200. */
  riderEffortW?: number;
  /** Total system mass used for gravity and rolling resistance. Default 85 kg. */
  massKg?: number;
  /** Effective mass of the flywheel for acceleration. Default = massKg (road-like feel). */
  inertiaKg?: number;
  /** Physical gear ratio (chainring / cog) the bike is in on the trainer. Default 2.4. */
  gearRatio?: number;
  /** Default 2.105 m (700x25c). */
  wheelCircumferenceM?: number;
  /** Cadence at which the rider starts to spin out. Default 120 rpm. */
  spinOutStartRpm?: number;
  /** Hard cadence ceiling; rider power is 0 at this cadence. Default 130 rpm. */
  maxCadenceRpm?: number;
  /** Cadence the rider holds in ERG mode. Default 90 rpm. */
  ergCadenceRpm?: number;
  /** Smooth power noise as a fraction of the target (std dev). Default 0.03; 0 disables. */
  powerNoise?: number;
  /** Time constant of the rider's/ERG brake's power response. Default 1 s (ERG: 1.5 s). */
  powerResponseS?: number;
  ergResponseS?: number;
  /** Seed for the default PRNG. Default 1. Ignored when `random` is given. */
  seed?: number;
  random?: RandomSource;
}

/**
 * A smart trainer in simulation mode with a fixed physical gear, ridden by a
 * simulated rider holding a target power. Grade changes change the resistance
 * at the flywheel, so at equal power cadence drops when the (virtual) grade
 * rises — which is what makes virtual shifting observable.
 */
export class SimulatedTrainer extends SimulatedDevice<'trainer'> implements Trainer {
  readonly kind = 'trainer' as const;
  /** Every accepted command, in order. */
  readonly commands: SimulatedTrainerCommand[] = [];

  private readonly dataEmitter = createEmitter<TrainerData>();
  private readonly intervalMs: number;
  private readonly massKg: number;
  private readonly inertiaKg: number;
  private readonly gearRatio: number;
  private readonly wheelCircumferenceM: number;
  private readonly spinOutStartRpm: number;
  private readonly maxCadenceRpm: number;
  private readonly ergCadenceRpm: number;
  private readonly powerResponseS: number;
  private readonly ergResponseS: number;
  private readonly noise: SmoothNoise;

  private _riderEffortW: number;
  private _mode: SimulatedTrainerMode = 'sim';
  private _simulation: SimulationParams = { ...DEFAULT_SIMULATION_PARAMS };
  private _targetPowerW = 0;
  private speedMps = 0;
  private appliedPowerW = 0;
  private ticker: TimerHandle | undefined;
  private lastTickAt = 0;
  private _latest: TrainerData | undefined;

  constructor(options: SimulatedTrainerOptions = {}) {
    super({ id: 'sim-trainer', name: 'Simulated Trainer' }, options);
    this.intervalMs = options.intervalMs ?? 250;
    this._riderEffortW = Math.max(0, options.riderEffortW ?? 200);
    this.massKg = options.massKg ?? 85;
    this.inertiaKg = options.inertiaKg ?? this.massKg;
    this.gearRatio = options.gearRatio ?? 2.4;
    this.wheelCircumferenceM = options.wheelCircumferenceM ?? 2.105;
    this.spinOutStartRpm = options.spinOutStartRpm ?? 120;
    this.maxCadenceRpm = options.maxCadenceRpm ?? 130;
    this.ergCadenceRpm = options.ergCadenceRpm ?? 90;
    this.powerResponseS = options.powerResponseS ?? 1;
    this.ergResponseS = options.ergResponseS ?? 1.5;
    const random = options.random ?? createSeededRandom(options.seed ?? 1);
    this.noise = new SmoothNoise(random, options.powerNoise ?? 0.03, 2);
  }

  // ─────────────── Trainer contract ───────────────

  onData(listener: (data: TrainerData) => void): Unsubscribe {
    return this.dataEmitter.on(listener);
  }

  setSimulation(params: SimulationParams): Promise<void> {
    try {
      this.requireConnected('setSimulation');
    } catch (err) {
      return Promise.reject(err);
    }
    this._simulation = { ...params };
    this._mode = 'sim';
    this.commands.push({ type: 'simulation', params: { ...params }, at: this.scheduler.now() });
    return Promise.resolve();
  }

  setTargetPower(watts: number): Promise<void> {
    try {
      this.requireConnected('setTargetPower');
    } catch (err) {
      return Promise.reject(err);
    }
    this._targetPowerW = Math.max(0, watts);
    this._mode = 'erg';
    this.commands.push({ type: 'targetPower', watts, at: this.scheduler.now() });
    return Promise.resolve();
  }

  // ─────────────── Simulation controls / introspection ───────────────

  /** The power the simulated rider tries to hold in sim mode. */
  setRiderEffort(watts: number): void {
    this._riderEffortW = Math.max(0, watts);
  }

  get riderEffortW(): number {
    return this._riderEffortW;
  }

  get mode(): SimulatedTrainerMode {
    return this._mode;
  }

  get simulation(): SimulationParams {
    return { ...this._simulation };
  }

  get targetPowerW(): number {
    return this._targetPowerW;
  }

  get flywheelSpeedMps(): number {
    return this.speedMps;
  }

  /** The last emitted measurement. */
  get latest(): TrainerData | undefined {
    return this._latest;
  }

  /** Cadence implied by a flywheel speed in the fixed physical gear. */
  cadenceForSpeed(speedMps: number): number {
    return (speedMps / (this.gearRatio * this.wheelCircumferenceM)) * 60;
  }

  /** Resisting force at the flywheel for the current simulation parameters. */
  resistingForceN(speedMps: number): number {
    const { gradePercent, crr, windResistanceKgM, windSpeedMps } = this._simulation;
    const theta = Math.atan(gradePercent / 100);
    const gravity = this.massKg * G * Math.sin(theta);
    const rolling = this.massKg * G * crr * Math.cos(theta);
    const air = speedMps + windSpeedMps;
    const aero = windResistanceKgM * air * Math.abs(air);
    // A trainer brake can only resist, never push the flywheel.
    return Math.max(0, gravity + rolling + aero);
  }

  // ─────────────── Lifecycle hooks ───────────────

  protected override onConnected(_prev: ConnectionState): void {
    this.lastTickAt = this.scheduler.now();
    this.ticker = this.scheduler.setInterval(() => this.tick(), this.intervalMs);
  }

  protected override onLinkLost(): void {
    if (this.ticker !== undefined) this.scheduler.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  // ─────────────── Physics ───────────────

  private tick(): void {
    const now = this.scheduler.now();
    // Clamp so a stalled clock or a long pause does not blow up the integration.
    const dt = Math.min(1, Math.max(0, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;
    this.advance(dt);
    const data = this.measurement();
    this._latest = data;
    this.dataEmitter.emit(data);
  }

  private advance(dtS: number): void {
    if (dtS <= 0) return;
    const steps = Math.max(1, Math.ceil(dtS / MAX_SUBSTEP_S));
    const h = dtS / steps;
    for (let i = 0; i < steps; i++) {
      const noise = this.noise.step(h);
      if (this._mode === 'erg') this.stepErg(h, noise);
      else this.stepSim(h, noise);
    }
  }

  private stepSim(h: number, noise: number): void {
    const cadence = this.cadenceForSpeed(this.speedMps);
    const target = this._riderEffortW * (1 + noise) * this.spinOutFactor(cadence);
    this.appliedPowerW += (target - this.appliedPowerW) * (1 - Math.exp(-h / this.powerResponseS));
    const riderForce = this.appliedPowerW / Math.max(this.speedMps, MIN_FORCE_SPEED_MPS);
    const accel = (riderForce - this.resistingForceN(this.speedMps)) / this.inertiaKg;
    this.speedMps = Math.max(0, this.speedMps + accel * h);
  }

  private stepErg(h: number, noise: number): void {
    // The brake regulates power; the rider just holds a comfortable cadence.
    const target = this._targetPowerW * (1 + noise);
    this.appliedPowerW += (target - this.appliedPowerW) * (1 - Math.exp(-h / this.ergResponseS));
    const targetSpeed =
      this._targetPowerW > 0
        ? (this.ergCadenceRpm / 60) * this.gearRatio * this.wheelCircumferenceM
        : 0;
    this.speedMps += (targetSpeed - this.speedMps) * (1 - Math.exp(-h / 2));
  }

  private spinOutFactor(cadenceRpm: number): number {
    if (cadenceRpm <= this.spinOutStartRpm) return 1;
    if (cadenceRpm >= this.maxCadenceRpm) return 0;
    return (this.maxCadenceRpm - cadenceRpm) / (this.maxCadenceRpm - this.spinOutStartRpm);
  }

  private measurement(): TrainerData {
    const powerW = Math.max(0, Math.round(this.appliedPowerW));
    const pedalling = this.appliedPowerW >= 1;
    const cadence = pedalling
      ? Math.min(this.maxCadenceRpm, this.cadenceForSpeed(this.speedMps))
      : 0;
    return {
      powerW,
      cadenceRpm: Math.round(cadence * 2) / 2,
      speedKph: Math.round(this.speedMps * 3.6 * 100) / 100,
    };
  }
}
