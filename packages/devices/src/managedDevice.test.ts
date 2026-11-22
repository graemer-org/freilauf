import { describe, expect, it } from 'vitest';
import { backoffDelay, ManagedDevice } from './managedDevice';
import type { ManagedDeviceOptions } from './managedDevice';
import { FakePeripheral, FakeScheduler, flushPromises } from './testing/fakeGatt';
import type { BlePeripheral, ConnectionState, GattConnection } from './types';
import { HEART_RATE_MEASUREMENT, HEART_RATE_SERVICE } from './uuids';

class TestDevice extends ManagedDevice<'heartRate'> {
  readonly kind = 'heartRate' as const;
  setups = 0;
  linkDowns = 0;
  failSetup: Error | null = null;
  constructor(p: BlePeripheral, o: ManagedDeviceOptions) {
    super(p, o);
  }
  protected async setup(conn: GattConnection): Promise<void> {
    this.setups++;
    if (this.failSetup) throw this.failSetup;
    await conn.subscribe(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, () => {});
  }
  protected override onLinkDown(): void {
    this.linkDowns++;
  }
}

function setup() {
  const peripheral = new FakePeripheral({ services: [HEART_RATE_SERVICE] });
  const clock = new FakeScheduler();
  const device = new TestDevice(peripheral, { schedule: clock.schedule });
  const states: ConnectionState[] = [];
  device.onState((s) => states.push(s));
  return { peripheral, clock, device, states };
}

describe('backoffDelay', () => {
  it('doubles from 1 s and caps at 15 s', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((n) => backoffDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 15000, 15000, 15000,
    ]);
  });
});

describe('ManagedDevice', () => {
  it('connects: disconnected → connecting → connected', async () => {
    const { device, states, peripheral } = setup();
    expect(device.state).toBe('disconnected');
    await device.connect();
    expect(device.state).toBe('connected');
    expect(states).toEqual(['connecting', 'connected']);
    expect(device.setups).toBe(1);
    expect(peripheral.current?.isSubscribed(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT)).toBe(true);
    expect(device.id).toBe('fake-1');
  });

  it('connect() while connecting returns the same promise; while connected resolves', async () => {
    const { device, peripheral } = setup();
    const a = device.connect();
    const b = device.connect();
    expect(b).toBe(a);
    await a;
    await device.connect();
    expect(peripheral.connectAttempts).toBe(1);
  });

  it('rejects and returns to disconnected if the first connect fails', async () => {
    const { device, states, peripheral, clock } = setup();
    peripheral.failNextConnects(1);
    await expect(device.connect()).rejects.toThrow('connect failed');
    expect(device.state).toBe('disconnected');
    expect(states).toEqual(['connecting', 'disconnected']);
    expect(clock.pendingDelays).toEqual([]);
  });

  it('rejects and closes the link if setup fails on the first connect', async () => {
    const { device, peripheral } = setup();
    device.failSetup = new Error('setup boom');
    await expect(device.connect()).rejects.toThrow('setup boom');
    expect(device.state).toBe('disconnected');
    expect(peripheral.connections[0]?.connected).toBe(false);
  });

  it('reconnects after link loss and re-runs setup', async () => {
    const { device, states, peripheral, clock } = setup();
    await device.connect();
    peripheral.dropLink();
    expect(device.state).toBe('reconnecting');
    expect(device.linkDowns).toBe(1);
    expect(clock.pendingDelays).toEqual([1000]);

    await clock.advance(999);
    expect(peripheral.connectAttempts).toBe(1);
    await clock.advance(1);
    expect(device.state).toBe('connected');
    expect(device.setups).toBe(2);
    expect(peripheral.connections).toHaveLength(2);
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
  });

  it('reports lifecycle steps through onDiagnostic', async () => {
    const { device, peripheral, clock } = setup();
    const events: string[] = [];
    device.onDiagnostic((d) => events.push(d.event));
    await device.connect();
    expect(events).toEqual(['link-attempt', 'link-up', 'setup-done']);
    events.length = 0;
    peripheral.failNextConnects(1);
    peripheral.dropLink();
    expect(events).toEqual(['link-lost', 'retry-scheduled']);
    await clock.advance(1000);
    expect(events).toEqual([
      'link-lost',
      'retry-scheduled',
      'link-attempt',
      'link-failed',
      'retry-failed',
      'retry-scheduled',
    ]);
  });

  it('grows the backoff on repeated failures, caps it, and resets after success', async () => {
    const { device, peripheral, clock } = setup();
    await device.connect();
    peripheral.failConnects();
    peripheral.dropLink();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const d = clock.pendingDelays[0]!;
      delays.push(d);
      await clock.advance(d);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(device.state).toBe('reconnecting');

    peripheral.failConnects(null);
    await clock.advance(clock.pendingDelays[0]!);
    expect(device.state).toBe('connected');

    peripheral.dropLink();
    expect(clock.pendingDelays).toEqual([1000]);
  });

  it('treats a setup failure during reconnect as a failed attempt', async () => {
    const { device, peripheral, clock } = setup();
    await device.connect();
    device.failSetup = new Error('nope');
    peripheral.dropLink();
    await clock.advance(1000);
    expect(device.state).toBe('reconnecting');
    expect(clock.pendingDelays).toEqual([2000]);
    expect(peripheral.connections[1]?.connected).toBe(false);
    device.failSetup = null;
    await clock.advance(2000);
    expect(device.state).toBe('connected');
  });

  it('disconnect() during backoff cancels the retry', async () => {
    const { device, states, peripheral, clock } = setup();
    await device.connect();
    peripheral.dropLink();
    expect(clock.pendingDelays).toHaveLength(1);
    await device.disconnect();
    expect(device.state).toBe('disconnected');
    expect(clock.pendingDelays).toEqual([]);
    await clock.advance(60_000);
    expect(peripheral.connectAttempts).toBe(1);
    expect(states.at(-1)).toBe('disconnected');
  });

  it('disconnect() closes the link without reconnecting', async () => {
    const { device, peripheral, clock } = setup();
    await device.connect();
    const conn = peripheral.current!;
    await device.disconnect();
    expect(conn.connected).toBe(false);
    expect(device.state).toBe('disconnected');
    expect(device.linkDowns).toBe(1);
    expect(clock.pendingDelays).toEqual([]);
    // can connect again
    await device.connect();
    expect(device.state).toBe('connected');
  });

  it('disconnect() while the first connect is pending rejects connect()', async () => {
    const { device, peripheral } = setup();
    const p = device.connect();
    const disc = device.disconnect();
    await expect(p).rejects.toThrow('disconnected while connecting');
    await disc;
    await flushPromises();
    expect(device.state).toBe('disconnected');
    expect(peripheral.connections.every((c) => !c.connected)).toBe(true);
  });

  it('a link drop during first-connect setup rejects connect()', async () => {
    const { device, peripheral, clock } = setup();
    device.failSetup = null;
    const orig = peripheral.connect.bind(peripheral);
    peripheral.connect = async () => {
      const c = await orig();
      const sub = c.subscribe.bind(c);
      c.subscribe = async (...args) => {
        const u = await sub(...args);
        peripheral.dropLink();
        return u;
      };
      return c;
    };
    await expect(device.connect()).rejects.toThrow('link lost during setup');
    expect(device.state).toBe('disconnected');
    expect(clock.pendingDelays).toEqual([]);
  });
});
