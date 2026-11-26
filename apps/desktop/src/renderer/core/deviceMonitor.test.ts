import { describe, expect, it } from 'vitest';
import {
  BleHeartRateSensor,
  FTMS_SERVICE,
  FakePeripheral,
  FtmsTrainer,
  HEART_RATE_MEASUREMENT,
  HEART_RATE_SERVICE,
} from '@freilauf/devices';
import { SimulatedController, SimulatedHeartRate } from '@freilauf/sim';
import type { ScopedLog } from './logger';
import { DeviceMonitor, SUMMARY_INTERVAL_MS } from './deviceMonitor';

function recorder() {
  const lines: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  const log: ScopedLog = {
    debug: (message, context) => lines.push({ level: 'debug', message, context }),
    info: (message, context) => lines.push({ level: 'info', message, context }),
    warn: (message, context) => lines.push({ level: 'warn', message, context }),
    error: (message, context) => lines.push({ level: 'error', message, context }),
  };
  return { lines, log };
}

describe('DeviceMonitor', () => {
  it('logs every battery change, per grip for controllers', () => {
    const { lines, log } = recorder();
    const monitor = new DeviceMonitor(log, () => 0);
    const hr = new SimulatedHeartRate();
    const controller = new SimulatedController();
    monitor.watch(hr);
    monitor.watch(controller);
    hr.setBattery(64);
    controller.setBattery(81, 'left');
    controller.setBattery(12, 'right');
    const battery = lines.filter((l) => l.message.includes('battery'));
    expect(battery.map((l) => l.message)).toEqual([
      'heartRate "Simulated HR": battery 64%',
      'controller "Simulated Controller": battery left 81%',
      'controller "Simulated Controller": battery left 81%, right 12%',
    ]);
    expect(battery[2]!.context).toEqual({
      percent: 12,
      left: 81,
      right: 12,
      source: 'controller-protocol',
    });
    monitor.dispose();
  });

  it('logs state transitions, the first packet and a periodic summary', async () => {
    let now = 1000;
    const { lines, log } = recorder();
    const monitor = new DeviceMonitor(log, () => now);
    const peripheral = new FakePeripheral({ name: 'HRM-Pro', services: [HEART_RATE_SERVICE] });
    const hr = new BleHeartRateSensor(peripheral);
    monitor.watch(hr);
    await hr.connect();
    expect(lines.map((l) => l.message)).toContain('heartRate "HRM-Pro" connecting → connected');

    now += 500;
    peripheral.notify(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, new Uint8Array([0x00, 140]));
    peripheral.notify(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, new Uint8Array([0x00, 141]));
    const first = lines.filter((l) => l.message.endsWith('first data'));
    expect(first).toHaveLength(1);
    expect(first[0]!.context).toMatchObject({ bpm: 140, afterConnectMs: 500 });

    now += SUMMARY_INTERVAL_MS;
    monitor.tick();
    expect(lines.at(-1)).toMatchObject({
      level: 'debug',
      message: 'heartRate "HRM-Pro": 2 packets in the last 31 s',
      context: { packets: 2, bpm: 141 },
    });

    now += SUMMARY_INTERVAL_MS;
    monitor.tick();
    expect(lines.at(-1)!.level).toBe('warn'); // connected but silent
    monitor.dispose();
    await hr.disconnect();
  });

  it('forwards driver diagnostics (GATT link, control point) from real drivers', async () => {
    const { lines, log } = recorder();
    const monitor = new DeviceMonitor(log);
    const trainer = new FtmsTrainer(new FakePeripheral({ services: [FTMS_SERVICE] }), {
      responseTimeoutMs: 10,
    });
    monitor.watch(trainer);
    await trainer.connect();
    const messages = lines.map((l) => l.message);
    expect(messages.some((m) => m.includes('GATT link open'))).toBe(true);
    expect(messages.some((m) => m.includes('RequestControl sent'))).toBe(true);
    monitor.dispose();
    await trainer.disconnect();
  });
});
