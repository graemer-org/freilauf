import { createEmitter } from '../emitter';
import type { Unsubscribe } from '../emitter';
import type { Schedule } from '../managedDevice';
import type { BlePeripheral, GattConnection, Uuid } from '../types';

// In-memory GATT fakes for tests (this package's and other packages').

/** Parses "02 44 a0-0f" style hex (whitespace, '-' and ':' ignored). */
export function hex(text: string): Uint8Array {
  const clean = text.replace(/[\s:-]/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error(`bad hex: ${text}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array | DataView): string {
  const u8 =
    bytes instanceof DataView
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes;
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** DataView over a copy of the given bytes or hex string. */
export function dataView(bytes: Uint8Array | string): DataView {
  const u8 = typeof bytes === 'string' ? hex(bytes) : bytes.slice();
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

export interface FakeWrite {
  service: Uuid;
  characteristic: Uuid;
  data: Uint8Array;
  withoutResponse: boolean;
  connection: FakeGattConnection;
}

/**
 * Called for every write. Return bytes (or hex) to have them delivered as a
 * notification/indication on `respondOn` (default: the written characteristic)
 * after the write resolves; return undefined for no response; throw to make
 * the write reject.
 */
export type WriteResponder = (write: FakeWrite) => Uint8Array | string | undefined | void;

const key = (service: Uuid, characteristic: Uuid) => `${service}|${characteristic}`;

/** An error shaped like the DOMException Web Bluetooth rejects with. */
export function fakeDomError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** Chromium's rejection of a GATT operation while another one is running. */
export const gattBusyError = (): Error =>
  fakeDomError('NetworkError', 'GATT operation already in progress.');

/** Chromium's rejection of a GATT operation after the link went away. */
export const gattDisconnectedError = (): Error =>
  fakeDomError(
    'NetworkError',
    'GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.',
  );

/** How writes on one characteristic behave (see FakePeripheral.setWriteBehavior). */
export interface FakeWriteBehavior {
  /** Resolve the write this long after it was made. Default: at once. */
  resolveAfterMs?: number;
  /**
   * Deliver the scripted response this long after the write was made,
   * independently of when the write resolves; 0 delivers it before the write
   * resolves, as Windows sometimes does. Default: right after the write resolves.
   */
  respondAfterMs?: number;
  /** Scheduler for the delays, usually a FakeScheduler's (required for them). */
  schedule?: Schedule;
  /** Reject a write while another write on the characteristic is still pending, like Chromium. */
  rejectWhileBusy?: boolean;
}

export class FakeGattConnection implements GattConnection {
  connected = true;
  /** Writes made on this connection. */
  readonly writes: FakeWrite[] = [];
  private readonly peripheral: FakePeripheral;
  private readonly listeners = new Map<string, Set<(data: DataView) => void>>();
  private readonly disconnectEmitter = createEmitter<void>();
  private readonly pendingWrites = new Map<string, number>();
  /** Drop the link at the first GATT operation (see FakePeripheral.dropNextLinksDuringSetup). */
  dropOnFirstOperation: { notify: boolean } | null = null;

  constructor(peripheral: FakePeripheral) {
    this.peripheral = peripheral;
  }

  async hasService(service: Uuid): Promise<boolean> {
    this.assertConnected();
    this.maybeDropDuringSetup();
    return this.peripheral.services.has(service);
  }

  async read(service: Uuid, characteristic: Uuid): Promise<DataView> {
    this.assertConnected();
    this.maybeDropDuringSetup();
    const v = this.peripheral.values.get(key(service, characteristic));
    if (!v) throw new Error(`fake: no readable value for ${characteristic}`);
    return dataView(v);
  }

  async write(
    service: Uuid,
    characteristic: Uuid,
    data: Uint8Array,
    options?: { withoutResponse?: boolean },
  ): Promise<void> {
    this.assertConnected();
    this.maybeDropDuringSetup();
    const k = key(service, characteristic);
    const behavior = this.peripheral.writeBehaviors.get(k) ?? {};
    if (behavior.rejectWhileBusy && (this.pendingWrites.get(k) ?? 0) > 0) {
      this.peripheral.rejectedWrites.push({ service, characteristic, data: data.slice() });
      throw gattBusyError();
    }
    const w: FakeWrite = {
      service,
      characteristic,
      data: data.slice(),
      withoutResponse: options?.withoutResponse ?? false,
      connection: this,
    };
    const injected = this.peripheral.writeFailures.get(k)?.shift();
    if (injected) {
      this.peripheral.rejectedWrites.push({ service, characteristic, data: data.slice() });
      throw injected;
    }
    this.writes.push(w);
    this.peripheral.writes.push(w);
    const r = this.peripheral.responders.get(k);
    const response = r ? r.fn(w) : undefined;
    const target = r?.respondOn ?? characteristic;
    const deliver = () => {
      if (response === undefined || response === null || !this.connected) return;
      this.notify(service, target, response);
    };
    const respondAfter = behavior.respondAfterMs;
    if (respondAfter !== undefined) {
      if (respondAfter <= 0 || !behavior.schedule) deliver();
      else behavior.schedule(deliver, respondAfter);
    }

    const delay = behavior.resolveAfterMs ?? 0;
    if (delay > 0 && behavior.schedule) {
      this.pendingWrites.set(k, (this.pendingWrites.get(k) ?? 0) + 1);
      await new Promise<void>((resolve) => behavior.schedule!(resolve, delay));
      this.pendingWrites.set(k, (this.pendingWrites.get(k) ?? 1) - 1);
      if (!this.connected) throw gattDisconnectedError();
    }
    if (respondAfter === undefined) {
      // Deliver after the write has resolved, like a real indication.
      void Promise.resolve().then(deliver);
    }
  }

  async subscribe(
    service: Uuid,
    characteristic: Uuid,
    listener: (data: DataView) => void,
  ): Promise<Unsubscribe> {
    this.assertConnected();
    this.maybeDropDuringSetup();
    if (!this.peripheral.services.has(service)) throw new Error(`fake: no service ${service}`);
    const failure = this.peripheral.subscribeFailures.get(key(service, characteristic));
    if (failure) throw failure;
    const k = key(service, characteristic);
    let set = this.listeners.get(k);
    if (!set) this.listeners.set(k, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  isSubscribed(service: Uuid, characteristic: Uuid): boolean {
    return (this.listeners.get(key(service, characteristic))?.size ?? 0) > 0;
  }

  /** Delivers a notification to this connection's subscribers. */
  notify(service: Uuid, characteristic: Uuid, data: Uint8Array | string): void {
    if (!this.connected) return;
    for (const l of [...(this.listeners.get(key(service, characteristic)) ?? [])])
      l(dataView(data));
  }

  async disconnect(): Promise<void> {
    this.close();
  }

  onDisconnect(listener: () => void): Unsubscribe {
    return this.disconnectEmitter.on(listener);
  }

  /** Simulates link loss (fires onDisconnect once). */
  drop(): void {
    this.close();
  }

  private close(): void {
    if (!this.connected) return;
    this.connected = false;
    this.listeners.clear();
    this.disconnectEmitter.emit();
    this.disconnectEmitter.clear();
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('fake: not connected');
  }

  /** Windows dropping a fresh link while services are being discovered. */
  private maybeDropDuringSetup(): void {
    const drop = this.dropOnFirstOperation;
    if (!drop) return;
    this.dropOnFirstOperation = null;
    if (drop.notify) this.close();
    else {
      // The disconnect event was missed (fired before anyone listened).
      this.connected = false;
      this.listeners.clear();
      this.disconnectEmitter.clear();
    }
    throw gattDisconnectedError();
  }
}

export interface FakePeripheralOptions {
  id?: string;
  name?: string;
  services?: Uuid[];
}

export class FakePeripheral implements BlePeripheral {
  readonly id: string;
  readonly name: string;
  readonly services: Set<Uuid>;
  /** Every connection ever returned, oldest first. */
  readonly connections: FakeGattConnection[] = [];
  /** Writes across all connections, oldest first. */
  readonly writes: FakeWrite[] = [];
  connectAttempts = 0;
  /** @internal */ readonly values = new Map<string, Uint8Array>();
  /** @internal */ readonly responders = new Map<
    string,
    { fn: WriteResponder; respondOn?: Uuid }
  >();
  /** @internal */ readonly subscribeFailures = new Map<string, Error>();
  /** @internal */ readonly writeBehaviors = new Map<string, FakeWriteBehavior>();
  /** @internal */ readonly writeFailures = new Map<string, Error[]>();
  /** Writes that were rejected (busy or injected failures), oldest first. */
  readonly rejectedWrites: Array<{ service: Uuid; characteristic: Uuid; data: Uint8Array }> = [];
  private readonly connectFailures: Error[] = [];
  private setupDrops: Array<{ notify: boolean }> = [];
  private failAll: Error | null = null;

  constructor(options: FakePeripheralOptions = {}) {
    this.id = options.id ?? 'fake-1';
    this.name = options.name ?? 'Fake Device';
    this.services = new Set(options.services ?? []);
  }

  async connect(): Promise<GattConnection> {
    this.connectAttempts++;
    const failure = this.connectFailures.shift() ?? this.failAll;
    if (failure) throw failure;
    const c = new FakeGattConnection(this);
    c.dropOnFirstOperation = this.setupDrops.shift() ?? null;
    this.connections.push(c);
    return c;
  }

  /** The most recent connection if it is still up. */
  get current(): FakeGattConnection | null {
    const c = this.connections.at(-1);
    return c?.connected ? c : null;
  }

  /** Makes the next `count` connect() calls reject. */
  failNextConnects(count = 1, error = new Error('fake: connect failed')): void {
    for (let i = 0; i < count; i++) this.connectFailures.push(error);
  }

  /** Makes every connect() reject until called with null. */
  failConnects(error: Error | null = new Error('fake: connect failed')): void {
    this.failAll = error;
  }

  /**
   * The next `count` links open, then drop at their first GATT operation,
   * which rejects with Chromium's "GATT Server is disconnected" NetworkError.
   * With `notify: false` the connection's onDisconnect does not fire (the
   * event came before anyone listened).
   */
  dropNextLinksDuringSetup(count = 1, options: { notify?: boolean } = {}): void {
    for (let i = 0; i < count; i++) this.setupDrops.push({ notify: options.notify ?? true });
  }

  /** Scripts the timing of writes on a characteristic (persists across reconnects). */
  setWriteBehavior(service: Uuid, characteristic: Uuid, behavior: FakeWriteBehavior): void {
    this.writeBehaviors.set(key(service, characteristic), behavior);
  }

  /** Makes the next `count` writes on a characteristic reject with `error` (not recorded in `writes`). */
  failNextWrites(
    service: Uuid,
    characteristic: Uuid,
    count = 1,
    error: Error = gattBusyError(),
  ): void {
    const k = key(service, characteristic);
    const list = this.writeFailures.get(k) ?? [];
    for (let i = 0; i < count; i++) list.push(error);
    this.writeFailures.set(k, list);
  }

  failSubscribe(
    service: Uuid,
    characteristic: Uuid,
    error = new Error('fake: subscribe failed'),
  ): void {
    this.subscribeFailures.set(key(service, characteristic), error);
  }

  setValue(service: Uuid, characteristic: Uuid, bytes: Uint8Array | string): void {
    this.values.set(key(service, characteristic), typeof bytes === 'string' ? hex(bytes) : bytes);
  }

  /** Scripts responses to writes on a characteristic (persists across reconnects). */
  respondToWrites(
    service: Uuid,
    characteristic: Uuid,
    fn: WriteResponder,
    options: { respondOn?: Uuid } = {},
  ): void {
    this.responders.set(
      key(service, characteristic),
      options.respondOn ? { fn, respondOn: options.respondOn } : { fn },
    );
  }

  /** Pushes a notification on the current connection (no-op if none). */
  notify(service: Uuid, characteristic: Uuid, data: Uint8Array | string): void {
    this.current?.notify(service, characteristic, data);
  }

  /** Drops the current link, as if the device went out of range. */
  dropLink(): void {
    this.current?.drop();
  }

  writesTo(characteristic: Uuid): FakeWrite[] {
    return this.writes.filter((w) => w.characteristic === characteristic);
  }
}

/**
 * Deterministic `Schedule` for tests. `advance(ms)` runs due timers in order
 * and lets pending promise callbacks settle between them.
 */
export class FakeScheduler {
  private nowMs = 0;
  private seq = 0;
  private timers: Array<{ at: number; seq: number; fn: () => void }> = [];

  readonly schedule: Schedule = (fn, ms) => {
    const t = { at: this.nowMs + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.push(t);
    return () => {
      this.timers = this.timers.filter((x) => x !== t);
    };
  };

  readonly now = (): number => this.nowMs;

  /** Delays of the currently pending timers, relative to now. */
  get pendingDelays(): number[] {
    return this.timers.map((t) => t.at - this.nowMs);
  }

  async advance(ms: number): Promise<void> {
    const end = this.nowMs + ms;
    await flushPromises();
    for (;;) {
      const next = this.timers
        .filter((t) => t.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.nowMs = next.at;
      next.fn();
      await flushPromises();
    }
    this.nowMs = end;
    await flushPromises();
  }
}

/** Lets all queued promise callbacks run (uses one macrotask turn). */
export function flushPromises(): Promise<void> {
  const g = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown };
  return new Promise((resolve) => g.setTimeout(resolve, 0));
}
