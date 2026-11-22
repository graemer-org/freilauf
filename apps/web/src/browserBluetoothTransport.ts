/**
 * BleTransport for a plain browser tab.
 *
 * Differences from the Electron transport (apps/desktop/src/renderer/ble):
 *  - The browser shows its own device chooser, so the in-app picker is not
 *    used (`usesInAppPicker = false`) and nothing needs to answer it.
 *  - requestDevice() needs a user gesture; on start there is none. Previously
 *    permitted devices are re-acquired with navigator.bluetooth.getDevices()
 *    (+ watchAdvertisements() to wait until the device is actually in range).
 *    Without getDevices() the device stays "remembered, not connected" until
 *    the user clicks Retry, which (being a click) may open the chooser.
 *  - The remembered id is BluetoothDevice.id: opaque but stable per origin.
 */
import type { BlePeripheral, DeviceKind } from '@freilauf/devices';
import type { ScopedLog } from '../../desktop/src/renderer/core/logger';
import type { AppBluetoothTransport } from '../../desktop/src/renderer/main/appStore';
import {
  FILTERS,
  WebBluetoothPeripheral,
} from '../../desktop/src/renderer/ble/webBluetoothTransport';

export const ADVERTISEMENT_TIMEOUT_MS = 15_000;

/** The parts of the Web Bluetooth API this transport uses (getDevices is optional in practice). */
export interface BluetoothLike {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
  getDevices?: () => Promise<BluetoothDevice[]>;
}

export interface BrowserBluetoothTransportOptions {
  /** True while the page has a transient user activation (a click just happened). */
  hasUserActivation?: () => boolean;
  advertisementTimeoutMs?: number;
  log?: (line: string) => void;
  /** Diagnostic log for GATT connect / services / subscriptions. */
  gattLog?: ScopedLog;
}

export class BrowserBluetoothTransport implements AppBluetoothTransport {
  readonly usesInAppPicker = false;
  readonly #bluetooth: BluetoothLike;
  readonly #hasUserActivation: () => boolean;
  readonly #timeoutMs: number;
  readonly #log: (line: string) => void;
  readonly #gattLog: ScopedLog | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(bluetooth: BluetoothLike, options: BrowserBluetoothTransportOptions = {}) {
    this.#bluetooth = bluetooth;
    this.#hasUserActivation =
      options.hasUserActivation ??
      (() =>
        (navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive ??
        false);
    this.#timeoutMs = options.advertisementTimeoutMs ?? ADVERTISEMENT_TIMEOUT_MS;
    this.#log = options.log ?? (() => {});
    this.#gattLog = options.gattLog;
  }

  requestDevice(kind: DeviceKind): Promise<BlePeripheral> {
    // Not queued: the call must happen synchronously inside the click that
    // triggered it, or the browser rejects it for lack of a user gesture.
    return this.#bluetooth
      .requestDevice(FILTERS[kind])
      .then((device) => new WebBluetoothPeripheral(device, device.id, this.#gattLog));
  }

  findKnownDevice(kind: DeviceKind, id: string): Promise<BlePeripheral | null> {
    // Read the activation now: by the time a queued task runs it may be gone.
    const userGesture = this.#hasUserActivation();
    return this.#enqueue(async () => {
      const known = await this.#getPermittedDevice(id);
      if (known) {
        const inRange = await this.#waitForAdvertisement(known);
        if (inRange) return new WebBluetoothPeripheral(known, known.id, this.#gattLog);
        // Waiting used up the click's activation; the chooser would be refused.
        this.#log(`${kind} ${id}: permitted but not advertising`);
        return null;
      }
      // Retry button: a click is a user gesture, so we may show the chooser.
      if (userGesture) {
        try {
          const device = await this.#bluetooth.requestDevice(FILTERS[kind]);
          return new WebBluetoothPeripheral(device, device.id, this.#gattLog);
        } catch (err) {
          if (err instanceof DOMException && err.name === 'NotFoundError') return null;
          throw err;
        }
      }
      return null;
    });
  }

  async #getPermittedDevice(id: string): Promise<BluetoothDevice | null> {
    if (typeof this.#bluetooth.getDevices !== 'function') return null;
    try {
      const devices = await this.#bluetooth.getDevices();
      return devices.find((d) => d.id === id) ?? null;
    } catch (err) {
      this.#log(`getDevices failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Resolves true once the device advertises (it is in range and awake).
   * Where watchAdvertisements() is missing we cannot tell: resolve true and
   * let the GATT connect attempt decide.
   */
  async #waitForAdvertisement(device: BluetoothDevice): Promise<boolean> {
    if (device.gatt?.connected) return true;
    if (typeof device.watchAdvertisements !== 'function') return true;
    const abort = new AbortController();
    let onAdvert: (() => void) | null = null;
    try {
      const seen = new Promise<boolean>((resolve) => {
        onAdvert = () => resolve(true);
        device.addEventListener('advertisementreceived', onAdvert, { once: true });
        setTimeout(() => resolve(false), this.#timeoutMs);
      });
      await device.watchAdvertisements({ signal: abort.signal });
      return await seen;
    } catch (err) {
      this.#log(`watchAdvertisements failed: ${String(err)}`);
      return true;
    } finally {
      abort.abort();
      if (onAdvert) device.removeEventListener('advertisementreceived', onAdvert);
    }
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/** Stands in when Web Bluetooth cannot be used: pairing explains why instead of doing nothing. */
export class UnavailableBluetoothTransport implements AppBluetoothTransport {
  readonly usesInAppPicker = false;
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  requestDevice(): Promise<BlePeripheral> {
    const err = new Error(this.#reason);
    // The reason is already written for the rider; the app shows it as it is.
    err.name = 'BluetoothUnavailableError';
    return Promise.reject(err);
  }

  findKnownDevice(): Promise<BlePeripheral | null> {
    return Promise.resolve(null);
  }
}
