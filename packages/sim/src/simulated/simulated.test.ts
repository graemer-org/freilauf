import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, ControllerButtonEvent, TrainerData } from '@freilauf/devices';
import {
  DEFAULT_SIMULATION_PARAMS,
  SimulatedController,
  SimulatedHeartRate,
  SimulatedTrainer,
  createSeededRandom,
  createSimulatedRig,
} from './index';
import type { SimScheduler } from './index';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function connected<T extends { connect(): Promise<void> }>(device: T): Promise<T> {
  const p = device.connect();
  await vi.advanceTimersByTimeAsync(1000);
  await p;
  return device;
}

function collect(trainer: SimulatedTrainer): TrainerData[] {
  const out: TrainerData[] = [];
  trainer.onData((d) => out.push(d));
  return out;
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Average of the last `n` samples of a field. */
function tailAvg(data: TrainerData[], key: keyof TrainerData, n = 40): number {
  return avg(data.slice(-n).map((d) => d[key] ?? NaN));
}

async function steadyCadence(gradePercent: number, effort = 200): Promise<number> {
  const trainer = await connected(new SimulatedTrainer({ riderEffortW: effort, powerNoise: 0 }));
  await trainer.setSimulation({ ...DEFAULT_SIMULATION_PARAMS, gradePercent });
  const data = collect(trainer);
  await vi.advanceTimersByTimeAsync(90_000);
  await trainer.disconnect();
  return tailAvg(data, 'cadenceRpm');
}

describe('SimulatedTrainer', () => {
  it('goes through connecting → connected after the delay', async () => {
    const t = new SimulatedTrainer({ connectDelayMs: 500 });
    const states: ConnectionState[] = [];
    t.onState((s) => states.push(s));
    const p = t.connect();
    expect(t.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(499);
    expect(t.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('emits at 4 Hz while connected and stops when disconnected', async () => {
    const t = new SimulatedTrainer();
    const data = collect(t);
    await vi.advanceTimersByTimeAsync(2000);
    expect(data).toHaveLength(0);
    await connected(t);
    data.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(data).toHaveLength(4);
    expect(data[0]).toEqual({
      powerW: expect.any(Number),
      cadenceRpm: expect.any(Number),
      speedKph: expect.any(Number),
    });
    await t.disconnect();
    expect(t.state).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(data).toHaveLength(4);
  });

  it('holds the rider effort in steady state', async () => {
    const t = await connected(new SimulatedTrainer({ riderEffortW: 220 }));
    const data = collect(t);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tailAvg(data, 'powerW', 200)).toBeGreaterThan(210);
    expect(tailAvg(data, 'powerW', 200)).toBeLessThan(230);
    // Flat road, 220 W, 85 kg: roughly 26 km/h, a plausible cadence in 2.4 ratio.
    expect(tailAvg(data, 'speedKph')).toBeGreaterThan(22);
    expect(tailAvg(data, 'speedKph')).toBeLessThan(30);
    expect(tailAvg(data, 'cadenceRpm')).toBeGreaterThan(70);
    expect(tailAvg(data, 'cadenceRpm')).toBeLessThan(100);
  });

  it('drops cadence at the same effort when the grade rises', async () => {
    const flat = await steadyCadence(0);
    const climb = await steadyCadence(5);
    const steep = await steadyCadence(10);
    expect(climb).toBeLessThan(flat - 20);
    expect(steep).toBeLessThan(climb - 10);
    expect(steep).toBeGreaterThan(0);
  });

  it('responds to a grade change within seconds', async () => {
    const t = await connected(new SimulatedTrainer({ powerNoise: 0 }));
    const data = collect(t);
    await vi.advanceTimersByTimeAsync(60_000);
    const before = tailAvg(data, 'cadenceRpm', 4);
    await t.setSimulation({ ...DEFAULT_SIMULATION_PARAMS, gradePercent: 6 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tailAvg(data, 'cadenceRpm', 4)).toBeLessThan(before - 15);
  });

  it('keeps cadence within bounds and spins out', async () => {
    const t = await connected(new SimulatedTrainer({ riderEffortW: 600, powerNoise: 0 }));
    await t.setSimulation({ ...DEFAULT_SIMULATION_PARAMS, gradePercent: -8 });
    const data = collect(t);
    await vi.advanceTimersByTimeAsync(60_000);
    for (const d of data) {
      expect(d.cadenceRpm).toBeGreaterThanOrEqual(0);
      expect(d.cadenceRpm).toBeLessThanOrEqual(130);
    }
    expect(tailAvg(data, 'powerW')).toBeLessThan(300);
  });

  it('reports zero cadence when the rider stops pedalling', async () => {
    const t = await connected(new SimulatedTrainer());
    const data = collect(t);
    await vi.advanceTimersByTimeAsync(20_000);
    t.setRiderEffort(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(data.at(-1)).toMatchObject({ powerW: 0, cadenceRpm: 0 });
  });

  it('converges to the ERG target and returns to sim mode on setSimulation', async () => {
    const t = await connected(new SimulatedTrainer({ riderEffortW: 150 }));
    const data = collect(t);
    await vi.advanceTimersByTimeAsync(10_000);
    await t.setTargetPower(280);
    expect(t.mode).toBe('erg');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(Math.abs(tailAvg(data, 'powerW', 20) - 280)).toBeLessThan(12);
    expect(tailAvg(data, 'cadenceRpm', 8)).toBeCloseTo(90, -1);
    await t.setSimulation(DEFAULT_SIMULATION_PARAMS);
    expect(t.mode).toBe('sim');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Math.abs(tailAvg(data, 'powerW', 40) - 150)).toBeLessThan(10);
  });

  it('records commands and rejects them when not connected', async () => {
    const t = new SimulatedTrainer();
    await expect(t.setTargetPower(100)).rejects.toThrow();
    await connected(t);
    const params = { ...DEFAULT_SIMULATION_PARAMS, gradePercent: 3 };
    await t.setSimulation(params);
    await t.setTargetPower(200);
    expect(t.commands).toEqual([
      { type: 'simulation', params, at: expect.any(Number) },
      { type: 'targetPower', watts: 200, at: expect.any(Number) },
    ]);
  });

  it('is deterministic for a fixed seed', async () => {
    const run = async (seed: number) => {
      const t = await connected(new SimulatedTrainer({ seed }));
      const data = collect(t);
      await vi.advanceTimersByTimeAsync(10_000);
      await t.disconnect();
      return data;
    };
    const a = await run(42);
    const b = await run(42);
    const c = await run(43);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('can fail connects', async () => {
    const t = new SimulatedTrainer({ failConnect: true });
    const p = t.connect();
    const assertion = expect(p).rejects.toThrow(/simulated connect failure/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(t.state).toBe('disconnected');
    t.failConnect = false;
    await connected(t);
    expect(t.state).toBe('connected');
  });

  it('drops to reconnecting, stops data, then reconnects', async () => {
    const t = await connected(new SimulatedTrainer({ reconnectDelayMs: 3000 }));
    const states: ConnectionState[] = [];
    t.onState((s) => states.push(s));
    const data = collect(t);
    t.simulateDrop();
    expect(t.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2900);
    expect(data).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.state).toBe('connected');
    await vi.advanceTimersByTimeAsync(1000);
    expect(data).toHaveLength(4);
    expect(states).toEqual(['reconnecting', 'connected']);
  });

  it('keeps retrying while reconnects fail, and disconnect() stops it', async () => {
    const t = await connected(new SimulatedTrainer({ reconnectDelayMs: 1000 }));
    t.failConnect = true;
    t.simulateDrop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.state).toBe('reconnecting');
    t.failConnect = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.state).toBe('connected');
    t.simulateDrop();
    await t.disconnect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.state).toBe('disconnected');
  });

  it('aborts a pending connect on disconnect()', async () => {
    const t = new SimulatedTrainer();
    const p = t.connect();
    const assertion = expect(p).rejects.toThrow(/aborted/);
    await t.disconnect();
    await assertion;
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.state).toBe('disconnected');
  });

  it('works with an injected scheduler and clock', () => {
    let time = 0;
    const timeouts: { at: number; fn: () => void }[] = [];
    const intervals: { ms: number; next: number; fn: () => void }[] = [];
    const scheduler: SimScheduler = {
      now: () => time,
      setTimeout: (fn, ms) => timeouts.push({ at: time + ms, fn }),
      clearTimeout: () => {},
      setInterval: (fn, ms) => intervals.push({ ms, next: time + ms, fn }),
      clearInterval: () => {},
    };
    const t = new SimulatedTrainer({ scheduler, connectDelayMs: 10 });
    const data = collect(t);
    void t.connect();
    time = 10;
    timeouts.shift()?.fn();
    expect(t.state).toBe('connected');
    const iv = intervals[0];
    expect(iv?.ms).toBe(250);
    for (let i = 0; i < 8 && iv; i++) {
      time = iv.next;
      iv.next += iv.ms;
      iv.fn();
    }
    expect(data).toHaveLength(8);
    expect(data.at(-1)?.powerW).toBeGreaterThan(0);
  });
});

describe('SimulatedHeartRate', () => {
  it('emits at 1 Hz and lags towards the power-derived target', async () => {
    const hr = await connected(new SimulatedHeartRate({ noiseBpm: 0 }));
    const bpm: number[] = [];
    hr.onHeartRate((b) => bpm.push(b));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bpm).toHaveLength(10);
    expect(bpm.every((b) => b === 60)).toBe(true);

    hr.setPower(200); // target 60 + 90 = 150
    expect(hr.targetBpm).toBe(150);
    await vi.advanceTimersByTimeAsync(30_000);
    // One time constant: ~63 % of the way.
    expect(bpm.at(-1)).toBeGreaterThan(110);
    expect(bpm.at(-1)).toBeLessThan(122);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(bpm.at(-1)).toBeGreaterThanOrEqual(149);
    expect(bpm.at(-1)).toBeLessThanOrEqual(150);
    // Monotonic rise without noise.
    for (let i = 1; i < bpm.length; i++) expect(bpm[i]).toBeGreaterThanOrEqual(bpm[i - 1] ?? 0);
  });

  it('caps at max and stops emitting when disconnected', async () => {
    const hr = await connected(new SimulatedHeartRate({ noiseBpm: 0 }));
    const bpm: number[] = [];
    hr.onHeartRate((b) => bpm.push(b));
    hr.setPower(1000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(bpm.at(-1)).toBe(190);
    await hr.disconnect();
    const n = bpm.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(bpm).toHaveLength(n);
  });

  it('adds small, seed-deterministic noise', async () => {
    const run = async () => {
      const hr = await connected(new SimulatedHeartRate({ seed: 7 }));
      const bpm: number[] = [];
      hr.onHeartRate((b) => bpm.push(b));
      await vi.advanceTimersByTimeAsync(60_000);
      await hr.disconnect();
      return bpm;
    };
    const a = await run();
    expect(a).toEqual(await run());
    expect(new Set(a).size).toBeGreaterThan(1);
    expect(a.every((b) => Math.abs(b - 60) <= 5)).toBe(true);
  });
});

describe('SimulatedController', () => {
  it('emits button and paddle events while connected', async () => {
    const c = new SimulatedController();
    const events: ControllerButtonEvent[] = [];
    const paddles: { side: 'left' | 'right'; value: number }[] = [];
    c.onButton((e) => events.push(e));
    c.onPaddle((e) => paddles.push(e));
    expect(c.tap('a')).toBe(false);
    expect(events).toHaveLength(0);

    await connected(c);
    c.press('shiftUpRight');
    expect(c.isHeld('shiftUpRight')).toBe(true);
    c.release('shiftUpRight');
    c.tap('shiftDownLeft');
    c.setPaddle('left', 2);
    c.setPaddle('right', -0.5);
    expect(events).toEqual([
      { button: 'shiftUpRight', pressed: true },
      { button: 'shiftUpRight', pressed: false },
      { button: 'shiftDownLeft', pressed: true },
      { button: 'shiftDownLeft', pressed: false },
    ]);
    expect(paddles).toEqual([
      { side: 'left', value: 1 },
      { side: 'right', value: -0.5 },
    ]);
  });

  it('ignores input while reconnecting', async () => {
    const c = await connected(new SimulatedController({ reconnectDelayMs: 500 }));
    const events: ControllerButtonEvent[] = [];
    c.onButton((e) => events.push(e));
    c.press('up');
    c.simulateDrop();
    expect(c.isHeld('up')).toBe(false);
    expect(c.tap('down')).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(c.tap('down')).toBe(true);
    expect(events).toHaveLength(3);
  });
});

describe('createSimulatedRig', () => {
  it('drives heart rate from trainer power and disposes cleanly', async () => {
    const rig = createSimulatedRig({ seed: 5, trainer: { riderEffortW: 250 } });
    await Promise.all([
      connected(rig.trainer),
      connected(rig.heartRate),
      connected(rig.controller),
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    // 60 + 0.45·250 ≈ 172; after 2 minutes (4 τ) it should be close.
    expect(rig.heartRate.latest).toBeGreaterThan(160);
    await rig.dispose();
    expect(rig.trainer.state).toBe('disconnected');
    expect(rig.heartRate.state).toBe('disconnected');
    expect(rig.controller.state).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createSeededRandom', () => {
  it('is repeatable and in [0, 1)', () => {
    const a = createSeededRandom(123);
    const b = createSeededRandom(123);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
