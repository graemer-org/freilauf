import { describe, expect, it } from 'vitest';
import { BatteryTracker, clampBatteryPercent, parseBatteryLevel } from './battery';
import type { BatteryState } from './battery';
import { BleHeartRateSensor } from './heartRateSensor';
import type { DeviceDiagnostic } from './managedDevice';
import {
  dataView,
  fakeDomError,
  FakePeripheral,
  FakeScheduler,
  flushPromises,
} from './testing/fakeGatt';
import { BATTERY_LEVEL, BATTERY_SERVICE, HEART_RATE_SERVICE } from './uuids';

const POLL_MS = 5 * 60_000;

describe('parseBatteryLevel', () => {
  it('reads the single byte', () => {
    expect(parseBatteryLevel(dataView('40'))).toBe(64);
    expect(parseBatteryLevel(dataView('00'))).toBe(0);
    expect(parseBatteryLevel(dataView('64'))).toBe(100);
    expect(parseBatteryLevel(dataView('0c ff'))).toBe(12); // trailing bytes ignored
  });

  it('clamps values above 100 and rejects an empty value', () => {
    expect(parseBatteryLevel(dataView('65'))).toBe(100);
    expect(parseBatteryLevel(dataView('ff'))).toBe(100);
    expect(parseBatteryLevel(dataView(''))).toBeNull();
    expect(clampBatteryPercent(-3)).toBe(0);
    expect(clampBatteryPercent(Number.NaN)).toBe(0);
    expect(clampBatteryPercent(41.6)).toBe(42);
  });
});

describe('BatteryTracker', () => {
  it('keeps both grips and shows the lower one', () => {
    const t = new BatteryTracker();
    expect(t.update({ percent: 81, side: 'left', source: 'controller-protocol' }, 1)).toBe(true);
    expect(t.update({ percent: 12, side: 'right', source: 'controller-protocol' }, 2)).toBe(true);
    expect(t.state).toEqual({
      percent: 12,
      left: 81,
      right: 12,
      source: 'controller-protocol',
      updatedAt: 2,
    });
    // Same value again: only the time moves.
    expect(t.update({ percent: 12, side: 'right', source: 'controller-protocol' }, 3)).toBe(false);
    expect(t.state?.updatedAt).toBe(3);
  });

  it('prefers the protocol over the Battery Service', () => {
    const t = new BatteryTracker();
    t.update({ percent: 90, source: 'battery-service' }, 1);
    t.update({ percent: 50, side: 'left', source: 'controller-protocol' }, 2);
    expect(t.state).toMatchObject({ percent: 50, left: 50, source: 'controller-protocol' });
    expect(t.update({ percent: 10, source: 'battery-service' }, 3)).toBe(false);
    expect(t.state?.percent).toBe(50);
  });
});

function hrRig(options: { battery?: string | null; services?: string[] } = {}) {
  const services = options.services ?? [HEART_RATE_SERVICE, BATTERY_SERVICE];
  const peripheral = new FakePeripheral({ services });
  if (options.battery !== null) {
    peripheral.setValue(BATTERY_SERVICE, BATTERY_LEVEL, options.battery ?? '40');
  }
  const clock = new FakeScheduler();
  const sensor = new BleHeartRateSensor(peripheral, { schedule: clock.schedule, now: clock.now });
  const levels: BatteryState[] = [];
  const diags: DeviceDiagnostic[] = [];
  sensor.onBattery((b) => levels.push(b));
  sensor.onDiagnostic((d) => diags.push(d));
  return { peripheral, clock, sensor, levels, diags };
}

