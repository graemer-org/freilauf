/**
 * The handlebar levers as analog inputs. Each grip has one lever that moves
 * both ways (−1 … 1); each direction is assigned a function in
 * `Settings.shifting.levers` (steer left, steer right, brake or nothing).
 * Pure; unit-tested in levers.test.ts and used by RideController and the
 * live lever display in Settings.
 */
import type { LeverFunction, LeverSettings } from '../../shared/contract';
import { DEFAULT_LEVERS } from '../../shared/contract';

export type LeverSide = 'left' | 'right';

/** Lever positions per grip, −1 … 1. */
export type LeverPositions = Record<LeverSide, number>;

/** What one lever does right now. */
export interface GripOutput {
  /** The function of the direction the lever is moved in ('none' at rest). */
  fn: LeverFunction;
  /** 0 … 1 above the dead zone; 0 inside it. */
  amount: number;
  /** Which direction: '+' or '−' of the bar, null inside the dead zone. */
  direction: 'positive' | 'negative' | null;
}

export interface LeverOutput {
  /** −1 (full left) … 1 (full right) from the levers. */
  steering: number;
  /** 0 … 1 from the levers. */
  braking: number;
  /** True when a lever is moved past the dead zone in a steer direction. */
  steerActive: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * 0 … 1: how far past the dead zone `value` is, rescaled so full travel is 1.
 * Inside the dead zone (rest jitter of ±1–2 %) the result is exactly 0.
 */
export function leverAmount(value: number, deadzone: number): number {
  if (!Number.isFinite(value)) return 0;
  const dz = clamp(Number.isFinite(deadzone) ? deadzone : DEFAULT_LEVERS.deadzone, 0, 0.95);
  const mag = Math.min(1, Math.abs(value));
  if (mag <= dz) return 0;
  return clamp((mag - dz) / (1 - dz), 0, 1);
}

/** What one grip's lever does at `value` with the given assignment. */
export function gripOutput(side: LeverSide, value: number, levers: LeverSettings): GripOutput {
  const amount = leverAmount(value, levers.deadzone);
  if (amount === 0) return { fn: 'none', amount: 0, direction: null };
  const direction = value > 0 ? 'positive' : 'negative';
  const fn = levers[side][direction];
  return { fn, amount: fn === 'none' ? 0 : amount, direction };
}

/**
 * Both levers combined: steer contributions add up (left −, right +) and are
 * clamped to −1 … 1; the stronger brake wins.
 */
export function leverOutput(positions: LeverPositions, levers: LeverSettings): LeverOutput {
  let steering = 0;
  let braking = 0;
  let steerActive = false;
  for (const side of ['left', 'right'] as const) {
    const out = gripOutput(side, positions[side], levers);
    if (out.fn === 'steerLeft') {
      steering -= out.amount;
      steerActive = true;
    } else if (out.fn === 'steerRight') {
      steering += out.amount;
      steerActive = true;
    } else if (out.fn === 'brake') {
      braking = Math.max(braking, out.amount);
    }
  }
  return { steering: clamp(steering, -1, 1), braking, steerActive };
}

/** Final steering: active levers win over held steer buttons (−1, 0 or 1). */
export function combineSteering(levers: LeverOutput, buttons: number): number {
  return clamp(levers.steerActive ? levers.steering : buttons, -1, 1);
}

/** The lever assignment with the two directions of one grip exchanged. */
export function swapGrip(levers: LeverSettings, side: LeverSide): LeverSettings {
  const g = levers[side];
  return { ...levers, [side]: { positive: g.negative, negative: g.positive } };
}

/** True when the assignment and dead zone equal the defaults. */
export function isDefaultLevers(levers: LeverSettings): boolean {
  const d = DEFAULT_LEVERS;
  return (
    levers.deadzone === d.deadzone &&
    (['left', 'right'] as const).every(
      (s) => levers[s].positive === d[s].positive && levers[s].negative === d[s].negative,
    )
  );
}

/** "Steering: 40 % right", "Brake: 70 %", "Nothing assigned", "At rest". */
export function describeGrip(out: GripOutput): string {
  if (out.direction === null) return 'At rest';
  const pct = Math.round(out.amount * 100);
  switch (out.fn) {
    case 'steerLeft':
      return `Steering: ${pct} % left`;
    case 'steerRight':
      return `Steering: ${pct} % right`;
    case 'brake':
      return `Brake: ${pct} %`;
    case 'none':
      return 'Nothing assigned to this direction';
  }
}

/** "+40 %", "−100 %", "0 %" (raw signed position as the bar shows it). */
export function formatLeverPercent(value: number): string {
  const pct = Math.round(clamp(Number.isFinite(value) ? value : 0, -1, 1) * 100);
  if (pct > 0) return `+${pct} %`;
  if (pct < 0) return `−${-pct} %`;
  return '0 %';
}
