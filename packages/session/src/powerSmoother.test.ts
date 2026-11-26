import { describe, expect, it } from 'vitest';
import { MAX_POWER_SMOOTHING_S, PowerSmoother } from './powerSmoother';

const HOLD_MS = 3000;
const smoother = (windowS: number) => new PowerSmoother({ windowS, holdMs: HOLD_MS });

describe('PowerSmoother', () => {
  it('is 0 before any reading', () => {
    expect(smoother(3).value(1000)).toBe(0);
  });

  it('shows the first reading at once (time before it is unknown, not 0 W)', () => {
    const s = smoother(3);
    s.add(200, 1000);
    expect(s.value(1000)).toBe(200);
    expect(s.value(1250)).toBe(200);
  });

  it('averages a steady signal to its value and a step over the window', () => {
    const s = smoother(3);
    for (let t = 0; t <= 10_000; t += 250) s.add(100, t);
    expect(s.value(10_000)).toBeCloseTo(100, 9);
    // 400 W from 10.25 s: the window 8.5 → 11.5 s holds 1.75 s of 100 W and 1.25 s of 400 W.
    for (let t = 10_250; t <= 11_500; t += 250) s.add(400, t);
    expect(s.value(11_500)).toBeCloseTo((1.75 * 100 + 1.25 * 400) / 3, 9);
    for (let t = 11_750; t <= 14_000; t += 250) s.add(400, t);
    expect(s.value(14_000)).toBeCloseTo(400, 9);
  });

  it('weights irregular intervals by the time each reading held', () => {
    const s = smoother(3);
    s.add(100, 0);
    s.add(100, 3000); // 100 W known from 0 to 3 s
    s.add(300, 4000); // 100 W held 3 → 4 s
    s.add(600, 4200); // 300 W held 4 → 4.2 s
    s.add(0, 5900); // 600 W held 4.2 → 5.9 s
    // Window 3 → 6 s: 100·1 + 300·0.2 + 600·1.7 + 0·0.1
    expect(s.value(6000)).toBeCloseTo((100 * 1 + 300 * 0.2 + 600 * 1.7) / 3, 9);
    // The same readings sent more often give the same average.
    const dense = smoother(3);
    for (let t = 0; t < 4000; t += 100) dense.add(100, t);
    for (let t = 4000; t < 4200; t += 50) dense.add(300, t);
    for (let t = 4200; t < 5900; t += 100) dense.add(600, t);
    dense.add(0, 5900);
    expect(dense.value(6000)).toBeCloseTo(s.value(6000), 9);
  });

  it('decays to 0 when readings stop instead of hanging on the last value', () => {
    const s = smoother(3);
    for (let t = 0; t <= 5000; t += 250) s.add(250, t);
    // Within the hold time the last reading still counts.
    expect(s.value(7000)).toBeCloseTo(250, 9);
    // After it, the missing time counts as 0 W: a linear decay over the window.
    expect(s.value(8000 + 1500)).toBeCloseTo(125, 9);
    expect(s.value(8000 + 3000)).toBe(0);
    expect(s.value(60_000)).toBe(0);
  });

  it('decays when the rider stops pedalling (0 W readings)', () => {
    const s = smoother(3);
    for (let t = 0; t <= 5000; t += 250) s.add(300, t);
    const shown: number[] = [];
    for (let t = 5250; t <= 8250; t += 250) {
      s.add(0, t);
      shown.push(s.value(t));
    }
    for (let i = 1; i < shown.length; i++) expect(shown[i]!).toBeLessThan(shown[i - 1]!);
    expect(shown.at(-1)).toBe(0);
  });

  it('a gap (dropout) counts as 0 W, then power comes back gradually', () => {
    const s = smoother(3);
    for (let t = 0; t <= 2000; t += 250) s.add(200, t);
    // No readings for 10 s, then 200 W again.
    s.add(200, 12_000);
    expect(s.value(12_000)).toBe(0);
    s.add(200, 13_500);
    expect(s.value(13_500)).toBeCloseTo(100, 9);
    for (let t = 13_750; t <= 15_000; t += 250) s.add(200, t);
    expect(s.value(15_000)).toBeCloseTo(200, 9);
  });

  it('is independent of how often value() is asked (tick rate)', () => {
    const a = smoother(5);
    const b = smoother(5);
    const watts = (t: number) => 150 + 100 * Math.sin(t / 700);
    for (let t = 0; t <= 20_000; t += 333) {
      a.add(watts(t), t);
      b.add(watts(t), t);
      a.value(t); // asked at every reading; b only at the end
    }
    expect(a.value(20_100)).toBeCloseTo(b.value(20_100), 9);
  });

  it('a window change applies at once, from the history', () => {
    const s = smoother(1);
    for (let t = 0; t <= 6000; t += 250) s.add(t < 3000 ? 100 : 400, t);
    expect(s.value(6000)).toBeCloseTo(400, 9);
    s.setWindow(5);
    expect(s.windowS).toBe(5);
    // 5 s window over 1 → 6 s: 2 s of 100 W, 3 s of 400 W.
    expect(s.value(6000)).toBeCloseTo((2 * 100 + 3 * 400) / 5, 9);
    s.setWindow(3);
    expect(s.value(6000)).toBeCloseTo(400, 9);
  });

  it('off (0): the latest reading while fresh, else 0', () => {
    const s = smoother(0);
    s.add(100, 0);
    s.add(500, 250);
    expect(s.value(250)).toBe(500);
    expect(s.value(250 + HOLD_MS)).toBe(500);
    expect(s.value(251 + HOLD_MS)).toBe(0);
  });

  it('clamps the window, ignores bad readings and survives a clock stepping back', () => {
    expect(smoother(60).windowS).toBe(MAX_POWER_SMOOTHING_S);
    expect(smoother(-1).windowS).toBe(0);
    expect(smoother(Number.NaN).windowS).toBe(0);
    const s = smoother(3);
    s.add(200, 1000);
    s.add(Number.NaN, 1500);
    s.add(Number.POSITIVE_INFINITY, 1600);
    s.add(-50, 2000); // counts as 0 W
    s.add(200, 1800); // clock stepped back: taken as at 2000
    expect(Number.isFinite(s.value(2500))).toBe(true);
    expect(s.value(2500)).toBeCloseTo((1000 * 200 + 500 * 200) / 1500, 9);
  });

  it('keeps a bounded history and forgets everything on reset', () => {
    const s = smoother(5);
    for (let t = 0; t <= 3_600_000; t += 100) s.add(200, t);
    expect(s.value(3_600_000)).toBeCloseTo(200, 9);
    s.reset();
    expect(s.value(3_600_000)).toBe(0);
    s.add(120, 3_600_100);
    expect(s.value(3_600_100)).toBe(120);
  });
});
