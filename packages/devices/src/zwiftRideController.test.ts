import { describe, expect, it } from 'vitest';
import { FakePeripheral, FakeScheduler, flushPromises, toHex } from './testing/fakeGatt';
import type { ControllerButtonEvent } from './types';
import {
  ZWIFT_ASYNC_CHARACTERISTIC,
  ZWIFT_LEGACY_SERVICE,
  ZWIFT_RIDE_SERVICE,
  ZWIFT_SYNC_RX_CHARACTERISTIC,
} from './zwiftRide';
import { ZwiftRideController } from './zwiftRideController';

const IDLE = '2308ffffffff0f';
// shiftDownRight (0x2000) cleared: ~0x2000 = 0xffffdfff → varint ff bf ff ff 0f
const SHIFT_DOWN_RIGHT = '2308ffbfffff0f';

async function setup(service = ZWIFT_RIDE_SERVICE) {
  const scheduler = new FakeScheduler();
  const peripheral = new FakePeripheral({ services: [service] });
  const controller = new ZwiftRideController(peripheral, { schedule: scheduler.schedule });
  const events: ControllerButtonEvent[] = [];
  controller.onButton((e) => events.push(e));
  await controller.connect();
  return { scheduler, peripheral, controller, events };
}

describe('ZwiftRideController', () => {
  it('sends the handshake and turns keypad frames into button edges', async () => {
    const { peripheral, events } = await setup();
    expect(peripheral.writesTo(ZWIFT_SYNC_RX_CHARACTERISTIC).map((w) => toHex(w.data))).toEqual([
      '52 69 64 65 4f 6e',
    ]);
    peripheral.notify(ZWIFT_RIDE_SERVICE, ZWIFT_ASYNC_CHARACTERISTIC, IDLE);
    peripheral.notify(ZWIFT_RIDE_SERVICE, ZWIFT_ASYNC_CHARACTERISTIC, SHIFT_DOWN_RIGHT);
    peripheral.notify(ZWIFT_RIDE_SERVICE, ZWIFT_ASYNC_CHARACTERISTIC, SHIFT_DOWN_RIGHT);
    peripheral.notify(ZWIFT_RIDE_SERVICE, ZWIFT_ASYNC_CHARACTERISTIC, IDLE);
    expect(events).toEqual([
      { button: 'shiftDownRight', pressed: true },
      { button: 'shiftDownRight', pressed: false },
    ]);
  });

  it('falls back to the legacy service', async () => {
    const { peripheral, events } = await setup(ZWIFT_LEGACY_SERVICE);
    peripheral.notify(ZWIFT_LEGACY_SERVICE, ZWIFT_ASYNC_CHARACTERISTIC, SHIFT_DOWN_RIGHT);
    expect(events).toHaveLength(1);
  });

  it('exposes raw frames and battery, ignores garbage', async () => {
    const { peripheral, controller, events } = await setup();
    const raw: string[] = [];
    const battery: number[] = [];
    controller.onRawFrame((f) => raw.push(toHex(f.bytes)));
    controller.onBattery((p) => battery.push(p));
    peripheral.notify(ZWIFT_RIDE_SERVICE, ZWIFT_ASYNC_CHARACTERISTIC, '191055');
    peripheral.notify(ZWIFT_RIDE_SERVICE, ZWIFT_ASYNC_CHARACTERISTIC, '2308ff');
    expect(battery).toEqual([85]);
    expect(raw).toEqual(['19 10 55', '23 08 ff']);
    expect(events).toEqual([]);
  });

  it('releases held buttons when the link drops and re-handshakes after reconnect', async () => {
    const { peripheral, controller, events, scheduler } = await setup();
    peripheral.notify(ZWIFT_RIDE_SERVICE, ZWIFT_ASYNC_CHARACTERISTIC, SHIFT_DOWN_RIGHT);
    peripheral.dropLink();
    await flushPromises();
    expect(controller.state).toBe('reconnecting');
    expect(events.at(-1)).toEqual({ button: 'shiftDownRight', pressed: false });
    await scheduler.advance(1000);
    await flushPromises();
    expect(controller.state).toBe('connected');
    expect(peripheral.writesTo(ZWIFT_SYNC_RX_CHARACTERISTIC)).toHaveLength(2);
  });

  it('emits signed lever values per grip and returns a held lever to rest when the link drops', async () => {
    const { peripheral, controller } = await setup();
    const levers: { side: string; value: number }[] = [];
    controller.onPaddle((e) => levers.push(e));
    // Captured frame: right lever at +100, left at rest, locations 2 and 3 ignored.
    peripheral.notify(
      ZWIFT_RIDE_SERVICE,
      ZWIFT_ASYNC_CHARACTERISTIC,
      '2308ffffffff0f1a04080010001a05080110c8011a04080210001a0408031000',
    );
    expect(levers).toEqual([
      { side: 'left', value: 0 },
      { side: 'right', value: 1 },
    ]);
    peripheral.dropLink();
    await flushPromises();
    expect(levers.at(-1)).toEqual({ side: 'right', value: 0 });
    expect(levers).toHaveLength(3); // the left lever was already at rest
  });
});
