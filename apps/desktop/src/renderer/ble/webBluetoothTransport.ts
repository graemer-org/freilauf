import type {
  BlePeripheral,
  BleTransport,
  DeviceKind,
  GattConnection,
  Unsubscribe,
  Uuid,
} from '@freilauf/devices';
import {
  BATTERY_SERVICE,
  CYCLING_POWER_SERVICE,
  FTMS_SERVICE,
  HEART_RATE_SERVICE,
  ZWIFT_LEGACY_SERVICE,
  ZWIFT_RIDE_SERVICE,
} from '@freilauf/devices';
import type { FreilaufApi } from '../../shared/contract';

/**
 * BleTransport on top of Web Bluetooth in the Electron renderer.
 *
 * Chromium has no silent "connect to a known device": every device comes
 * out of requestDevice() and its chooser. The main process answers the
 * chooser for us (see FreilaufApi.bluetooth): interactively for pairing,
 * automatically with the remembered id for reconnect on start.
 *
 * Note: BluetoothDevice.id is an opaque per-origin value. The id we expose
 * and remember is the chooser's device id (the address), because that is
 * what the main process can match on the next start.
 */

const FILTERS: Record<DeviceKind, RequestDeviceOptions> = {
  trainer: {
    filters: [{ services: [FTMS_SERVICE] }],
    optionalServices: [CYCLING_POWER_SERVICE, BATTERY_SERVICE],
  },
  heartRate: {
    filters: [{ services: [HEART_RATE_SERVICE] }],
    optionalServices: [BATTERY_SERVICE],
  },
  controller: {
    filters: [{ services: [ZWIFT_RIDE_SERVICE] }, { services: [ZWIFT_LEGACY_SERVICE] }],
    optionalServices: [ZWIFT_RIDE_SERVICE, ZWIFT_LEGACY_SERVICE, BATTERY_SERVICE],
  },
};

const AUTO_SELECT_TIMEOUT_MS = 15_000;

export class WebBluetoothTransport implements BleTransport {
  readonly #api: FreilaufApi['bluetooth'];
  readonly #bluetooth: Bluetooth;
  /** Only one chooser can be open at a time; requests are queued. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The chooser id the user picked for the request in flight. */
  #pickedId: string | null = null;

  constructor(api: FreilaufApi['bluetooth'], bluetooth: Bluetooth = navigator.bluetooth) {
    this.#api = api;
    this.#bluetooth = bluetooth;
  }

  /** The UI calls this (not api.pick directly) so the transport learns the chosen id. */
  pick(deviceId: string): void {
    this.#pickedId = deviceId;
    this.#api.pick(deviceId);
  }

  cancelPicker(): void {
    this.#api.cancelPicker();
  }

  requestDevice(kind: DeviceKind): Promise<BlePeripheral> {
    return this.#enqueue(async () => {
      this.#pickedId = null;
      await this.#api.prepareChooser(null);
      const device = await this.#bluetooth.requestDevice(FILTERS[kind]);
      return new WebBluetoothPeripheral(device, this.#pickedId ?? device.id);
    });
  }

  findKnownDevice(kind: DeviceKind, id: string): Promise<BlePeripheral | null> {
    return this.#enqueue(async () => {
      await this.#api.prepareChooser({ deviceId: id, timeoutMs: AUTO_SELECT_TIMEOUT_MS });
      await this.#api.grantUserGesture();
      try {
        const device = await this.#bluetooth.requestDevice(FILTERS[kind]);
        return new WebBluetoothPeripheral(device, id);
      } catch (err) {
        // Chooser cancelled by main after the timeout: the device is not around.
        if (err instanceof DOMException && err.name === 'NotFoundError') return null;
        throw err;
      }
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

class WebBluetoothPeripheral implements BlePeripheral {
  readonly id: string;
  readonly name: string;
  readonly #device: BluetoothDevice;

  constructor(device: BluetoothDevice, id: string) {
    this.#device = device;
    this.id = id;
    this.name = device.name ?? 'Unknown device';
  }

  async connect(): Promise<GattConnection> {
    const gatt = this.#device.gatt;
    if (!gatt) throw new Error('Device has no GATT server');
    const server = await gatt.connect();
    return new WebBluetoothConnection(this.#device, server);
  }
}

class WebBluetoothConnection implements GattConnection {
  readonly #device: BluetoothDevice;
  readonly #server: BluetoothRemoteGATTServer;
  readonly #characteristics = new Map<string, Promise<BluetoothRemoteGATTCharacteristic>>();

  constructor(device: BluetoothDevice, server: BluetoothRemoteGATTServer) {
    this.#device = device;
    this.#server = server;
  }

  async hasService(service: Uuid): Promise<boolean> {
    try {
      await this.#server.getPrimaryService(service);
      return true;
    } catch {
      return false;
    }
  }

  async read(service: Uuid, characteristic: Uuid): Promise<DataView> {
    return (await this.#characteristic(service, characteristic)).readValue();
  }

  async write(
    service: Uuid,
    characteristic: Uuid,
    data: Uint8Array,
    options?: { withoutResponse?: boolean },
  ): Promise<void> {
    const c = await this.#characteristic(service, characteristic);
    const bytes = new Uint8Array(data); // detach from any shared/offset buffer
    if (options?.withoutResponse) await c.writeValueWithoutResponse(bytes);
    else await c.writeValueWithResponse(bytes);
  }

  async subscribe(
    service: Uuid,
    characteristic: Uuid,
    listener: (data: DataView) => void,
  ): Promise<Unsubscribe> {
    const c = await this.#characteristic(service, characteristic);
    const handler = () => {
      if (c.value) listener(c.value);
    };
    c.addEventListener('characteristicvaluechanged', handler);
    await c.startNotifications();
    return () => {
      c.removeEventListener('characteristicvaluechanged', handler);
      if (this.#server.connected) c.stopNotifications().catch(() => undefined);
    };
  }

  async disconnect(): Promise<void> {
    this.#server.disconnect();
  }

  onDisconnect(listener: () => void): Unsubscribe {
    const handler = () => listener();
    this.#device.addEventListener('gattserverdisconnected', handler, { once: true });
    return () => this.#device.removeEventListener('gattserverdisconnected', handler);
  }

  #characteristic(service: Uuid, characteristic: Uuid): Promise<BluetoothRemoteGATTCharacteristic> {
    const key = `${service}/${characteristic}`;
    let found = this.#characteristics.get(key);
    if (!found) {
      found = this.#server
        .getPrimaryService(service)
        .then((s) => s.getCharacteristic(characteristic));
      found.catch(() => this.#characteristics.delete(key));
      this.#characteristics.set(key, found);
    }
    return found;
  }
}
