import { describe, expect, it } from 'vitest';
import { BleHeartRateSensor } from './heartRateSensor';
import { FakePeripheral, FakeScheduler } from './testing/fakeGatt';
import { HEART_RATE_MEASUREMENT, HEART_RATE_SERVICE } from './uuids';

describe('BleHeartRateSensor', () => {
  it('emits bpm, drops zero readings, and resubscribes after reconnect', async () => {
    const peripheral = new FakePeripheral({ services: [HEART_RATE_SERVICE], name: 'HRM' });
    const clock = new FakeScheduler();
    const hr = new BleHeartRateSensor(peripheral, { schedule: clock.schedule });
    const bpm: number[] = [];
    hr.onHeartRate((v) => bpm.push(v));
    await hr.connect();
    expect(hr.kind).toBe('heartRate');
    expect(hr.name).toBe('HRM');

    peripheral.notify(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, '00 48');
    peripheral.notify(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, '00 00');
    peripheral.notify(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, '01 2c');
    peripheral.dropLink();
    expect(hr.state).toBe('reconnecting');
    await clock.advance(1000);
    expect(hr.state).toBe('connected');
    peripheral.notify(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, '16 50 00 04');
    expect(bpm).toEqual([72, 80]);
  });

  it('fails to connect when the service is missing', async () => {
    const hr = new BleHeartRateSensor(new FakePeripheral({ services: [] }));
    await expect(hr.connect()).rejects.toThrow();
    expect(hr.state).toBe('disconnected');
  });
});
