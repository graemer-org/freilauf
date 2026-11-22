/**
 * State machine answering Chromium's Bluetooth chooser
 * (`webContents.on('select-bluetooth-device')`). Pure: timers and outputs are
 * injected (unit-tested in bluetoothChooser.test.ts).
 *
 * How Electron drives it: after `navigator.bluetooth.requestDevice()` the
 * event fires every time the scan finds or updates a device, each time with
 * the full device list and a callback that resolves that one request (any of
 * the callbacks of a request works; each must be called at most once). If the
 * scan finds nothing, Electron cancels the request by itself after its
 * retries, so there is no event for us to answer in that case.
 *
 * Rules implemented here:
 * - A request starts with the first event after the previous request ended.
 *   Later events update it (we keep the newest callback).
 * - `prepare(x)` configures the NEXT request (one-shot, then back to
 *   interactive). If a request is still open when `prepare` is called, that
 *   request is cancelled: only one chooser at a time, a new one wins.
 * - auto mode: select `deviceId` as soon as it is in the list; cancel after
 *   `timeoutMs` (measured from the first event of the request).
 * - interactive mode: forward the accumulated, de-duplicated list (named
 *   devices first) to the renderer until `pick` / `cancel`.
 * - Every request's callback is called exactly once (`dispose` cancels).
 */
import type { PickerDevice } from '../shared/contract';

export interface ChooserDevice {
  deviceId: string;
  deviceName: string;
}

export type AutoSelect = { deviceId: string; timeoutMs: number } | null;

export interface ChooserDeps {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Interactive mode: the current list for the renderer's picker. */
  onPickerDevices(devices: PickerDevice[]): void;
  log(msg: string): void;
}

interface ActiveRequest {
  mode: AutoSelect;
  callback: (deviceId: string) => void;
  devices: Map<string, PickerDevice>;
  /** Discovery order, to keep the list stable within the named/unnamed groups. */
  order: string[];
  lastSent: string;
  timer: unknown;
}

const MAX_TIMEOUT_MS = 5 * 60_000;

/** Chromium uses placeholder names like "Unknown or Unsupported Device (AA:BB:…)". */
export function isNamed(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && !/^unknown( or unsupported)? device/i.test(n);
}

export class BluetoothChooser {
  private next: AutoSelect = null;
  private active: ActiveRequest | null = null;

  private readonly deps: ChooserDeps;

  constructor(deps: ChooserDeps) {
    this.deps = deps;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  prepare(autoSelect: AutoSelect): void {
    if (this.active) {
      this.deps.log('chooser: new request prepared while one is open; cancelling the open one');
      this.finish('');
    }
    if (autoSelect) {
      const timeoutMs = Math.min(Math.max(0, autoSelect.timeoutMs), MAX_TIMEOUT_MS);
      this.next = { deviceId: autoSelect.deviceId, timeoutMs };
    } else {
      this.next = null;
    }
  }

  /** Call from the `select-bluetooth-device` handler (after `event.preventDefault()`). */
  handleSelect(devices: readonly ChooserDevice[], callback: (deviceId: string) => void): void {
    if (!this.active) {
      const mode = this.next;
      this.next = null;
      this.active = {
        mode,
        callback,
        devices: new Map(),
        order: [],
        lastSent: '',
        timer: null,
      };
      const req = this.active;
      this.deps.log(
        mode
          ? `chooser: request started, auto-select ${mode.deviceId} within ${mode.timeoutMs} ms`
          : 'chooser: request started, interactive',
      );
      if (mode) {
        req.timer = this.deps.setTimer(() => {
          if (this.active === req) {
            this.deps.log(
              `chooser: ${mode.deviceId} not seen within ${mode.timeoutMs} ms; cancelling`,
            );
            this.finish('');
          }
        }, mode.timeoutMs);
      }
    } else {
      this.active.callback = callback;
    }

    const req = this.active;
    for (const d of devices) {
      if (typeof d.deviceId !== 'string' || d.deviceId === '') continue;
      const name = typeof d.deviceName === 'string' ? d.deviceName : '';
      const prev = req.devices.get(d.deviceId);
      if (!prev) {
        req.devices.set(d.deviceId, { id: d.deviceId, name });
        req.order.push(d.deviceId);
      } else if (isNamed(name) && name !== prev.name) {
        prev.name = name;
      }
    }

    if (req.mode) {
      if (req.devices.has(req.mode.deviceId)) {
        this.deps.log(`chooser: auto-selecting ${req.mode.deviceId}`);
        this.finish(req.mode.deviceId);
      }
      return;
    }
    this.sendList(req);
  }

  pick(deviceId: string): void {
    const req = this.active;
    if (!req) {
      this.deps.log(`chooser: pick(${deviceId}) without an open request; ignored`);
      return;
    }
    if (req.mode) {
      this.deps.log('chooser: pick() during auto-select; ignored');
      return;
    }
    if (!req.devices.has(deviceId)) {
      this.deps.log(`chooser: pick(${deviceId}) of a device not in the list; ignored`);
      return;
    }
    this.finish(deviceId);
  }

  cancel(): void {
    if (this.active) this.finish('');
  }

  dispose(): void {
    this.cancel();
    this.next = null;
  }

  list(): PickerDevice[] {
    return this.active ? sortedList(this.active) : [];
  }

  private sendList(req: ActiveRequest): void {
    const list = sortedList(req);
    const key = JSON.stringify(list);
    if (key === req.lastSent) return;
    req.lastSent = key;
    this.deps.onPickerDevices(list);
  }

  private finish(deviceId: string): void {
    const req = this.active;
    if (!req) return;
    this.active = null;
    if (req.timer !== null) this.deps.clearTimer(req.timer);
    try {
      req.callback(deviceId);
    } catch (e) {
      this.deps.log(`chooser: callback threw: ${String(e)}`);
    }
  }
}

function sortedList(req: ActiveRequest): PickerDevice[] {
  const all = req.order
    .map((id) => req.devices.get(id))
    .filter((d): d is PickerDevice => d !== undefined);
  const named = all.filter((d) => isNamed(d.name));
  const unnamed = all.filter((d) => !isNamed(d.name));
  return [...named, ...unnamed].map((d) => ({ ...d }));
}