describe('Battery Service on a managed device', () => {
  it('reads the level shortly after connecting and follows notifications', async () => {
    const { peripheral, clock, sensor, levels, diags } = hrRig();
    await sensor.connect();
    expect(sensor.battery).toBeNull(); // not during the driver's own setup
    await clock.advance(2000);
    expect(sensor.battery).toMatchObject({ percent: 64, source: 'battery-service' });
    expect(sensor.battery?.updatedAt).toBe(2000);
    expect(peripheral.current?.isSubscribed(BATTERY_SERVICE, BATTERY_LEVEL)).toBe(true);

    peripheral.notify(BATTERY_SERVICE, BATTERY_LEVEL, '3f');
    expect(levels.map((l) => l.percent)).toEqual([64, 63]);
    // Notifying: no polling timer left.
    expect(clock.pendingDelays).toEqual([]);
    expect(diags.map((d) => d.event)).toContain('battery-subscribed');
  });

  it('polls every 5 minutes when the level does not notify', async () => {
    const { peripheral, clock, sensor, levels } = hrRig();
    peripheral.failSubscribe(BATTERY_SERVICE, BATTERY_LEVEL);
    await sensor.connect();
    await clock.advance(2000);
    expect(levels.map((l) => l.percent)).toEqual([64]);
    expect(clock.pendingDelays).toEqual([POLL_MS]);

    peripheral.setValue(BATTERY_SERVICE, BATTERY_LEVEL, '3c');
    await clock.advance(POLL_MS);
    expect(levels.map((l) => l.percent)).toEqual([64, 60]);
    await clock.advance(POLL_MS); // unchanged: no event, but the time moves on
    expect(levels).toHaveLength(2);
    expect(sensor.battery?.updatedAt).toBe(2000 + 2 * POLL_MS);
  });

  it('has no battery without the service, and that is not an error', async () => {
    const { clock, sensor, levels, diags } = hrRig({ services: [HEART_RATE_SERVICE] });
    await sensor.connect();
    await clock.advance(POLL_MS * 2);
    expect(sensor.state).toBe('connected');
    expect(sensor.battery).toBeNull();
    expect(levels).toEqual([]);
    expect(diags.filter((d) => d.level === 'warn' || d.level === 'error')).toEqual([]);
    expect(clock.pendingDelays).toEqual([]);
  });

  it('tolerates failing reads (Windows GATT errors) and tries again', async () => {
    const { peripheral, clock, sensor, diags } = hrRig({ battery: null });
    await sensor.connect();
    await clock.advance(2000);
    expect(sensor.battery).toBeNull();
    expect(diags.some((d) => d.event === 'battery-read-failed')).toBe(true);
    expect(sensor.state).toBe('connected');

    peripheral.setValue(BATTERY_SERVICE, BATTERY_LEVEL, '22');
    await clock.advance(15_000);
    expect(sensor.battery?.percent).toBe(34);
  });

  it('tolerates a failing service lookup', async () => {
    const { peripheral, clock, sensor } = hrRig();
    await sensor.connect();
    const conn = peripheral.current!;
    const original = conn.hasService.bind(conn);
    let fail = true;
    conn.hasService = async (s) => {
      if (fail && s === BATTERY_SERVICE) {
        fail = false;
        throw fakeDomError('NetworkError', 'GATT operation failed for unknown reason.');
      }
      return original(s);
    };
    await clock.advance(2000);
    expect(sensor.battery).toBeNull();
    await clock.advance(15_000);
    expect(sensor.battery?.percent).toBe(64);
  });

  it('keeps the last level while reconnecting and reads it again afterwards', async () => {
    const { peripheral, clock, sensor, levels } = hrRig();
    await sensor.connect();
    await clock.advance(2000);
    peripheral.dropLink();
    await flushPromises();
    expect(sensor.state).toBe('reconnecting');
    expect(sensor.battery?.percent).toBe(64);

    peripheral.setValue(BATTERY_SERVICE, BATTERY_LEVEL, '3e');
    await clock.advance(1000); // reconnect
    expect(sensor.state).toBe('connected');
    await clock.advance(2000);
    expect(levels.map((l) => l.percent)).toEqual([64, 62]);
    expect(peripheral.current?.isSubscribed(BATTERY_SERVICE, BATTERY_LEVEL)).toBe(true);
  });

  it('stops all battery timers on disconnect', async () => {
    const { peripheral, clock, sensor } = hrRig();
    peripheral.failSubscribe(BATTERY_SERVICE, BATTERY_LEVEL);
    await sensor.connect();
    await clock.advance(2000);
    expect(clock.pendingDelays).toEqual([POLL_MS]);
    await sensor.disconnect();
    expect(clock.pendingDelays).toEqual([]);
  });

  it('can be turned off', async () => {
    const peripheral = new FakePeripheral({ services: [HEART_RATE_SERVICE, BATTERY_SERVICE] });
    peripheral.setValue(BATTERY_SERVICE, BATTERY_LEVEL, '40');
    const clock = new FakeScheduler();
    const sensor = new BleHeartRateSensor(peripheral, { schedule: clock.schedule, battery: false });
    await sensor.connect();
    await clock.advance(10_000);
    expect(sensor.battery).toBeNull();
  });
});
