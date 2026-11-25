import { describe, expect, it } from 'vitest';
import { ControlPointError, ControlPointTimeoutError, FtmsTrainer } from './ftmsTrainer';
import { encodeSetIndoorBikeSimulation } from './ftms';
import { DeviceDisconnectedError } from './managedDevice';
import {
  FakePeripheral,
  FakeScheduler,
  flushPromises,
  gattBusyError,
  gattDisconnectedError,
  toHex,
} from './testing/fakeGatt';
import type { FakeWrite } from './testing/fakeGatt';
import type { SimulationParams, TrainerData } from './types';
import {
  CYCLING_POWER_MEASUREMENT,
  CYCLING_POWER_SERVICE,
  FTMS_CONTROL_POINT,
  FTMS_INDOOR_BIKE_DATA,
  FTMS_SERVICE,
} from './uuids';

const SIM: SimulationParams = {
  windSpeedMps: 0,
  gradePercent: 5,
  crr: 0.004,
  windResistanceKgM: 0.51,
};
const SIM_HEX = '11 00 00 f4 01 28 33';

const ok = (w: FakeWrite) => `80 ${toHex(w.data.subarray(0, 1))} 01`;

function setup(options: { services?: string[]; autoRespond?: boolean } = {}) {
  const peripheral = new FakePeripheral({
    services: options.services ?? [FTMS_SERVICE],
    name: 'KICKR',
  });
  if (options.autoRespond !== false)
    peripheral.respondToWrites(FTMS_SERVICE, FTMS_CONTROL_POINT, ok);
  const clock = new FakeScheduler();
  const trainer = new FtmsTrainer(peripheral, { schedule: clock.schedule, now: clock.now });
  const data: TrainerData[] = [];
  trainer.onData((d) => data.push(d));
  const cpWrites = () => peripheral.writesTo(FTMS_CONTROL_POINT).map((w) => toHex(w.data));
  /** Answers the oldest unanswered write manually (for autoRespond: false). */
  const respond = (opcode: string, result = '01') =>
    peripheral.notify(FTMS_SERVICE, FTMS_CONTROL_POINT, `80 ${opcode} ${result}`);
  return { peripheral, clock, trainer, data, cpWrites, respond };
}

