import { describe, expect, it } from 'vitest';
import type { LeverSettings } from '../../shared/contract';
import { DEFAULT_LEVERS } from '../../shared/contract';
import {
  combineSteering,
  describeGrip,
  formatLeverPercent,
  gripOutput,
  isDefaultLevers,
  leverAmount,
  leverOutput,
  swapGrip,
} from './levers';

const out = (left: number, right: number, levers: LeverSettings = DEFAULT_LEVERS) =>
  leverOutput({ left, right }, levers);

describe('leverAmount', () => {
  it('ignores the rest jitter seen on hardware (0, ±1 %, ±2 %)', () => {
    for (const v of [0, 0.01, -0.01, 0.02, -0.02, 0.05, -0.05])
      expect(leverAmount(v, 0.05)).toBe(0);
  });

  it('rises proportionally above the dead zone to 1 at full travel', () => {
    expect(leverAmount(1, 0.05)).toBe(1);
    expect(leverAmount(-1, 0.05)).toBe(1);
    expect(leverAmount(0.525, 0.05)).toBeCloseTo(0.5, 9);
    expect(leverAmount(0.6, 0)).toBeCloseTo(0.6, 9);
    expect(leverAmount(0.6, 0.2)).toBeCloseTo(0.5, 9);
    expect(leverAmount(1.4, 0.05)).toBe(1);
    expect(leverAmount(Number.NaN, 0.05)).toBe(0);
  });
});

describe('default lever directions (hypothesis from the 2026-11-23 capture)', () => {
  it('right lever: + steers right, − brakes', () => {
    expect(out(0, 1)).toEqual({ steering: 1, braking: 0, steerActive: true });
    expect(out(0, -1)).toEqual({ steering: 0, braking: 1, steerActive: false });
  });

  it('left lever: − steers left, + brakes', () => {
    expect(out(-1, 0)).toEqual({ steering: -1, braking: 0, steerActive: true });
    expect(out(1, 0)).toEqual({ steering: 0, braking: 1, steerActive: false });
  });

  it('at rest (with jitter) nothing acts', () => {
    expect(out(0.01, -0.02)).toEqual({ steering: 0, braking: 0, steerActive: false });
  });

  it('both levers: steering adds up, the stronger brake wins', () => {
    expect(out(-0.525, 1).steering).toBeCloseTo(0.5, 9);
    expect(out(0.525, -1).braking).toBe(1);
    expect(out(0.525, -0.2875).braking).toBeCloseTo(0.5, 9);
  });
});

describe('gripOutput / describeGrip', () => {
  it('names the function and the amount', () => {
    expect(describeGrip(gripOutput('right', 0.43, DEFAULT_LEVERS))).toBe('Steering: 40 % right');
    expect(describeGrip(gripOutput('right', -0.715, DEFAULT_LEVERS))).toBe('Brake: 70 %');
    expect(describeGrip(gripOutput('left', -1, DEFAULT_LEVERS))).toBe('Steering: 100 % left');
    expect(describeGrip(gripOutput('left', 0.02, DEFAULT_LEVERS))).toBe('At rest');
    const none = { ...DEFAULT_LEVERS, left: { positive: 'none', negative: 'none' } } as const;
    expect(gripOutput('left', 0.8, none)).toEqual({ fn: 'none', amount: 0, direction: 'positive' });
    expect(describeGrip(gripOutput('left', 0.8, none))).toBe('Nothing assigned to this direction');
  });

  it('formats the raw position as the bar shows it', () => {
    expect(formatLeverPercent(0.4)).toBe('+40 %');
    expect(formatLeverPercent(-1)).toBe('−100 %');
    expect(formatLeverPercent(0.004)).toBe('0 %');
  });
});

describe('swap, defaults and combination with steer buttons', () => {
  it('swapping a grip exchanges brake and steer on that lever only', () => {
    const swapped = swapGrip(DEFAULT_LEVERS, 'right');
    expect(swapped.right).toEqual({ positive: 'brake', negative: 'steerRight' });
    expect(swapped.left).toEqual(DEFAULT_LEVERS.left);
    expect(out(0, 1, swapped)).toEqual({ steering: 0, braking: 1, steerActive: false });
    expect(isDefaultLevers(swapped)).toBe(false);
    expect(isDefaultLevers(swapGrip(swapped, 'right'))).toBe(true);
    expect(isDefaultLevers({ ...DEFAULT_LEVERS, deadzone: 0.1 })).toBe(false);
  });

  it('active lever steering wins over held buttons; buttons apply otherwise', () => {
    expect(combineSteering(out(0, 0.525), -1)).toBeCloseTo(0.5, 9);
    expect(combineSteering(out(0, 0), -1)).toBe(-1);
    // A brake-only lever does not override the steer buttons.
    expect(combineSteering(out(0, -1), 1)).toBe(1);
  });
});
