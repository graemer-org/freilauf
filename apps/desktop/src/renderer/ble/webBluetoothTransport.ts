import type {
  BlePeripheral,
  BleTransport,
  DeviceKind,
  GattConnection,
  Unsubscribe,
  Uuid,
} from '@freilauf/devices';
import {
  BATTERY_LEVEL,
  BATTERY_SERVICE,
  CYCLING_POWER_MEASUREMENT,
  CYCLING_POWER_SERVICE,
  FTMS_CONTROL_POINT,
  FTMS_FEATURE,
  FTMS_INDOOR_BIKE_DATA,
  FTMS_SERVICE,
  FTMS_STATUS,
  HEART_RATE_MEASUREMENT,
  HEART_RATE_SERVICE,
  ZWIFT_ASYNC_CHARACTERISTIC,
  ZWIFT_LEGACY_SERVICE,
  ZWIFT_RIDE_SERVICE,
  ZWIFT_SYNC_RX_CHARACTERISTIC,
  ZWIFT_SYNC_TX_CHARACTERISTIC,
} from '@freilauf/devices';
import type { FreilaufApi } from '../../shared/contract';
import type { ScopedLog } from '../core/logger';
import { NULL_LOG } from '../core/logger';

/** Readable names for the UUIDs we use, for the diagnostic log. */
const UUID_NAMES: Record<string, string> = {
  [FTMS_SERVICE]: 'FTMS',
  [FTMS_INDOOR_BIKE_DATA]: 'FTMS indoor bike data',
  [FTMS_CONTROL_POINT]: 'FTMS control point',
  [FTMS_STATUS]: 'FTMS status',
  [FTMS_FEATURE]: 'FTMS feature',
  [CYCLING_POWER_SERVICE]: 'cycling power',
  [CYCLING_POWER_MEASUREMENT]: 'cycling power measurement',
  [HEART_RATE_SERVICE]: 'heart rate',
  [HEART_RATE_MEASUREMENT]: 'heart rate measurement',
  [BATTERY_SERVICE]: 'battery',
  [BATTERY_LEVEL]: 'battery level',
  [ZWIFT_RIDE_SERVICE]: 'Zwift Ride (FC82)',
  [ZWIFT_LEGACY_SERVICE]: 'Zwift legacy',
  [ZWIFT_ASYNC_CHARACTERISTIC]: 'Zwift async',
  [ZWIFT_SYNC_RX_CHARACTERISTIC]: 'Zwift sync RX',
  [ZWIFT_SYNC_TX_CHARACTERISTIC]: 'Zwift sync TX',
};

export function uuidName(uuid: string): string {
  const name = UUID_NAMES[uuid.toLowerCase()];
  if (name) return name;
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  return m ? `0x${m[1]}` : uuid;
}

function errorContext(err: unknown, ms: number): Record<string, unknown> {
  return { ms, error: err };
}

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

/** requestDevice() options per device kind (exported for other Web Bluetooth hosts). */
export const FILTERS: Record<DeviceKind, RequestDeviceOptions> = {
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
  readonly #log: ScopedLog;
  /** Only one chooser can be open at a time; requests are queued. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The chooser id the user picked for the request in flight. */
  #pickedId: string | null = null;

  constructor(
    api: FreilaufApi['bluetooth'],
    bluetooth: Bluetooth = navigator.bluetooth,
    log: ScopedLog = NULL_LOG,
  ) {
    this.#api = api;
    this.#bluetooth = bluetooth;
    this.#log = log;
  }

  /** The UI calls this (not api.pick directly) so the transport learns the chosen id. */
  pick(deviceId: string): void {
    this.#log.info('user picked a device in the chooser', { id: deviceId });
    this.#pickedId = deviceId;
    this.#api.pick(deviceId);
  }

  cancelPicker(): void {
    this.#log.info('user cancelled the chooser');
    this.#api.cancelPicker();
  }

  requestDevice(kind: DeviceKind): Promise<BlePeripheral> {
    return this.#enqueue(async () => {
      this.#pickedId = null;
      await this.#api.prepareChooser(null);
      const started = Date.now();
      this.#log.info(`${kind}: requestDevice (interactive chooser)`);
      let device: BluetoothDevice;
      try {
        device = await this.#bluetooth.requestDevice(FILTERS[kind]);
      } catch (err) {
        this.#log.warn(`${kind}: requestDevice failed`, errorContext(err, Date.now() - started));
        throw err;
      }
      const id = this.#pickedId ?? device.id;
      this.#log.info(`${kind}: chosen "${device.name ?? 'Unknown device'}"`, {
        id,
        ms: Date.now() - started,
      });
      return new WebBluetoothPeripheral(device, id, this.#log);
    });
  }

  findKnownDevice(kind: DeviceKind, id: string): Promise<BlePeripheral | null> {
    return this.#enqueue(async () => {
      await this.#api.prepareChooser({ deviceId: id, timeoutMs: AUTO_SELECT_TIMEOUT_MS });
      await this.#api.grantUserGesture();
      const started = Date.now();
      this.#log.info(`${kind}: looking for remembered device`, {
        id,
        timeoutMs: AUTO_SELECT_TIMEOUT_MS,
      });
      try {
        const device = await this.#bluetooth.requestDevice(FILTERS[kind]);
        this.#log.info(`${kind}: found "${device.name ?? 'Unknown device'}"`, {
          id,
          ms: Date.now() - started,
        });
        return new WebBluetoothPeripheral(device, id, this.#log);
      } catch (err) {
        // Chooser cancelled by main after the timeout: the device is not around.
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          this.#log.info(
            `${kind}: remembered device not found`,
            errorContext(err, Date.now() - started),
          );
          return null;
        }
        this.#log.warn(`${kind}: search failed`, errorContext(err, Date.now() - started));
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

