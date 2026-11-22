import type { SimulationParams, Unsubscribe } from '@freilauf/devices';
import { createEmitter } from '@freilauf/devices';
import type { BikeParams } from './physics';
import { windResistanceKgM } from './physics';

/**
 * Virtual drivetrain: 24 sequential gears, expressed as development ratios
 * (chainring teeth / cog teeth). Evenly spread from a 0.75 climbing gear to
 * a 5.49 sprint gear, comparable to a 2×12 road drivetrain without overlaps.
 */
export const DEFAULT_GEAR_RATIOS: readonly number[] = [
  0.75, 0.87, 0.99, 1.11, 1.23, 1.38, 1.53, 1.68, 1.86, 2.04, 2.22, 2.4, 2.61, 2.82, 3.03, 3.24,
  3.49, 3.74, 3.99, 4.24, 4.54, 4.84, 5.14, 5.49,
];

/**
 * The seam between "the rider pressed shift / the road tilted" and "the
 * trainer feels different". SoftwareShifter (below) implements it with FTMS
 * simulation parameters; a native implementation that sends the gear ratio
 * to the trainer over its proprietary protocol can replace it without the
 * rest of the app noticing. See docs/adr/0002-virtual-shifting.md.
 */
export interface Shifter {
  /** Current gear, 1-based. */
  readonly gear: number;
  readonly gearCount: number;
  /** Current gear's ratio (chainring/cog). */
  readonly ratio: number;
  /** Shifts by delta gears (clamped). Returns the new gear. */
  shift(delta: number): number;
  setGear(gear: number): number;
  /** The road gradient the rider should feel, in percent. */
  setGradient(gradePercent: number): void;
  onGear(listener: (gear: number) => void): Unsubscribe;
  /** Re-sends the current state, e.g. after the trainer reconnected. */
  resync(): void;
}

export interface SoftwareShifterOptions {
  bike: BikeParams;
  ratios?: readonly number[];
  initialGear?: number;
  /**
   * Ratio of the gear that is physically on the bike (chainring/cog). In the
   * virtual gear with this ratio the trainer receives the unmodified road.
   */
  physicalRatio?: number;
  /**
   * Total mass the trainer assumes in simulation mode. FTMS cannot set it;
   * if the trainer's value differs from the virtual bike's mass, climbs are
   * scaled accordingly. Defaults to bike.totalMassKg (no correction).
   */
  trainerMassKg?: number;
  /** Trainers clamp the grade they simulate; we clamp first so it is predictable. */
  maxGradePercent?: number;
  minGradePercent?: number;
}

export const DEFAULT_PHYSICAL_RATIO = 2.4;

/** FTMS field limits (uint8 with 0.0001 resp. 0.01 resolution). */
const MAX_CRR = 0.0254;
const MAX_WIND_RESISTANCE = 2.54;

/**
 * Maps (virtual gear, road gradient) to the simulation parameters to send to
 * a trainer whose flywheel is driven through a fixed physical gear.
 *
 * With r = virtualRatio / physicalRatio, the virtual bike moves r times as
 * fast as the trainer's flywheel "bike" at the same cadence. For the rider
 * to feel the same crank torque as on the virtual bike, the trainer has to
 * produce the same power at its own speed v_t = v / r:
 *
 *   F_t(v_t) = r · F_virtual(r · v_t)
 *            = r · m·g·(grade + crr)  +  r³ · ½ρCdA · v_t²
 *
 * So gravity and rolling terms scale with r (and with m / m_trainer, since
 * the trainer multiplies by its own mass), the aero coefficient with r³.
 */
export function effectiveSimulation(
  virtualRatio: number,
  gradePercent: number,
  options: SoftwareShifterOptions,
): SimulationParams {
  const physicalRatio = options.physicalRatio ?? DEFAULT_PHYSICAL_RATIO;
  const trainerMass = options.trainerMassKg ?? options.bike.totalMassKg;
  const r = virtualRatio / physicalRatio;
  const k = r * (options.bike.totalMassKg / trainerMass);

  // Rolling resistance goes into the Crr field as far as it fits, the rest
  // is folded into the grade (small-angle: both are "force per weight").
  const slopePlusRolling = (gradePercent / 100 + options.bike.crr) * k;
  const crr = Math.min(MAX_CRR, Math.max(0, options.bike.crr * k));
  const grade = (slopePlusRolling - crr) * 100;

  const max = options.maxGradePercent ?? 25;
  const min = options.minGradePercent ?? -15;
  return {
    gradePercent: Math.min(max, Math.max(min, grade)),
    crr,
    windResistanceKgM: Math.min(MAX_WIND_RESISTANCE, windResistanceKgM(options.bike) * r ** 3),
    windSpeedMps: 0,
  };
}

/** Receives simulation parameters; normally `trainer.setSimulation`. */
export type SimulationSink = (params: SimulationParams) => Promise<void>;

export class SoftwareShifter implements Shifter {
  readonly #ratios: readonly number[];
  readonly #options: SoftwareShifterOptions;
  readonly #sink: SimulationSink;
  readonly #gearEmitter = createEmitter<number>();
  readonly #errorEmitter = createEmitter<unknown>();
  #gear: number;
  #gradePercent = 0;

  constructor(sink: SimulationSink, options: SoftwareShifterOptions) {
    this.#sink = sink;
    this.#options = options;
    this.#ratios = options.ratios ?? DEFAULT_GEAR_RATIOS;
    if (this.#ratios.length === 0) throw new Error('at least one gear ratio is required');
    this.#gear = this.#clamp(options.initialGear ?? Math.ceil(this.#ratios.length / 2));
  }

  get gear(): number {
    return this.#gear;
  }

  get gearCount(): number {
    return this.#ratios.length;
  }

  get ratio(): number {
    return this.#ratios[this.#gear - 1]!;
  }

  get gradePercent(): number {
    return this.#gradePercent;
  }

  shift(delta: number): number {
    return this.setGear(this.#gear + Math.trunc(delta));
  }

  setGear(gear: number): number {
    const next = this.#clamp(gear);
    if (next !== this.#gear) {
      this.#gear = next;
      this.#gearEmitter.emit(next);
      this.resync();
    }
    return this.#gear;
  }

  setGradient(gradePercent: number): void {
    if (!Number.isFinite(gradePercent) || gradePercent === this.#gradePercent) return;
    this.#gradePercent = gradePercent;
    this.resync();
  }

  onGear(listener: (gear: number) => void): Unsubscribe {
    return this.#gearEmitter.on(listener);
  }

  /** A failed write (e.g. trainer dropped) is reported here, not thrown from shift(). */
  onError(listener: (error: unknown) => void): Unsubscribe {
    return this.#errorEmitter.on(listener);
  }

  resync(): void {
    const params = effectiveSimulation(this.ratio, this.#gradePercent, this.#options);
    this.#sink(params).catch((err: unknown) => this.#errorEmitter.emit(err));
  }

  #clamp(gear: number): number {
    if (!Number.isFinite(gear)) return this.#gear ?? 1;
    return Math.min(this.#ratios.length, Math.max(1, Math.round(gear)));
  }
}