describe('FtmsTrainer', () => {
  it('subscribes and requests control on connect', async () => {
    const { trainer, peripheral, cpWrites } = setup();
    await trainer.connect();
    expect(trainer.kind).toBe('trainer');
    expect(trainer.state).toBe('connected');
    const c = peripheral.current!;
    expect(c.isSubscribed(FTMS_SERVICE, FTMS_INDOOR_BIKE_DATA)).toBe(true);
    expect(c.isSubscribed(FTMS_SERVICE, FTMS_CONTROL_POINT)).toBe(true);
    expect(cpWrites()).toEqual(['00']);
  });

  it('emits trainer data from Indoor Bike Data', async () => {
    const { trainer, peripheral, data } = setup();
    await trainer.connect();
    peripheral.notify(FTMS_SERVICE, FTMS_INDOOR_BIKE_DATA, '44 00 b8 0b b4 00 fa 00');
    peripheral.notify(FTMS_SERVICE, FTMS_INDOOR_BIKE_DATA, '44'); // malformed: ignored
    expect(data).toEqual([{ speedKph: 30, cadenceRpm: 90, powerW: 250 }]);
  });

  it('writes simulation params and resolves on the matching response', async () => {
    const { trainer, cpWrites } = setup();
    await trainer.connect();
    await trainer.setSimulation(SIM);
    await trainer.setTargetPower(200);
    expect(cpWrites()).toEqual(['00', SIM_HEX, '05 c8 00']);
  });

  it('rejects with ControlPointError on a failure result', async () => {
    const { trainer, peripheral } = setup();
    peripheral.respondToWrites(FTMS_SERVICE, FTMS_CONTROL_POINT, (w) =>
      w.data[0] === 0x05 ? '80 05 03' : ok(w),
    );
    await trainer.connect();
    const err = await trainer.setTargetPower(5000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPointError);
    expect((err as ControlPointError).result).toBe('invalidParameter');
  });

  it('times out after ~2 s without a response and moves on', async () => {
    const { trainer, clock, cpWrites, respond } = setup({ autoRespond: false });
    const connecting = trainer.connect();
    await flushPromises();
    respond('00');
    await connecting;

    const first = trainer.setSimulation(SIM);
    const firstResult = first.catch((e: unknown) => e);
    const second = trainer.setTargetPower(100);
    await flushPromises();
    expect(cpWrites()).toEqual(['00', SIM_HEX]);

    await clock.advance(1999);
    expect(cpWrites()).toHaveLength(2);
    await clock.advance(1);
    expect(await firstResult).toBeInstanceOf(ControlPointTimeoutError);
    expect(cpWrites()).toEqual(['00', SIM_HEX, '05 64 00']);
    respond('05');
    await second;
  });

  it('ignores responses for other opcodes', async () => {
    const { trainer, clock, respond } = setup({ autoRespond: false });
    const connecting = trainer.connect();
    await flushPromises();
    respond('00');
    await connecting;
    let settled = false;
    const p = trainer.setSimulation(SIM).finally(() => (settled = true));
    await flushPromises();
    respond('05');
    await flushPromises();
    expect(settled).toBe(false);
    respond('11');
    await p;
    expect(clock.pendingDelays).toEqual([]);
  });

  it('serializes writes: one in flight at a time', async () => {
    const { trainer, cpWrites, respond } = setup({ autoRespond: false });
    const connecting = trainer.connect();
    await flushPromises();
    respond('00');
    await connecting;

    const a = trainer.setTargetPower(100);
    const b = trainer.setSimulation(SIM);
    await flushPromises();
    expect(cpWrites()).toEqual(['00', '05 64 00']);
    respond('05');
    await a;
    await flushPromises();
    expect(cpWrites()).toEqual(['00', '05 64 00', SIM_HEX]);
    respond('11');
    await b;
  });

  it('coalesces queued simulation updates to the latest', async () => {
    const { trainer, cpWrites, respond } = setup({ autoRespond: false });
    const connecting = trainer.connect();
    await flushPromises();
    respond('00');
    await connecting;

    const p1 = trainer.setSimulation({ ...SIM, gradePercent: 1 }); // in flight
    const p2 = trainer.setSimulation({ ...SIM, gradePercent: 2 }); // queued
    const p3 = trainer.setSimulation({ ...SIM, gradePercent: 3 }); // replaces p2
    await flushPromises();
    respond('11');
    await p1;
    await flushPromises();
    respond('11');
    await Promise.all([p2, p3]);
    expect(cpWrites()).toEqual(['00', '11 00 00 64 00 28 33', '11 00 00 2c 01 28 33']);
  });

  it('does not coalesce across a different command (keeps order)', async () => {
    const { trainer, cpWrites } = setup();
    await trainer.connect();
    const all = Promise.all([
      trainer.setSimulation({ ...SIM, gradePercent: 1 }),
      trainer.setSimulation({ ...SIM, gradePercent: 2 }),
      trainer.setTargetPower(150),
      trainer.setSimulation({ ...SIM, gradePercent: 3 }),
    ]);
    await all;
    expect(cpWrites()).toEqual([
      '00',
      '11 00 00 64 00 28 33',
      '11 00 00 c8 00 28 33',
      '05 96 00',
      '11 00 00 2c 01 28 33',
    ]);
  });

  it('rejects commands while not connected', async () => {
    const { trainer } = setup();
    await expect(trainer.setSimulation(SIM)).rejects.toBeInstanceOf(DeviceDisconnectedError);
  });

  it('rejects in-flight and queued commands on link loss', async () => {
    const { trainer, peripheral, respond } = setup({ autoRespond: false });
    const connecting = trainer.connect();
    await flushPromises();
    respond('00');
    await connecting;
    const a = trainer.setTargetPower(100).catch((e: unknown) => e);
    const b = trainer.setSimulation(SIM).catch((e: unknown) => e);
    await flushPromises();
    peripheral.dropLink();
    expect(await a).toBeInstanceOf(DeviceDisconnectedError);
    expect(await b).toBeInstanceOf(DeviceDisconnectedError);
  });

  it('re-requests control and re-sends the last simulation after reconnect', async () => {
    const { trainer, peripheral, clock, cpWrites } = setup();
    await trainer.connect();
    await trainer.setSimulation({ ...SIM, gradePercent: 1 });
    peripheral.dropLink();
    expect(trainer.state).toBe('reconnecting');
    // update requested while the link is down: rejected, but remembered
    await expect(trainer.setSimulation(SIM)).rejects.toBeInstanceOf(DeviceDisconnectedError);

    await clock.advance(1000);
    await flushPromises();
    expect(trainer.state).toBe('connected');
    const second = peripheral.connections[1]!.writes.map((w) => toHex(w.data));
    expect(second).toEqual(['00', SIM_HEX]);
    expect(cpWrites()).toEqual(['00', '11 00 00 64 00 28 33', '00', SIM_HEX]);
  });

  it('re-sends target power (ERG) after reconnect', async () => {
    const { trainer, peripheral, clock } = setup();
    await trainer.connect();
    await trainer.setTargetPower(220);
    peripheral.dropLink();
    await clock.advance(1000);
    await flushPromises();
    expect(peripheral.connections[1]!.writes.map((w) => toHex(w.data))).toEqual(['00', '05 dc 00']);
  });

  it('stays connected when control is refused, and retries Request Control on the next command', async () => {
    const { trainer, peripheral, cpWrites } = setup();
    let refuse = true;
    peripheral.respondToWrites(FTMS_SERVICE, FTMS_CONTROL_POINT, (w) =>
      w.data[0] === 0x00 && refuse ? '80 00 05' : ok(w),
    );
    await trainer.connect();
    expect(trainer.state).toBe('connected');
    refuse = false;
    await trainer.setSimulation(SIM);
    expect(cpWrites()).toEqual(['00', '00', SIM_HEX]);
    await trainer.setSimulation(SIM);
    expect(cpWrites()).toEqual(['00', '00', SIM_HEX, SIM_HEX]);
  });

  it('uses Cycling Power crank data for cadence when Indoor Bike Data has none', async () => {
    const { trainer, peripheral, clock, data } = setup({
      services: [FTMS_SERVICE, CYCLING_POWER_SERVICE],
    });
    await trainer.connect();
    expect(peripheral.current!.isSubscribed(CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT)).toBe(
      true,
    );
    // speed + power only (flags 0x0040)
    const ibd = '40 00 b8 0b fa 00';
    peripheral.notify(CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT, '20 00 fa 00 0a 00 00 00');
    peripheral.notify(FTMS_SERVICE, FTMS_INDOOR_BIKE_DATA, ibd);
    await clock.advance(1000);
    // 1 rev in 683/1024 s = 90 rpm
    peripheral.notify(CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT, '20 00 fa 00 0b 00 ab 02');
    peripheral.notify(FTMS_SERVICE, FTMS_INDOOR_BIKE_DATA, ibd);
    await clock.advance(4000);
    peripheral.notify(FTMS_SERVICE, FTMS_INDOOR_BIKE_DATA, ibd);

    expect(data[0]).toEqual({ speedKph: 30, powerW: 250 });
    expect(data[1]?.cadenceRpm).toBeCloseTo(90, 0);
    expect(data[2]).toEqual({ speedKph: 30, powerW: 250, cadenceRpm: 0 });
  });

  it('prefers Indoor Bike Data cadence over CPS', async () => {
    const { trainer, peripheral, clock, data } = setup({
      services: [FTMS_SERVICE, CYCLING_POWER_SERVICE],
    });
    await trainer.connect();
    peripheral.notify(CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT, '20 00 fa 00 0a 00 00 00');
    await clock.advance(1000);
    peripheral.notify(CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT, '20 00 fa 00 0b 00 ab 02');
    peripheral.notify(FTMS_SERVICE, FTMS_INDOOR_BIKE_DATA, '44 00 b8 0b b4 00 fa 00');
    expect(data).toEqual([{ speedKph: 30, cadenceRpm: 90, powerW: 250 }]);
  });

  it('disconnect() stops everything', async () => {
    const { trainer, peripheral, clock } = setup();
    await trainer.connect();
    await trainer.disconnect();
    expect(trainer.state).toBe('disconnected');
    await clock.advance(60_000);
    expect(peripheral.connectAttempts).toBe(1);
  });

  describe('control point timing on Windows (indication before the write resolves)', () => {
    /** Writes answer after `respondMs` and resolve after `resolveMs`; Chromium rejects overlapping writes. */
    function windowsSetup(respondMs: number, resolveMs: number) {
      const rig = setup();
      rig.peripheral.setWriteBehavior(FTMS_SERVICE, FTMS_CONTROL_POINT, {
        schedule: rig.clock.schedule,
        respondAfterMs: respondMs,
        resolveAfterMs: resolveMs,
        rejectWhileBusy: true,
      });
      const diags: string[] = [];
      rig.trainer.onDiagnostic((d) => diags.push(d.event));
      return { ...rig, diags };
    }
    const sim = (gradePercent: number): SimulationParams => ({ ...SIM, gradePercent });
    const simHex = (gradePercent: number) =>
      toHex(encodeSetIndoorBikeSimulation(sim(gradePercent)));

    it('waits for the write to settle before the next write (log 2026-11-25 16:29:32)', async () => {
      // Response and write completion in the same millisecond, the response first.
      const { trainer, peripheral, clock, cpWrites, diags } = windowsSetup(144, 144);
      const connecting = trainer.connect();
      await clock.advance(200);
      await connecting;

      const first = trainer.setSimulation(sim(-1.66)).catch((e: unknown) => e);
      await clock.advance(57);
      // a gradient update arrives while the shift's write is in flight
      const second = trainer.setSimulation(sim(-1.08)).catch((e: unknown) => e);
      await clock.advance(87);
      expect(await first).toBeUndefined();
      await clock.advance(200);
      expect(await second).toBeUndefined();
      expect(peripheral.rejectedWrites).toEqual([]);
      expect(diags).not.toContain('cp-write-failed');
      expect(cpWrites()).toEqual(['00', simHex(-1.66), simHex(-1.08)]);
    });

    it('serializes a burst of 10 shifts within 500 ms; the last parameters win, nothing is rejected', async () => {
      const { trainer, peripheral, clock, cpWrites, diags } = windowsSetup(100, 101);
      const connecting = trainer.connect();
      await clock.advance(200);
      await connecting;

      const results: Array<Promise<unknown>> = [];
      for (let i = 0; i < 10; i++) {
        results.push(
          trainer.setSimulation(sim(i + 1)).then(
            () => 'ok',
            (e: unknown) => e,
          ),
        );
        await clock.advance(50);
      }
      await clock.advance(1000);
      expect(await Promise.all(results)).toEqual(Array(10).fill('ok'));
      expect(peripheral.rejectedWrites).toEqual([]);
      expect(diags).not.toContain('cp-write-failed');
      const simWrites = cpWrites().slice(1);
      expect(simWrites.length).toBeLessThan(10);
      expect(simWrites.at(-1)).toBe(simHex(10));
      // one write per completed exchange: never two in flight
      expect(diags.filter((e) => e === 'cp-request')).toHaveLength(cpWrites().length);
      expect(clock.pendingDelays).toEqual([]);
    });

    it('moves on if the write never settles after its response arrived', async () => {
      const { trainer, clock, cpWrites, diags } = windowsSetup(0, 60_000);
      const connecting = trainer.connect().catch((e: unknown) => e);
      await clock.advance(1999);
      expect(cpWrites()).toEqual(['00']);
      await clock.advance(1);
      expect(await connecting).toBeUndefined();
      expect(diags).toContain('cp-write-stuck');
    });
  });

  describe('transient control point write failures', () => {
    it('retries "GATT operation already in progress" after 50 ms, then 100 ms', async () => {
      const { trainer, peripheral, clock, cpWrites } = setup();
      await trainer.connect();
      const diags: string[] = [];
      trainer.onDiagnostic((d) => diags.push(d.event));
      peripheral.failNextWrites(FTMS_SERVICE, FTMS_CONTROL_POINT, 2, gattBusyError());
      let settled = false;
      const p = trainer.setSimulation(SIM).finally(() => (settled = true));
      await flushPromises();
      expect(clock.pendingDelays).toEqual([50]);
      await clock.advance(50);
      expect(clock.pendingDelays).toEqual([100]);
      expect(settled).toBe(false);
      await clock.advance(100);
      await p;
      expect(peripheral.rejectedWrites.map((w) => toHex(w.data))).toEqual([SIM_HEX, SIM_HEX]);
      expect(cpWrites()).toEqual(['00', SIM_HEX]);
      expect(diags.filter((e) => e === 'cp-write-retry')).toHaveLength(2);
      expect(diags).not.toContain('cp-write-failed');
    });

    it('gives up after 3 retries (50, 100, 200 ms) and reports the error', async () => {
      const { trainer, peripheral, clock, cpWrites } = setup();
      await trainer.connect();
      peripheral.failNextWrites(FTMS_SERVICE, FTMS_CONTROL_POINT, 4, gattBusyError());
      const p = trainer.setSimulation(SIM).catch((e: unknown) => e);
      await clock.advance(349);
      expect(peripheral.rejectedWrites).toHaveLength(3);
      await clock.advance(1);
      const err = await p;
      expect((err as Error).message).toMatch(/already in progress/);
      expect(peripheral.rejectedWrites).toHaveLength(4);
      // the queue keeps working
      await trainer.setSimulation(SIM);
      expect(cpWrites()).toEqual(['00', SIM_HEX]);
    });

    it('a retry writes the latest queued parameters (coalescing)', async () => {
      const { trainer, peripheral, clock, cpWrites } = setup();
      await trainer.connect();
      peripheral.failNextWrites(FTMS_SERVICE, FTMS_CONTROL_POINT, 1, gattBusyError());
      const p1 = trainer.setSimulation({ ...SIM, gradePercent: 1 });
      await flushPromises();
      const p2 = trainer.setSimulation({ ...SIM, gradePercent: 2 });
      const p3 = trainer.setSimulation({ ...SIM, gradePercent: 3 });
      await clock.advance(50);
      await Promise.all([p1, p2, p3]);
      expect(cpWrites()).toEqual(['00', '11 00 00 2c 01 28 33']);
    });

    it('does not retry when the link is gone', async () => {
      const { trainer, peripheral, clock } = setup();
      await trainer.connect();
      peripheral.failNextWrites(FTMS_SERVICE, FTMS_CONTROL_POINT, 1, gattDisconnectedError());
      const err = await trainer.setSimulation(SIM).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/GATT Server is disconnected/);
      expect(clock.pendingDelays).toEqual([]);
    });

    it('a pending retry is dropped with the link', async () => {
      const { trainer, peripheral, clock } = setup();
      await trainer.connect();
      peripheral.failNextWrites(FTMS_SERVICE, FTMS_CONTROL_POINT, 1, gattBusyError());
      const p = trainer.setSimulation(SIM).catch((e: unknown) => e);
      await flushPromises();
      peripheral.dropLink();
      expect(await p).toBeInstanceOf(DeviceDisconnectedError);
      await clock.advance(50);
      expect(peripheral.writesTo(FTMS_CONTROL_POINT).map((w) => toHex(w.data))).toEqual(['00']);
    });
  });
});