export class WebBluetoothPeripheral implements BlePeripheral {
  readonly id: string;
  readonly name: string;
  readonly #device: BluetoothDevice;
  readonly #log: ScopedLog;

  constructor(device: BluetoothDevice, id: string, log: ScopedLog = NULL_LOG) {
    this.#device = device;
    this.id = id;
    this.name = device.name ?? 'Unknown device';
    this.#log = log;
  }

  async connect(): Promise<GattConnection> {
    const gatt = this.#device.gatt;
    if (!gatt) throw new Error('Device has no GATT server');
    const label = `"${this.name}"`;
    const started = Date.now();
    this.#log.debug(`${label}: gatt.connect()`, { id: this.id });
    let server: BluetoothRemoteGATTServer;
    try {
      server = await gatt.connect();
    } catch (err) {
      this.#log.warn(`${label}: gatt.connect() failed`, errorContext(err, Date.now() - started));
      throw err;
    }
    this.#log.info(`${label}: GATT connected`, { id: this.id, ms: Date.now() - started });
    // Which services are there (only those allowed by the request filters are visible).
    try {
      const services = await server.getPrimaryServices();
      this.#log.info(`${label}: services`, { services: services.map((x) => uuidName(x.uuid)) });
    } catch (err) {
      this.#log.debug(`${label}: could not list services`, { error: err });
    }
    return new WebBluetoothConnection(this.#device, server, this.#log, label);
  }
}

class WebBluetoothConnection implements GattConnection {
  readonly #device: BluetoothDevice;
  readonly #server: BluetoothRemoteGATTServer;
  readonly #characteristics = new Map<string, Promise<BluetoothRemoteGATTCharacteristic>>();
  readonly #log: ScopedLog;
  readonly #label: string;

  constructor(
    device: BluetoothDevice,
    server: BluetoothRemoteGATTServer,
    log: ScopedLog = NULL_LOG,
    label = 'device',
  ) {
    this.#device = device;
    this.#server = server;
    this.#log = log;
    this.#label = label;
  }

  async hasService(service: Uuid): Promise<boolean> {
    try {
      await this.#server.getPrimaryService(service);
      this.#log.debug(`${this.#label}: has service ${uuidName(service)}`);
      return true;
    } catch (err) {
      this.#log.debug(`${this.#label}: no service ${uuidName(service)}`, { error: err });
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
    try {
      const c = await this.#characteristic(service, characteristic);
      const bytes = new Uint8Array(data); // detach from any shared/offset buffer
      if (options?.withoutResponse) await c.writeValueWithoutResponse(bytes);
      else await c.writeValueWithResponse(bytes);
    } catch (err) {
      this.#log.warn(`${this.#label}: write to ${uuidName(characteristic)} failed`, {
        service: uuidName(service),
        bytes: data,
        error: err,
      });
      throw err;
    }
  }

  async subscribe(
    service: Uuid,
    characteristic: Uuid,
    listener: (data: DataView) => void,
  ): Promise<Unsubscribe> {
    const started = Date.now();
    const what = `${uuidName(service)}/${uuidName(characteristic)}`;
    let c: BluetoothRemoteGATTCharacteristic;
    try {
      c = await this.#characteristic(service, characteristic);
    } catch (err) {
      this.#log.warn(
        `${this.#label}: characteristic ${what} not found`,
        errorContext(err, Date.now() - started),
      );
      throw err;
    }
    const handler = () => {
      if (c.value) listener(c.value);
    };
    c.addEventListener('characteristicvaluechanged', handler);
    try {
      await c.startNotifications();
    } catch (err) {
      c.removeEventListener('characteristicvaluechanged', handler);
      this.#log.warn(
        `${this.#label}: subscribe ${what} failed`,
        errorContext(err, Date.now() - started),
      );
      throw err;
    }
    this.#log.debug(`${this.#label}: subscribed ${what}`, { ms: Date.now() - started });
    return () => {
      c.removeEventListener('characteristicvaluechanged', handler);
      if (this.#server.connected) c.stopNotifications().catch(() => undefined);
    };
  }

  async disconnect(): Promise<void> {
    this.#log.info(`${this.#label}: disconnecting (requested by the app)`);
    this.#server.disconnect();
  }

  onDisconnect(listener: () => void): Unsubscribe {
    const handler = () => {
      this.#log.info(`${this.#label}: gattserverdisconnected`);
      listener();
    };
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
