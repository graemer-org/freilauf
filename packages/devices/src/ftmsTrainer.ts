import { CadenceFromCrankRevs, parseCyclingPowerMeasurement } from './cyclingPower';
import { createEmitter } from './emitter';
import type { Unsubscribe } from './emitter';
import {
  encodeRequestControl,
  encodeSetIndoorBikeSimulation,
  encodeSetTargetPower,
  FtmsOpCode,
  parseControlPointResponse,
  parseIndoorBikeData,
} from './ftms';
import type { FtmsResult } from './ftms';
import { DeviceDisconnectedError, ManagedDevice } from './managedDevice';
import type { ManagedDeviceOptions } from './managedDevice';
import type { BlePeripheral, GattConnection, SimulationParams, Trainer, TrainerData } from './types';
import {
  CYCLING_POWER_MEASUREMENT,
  CYCLING_POWER_SERVICE,
  FTMS_CONTROL_POINT,
  FTMS_INDOOR_BIKE_DATA,
  FTMS_SERVICE,
} from './uuids';

export interface FtmsTrainerOptions extends ManagedDeviceOptions {
  /** How long to wait for a control point response. Default 2000 ms. */
  responseTimeoutMs?: number;
  /** Clock for cadence decay. Default Date.now. */
  now?: () => number;
}

/** A control point command was answered with a non-success result. */
export class ControlPointError extends Error {
  readonly result: FtmsResult;
  readonly requestOpCode: number;
  constructor(requestOpCode: number, result: FtmsResult) {
    super(`FTMS control point op 0x${requestOpCode.toString(16).padStart(2, '0')} failed: ${result}`);
    this.name = 'ControlPointError';
    this.requestOpCode = requestOpCode;
    this.result = result;
  }
}

export class ControlPointTimeoutError extends Error {
  readonly requestOpCode: number;
  constructor(requestOpCode: number) {
    super(`FTMS control point op 0x${requestOpCode.toString(16).padStart(2, '0')} timed out`);
    this.name = 'ControlPointTimeoutError';
    this.requestOpCode = requestOpCode;
  }
}

type CommandKey = 'control' | 'sim' | 'power';

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface Command {
  key: CommandKey;
  bytes: Uint8Array;
  /** All callers waiting on this command (several when coalesced). */
  waiters: Waiter[];
}

interface InFlight {
  command: Command;
  opCode: number;
  sentAt: number;
  cancelTimeout: () => void;
  settle: (err?: unknown) => void;
}

const OP_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(FtmsOpCode).map(([name, code]) => [code, name]),
);

function opName(op: number): string {
  return OP_NAMES[op] ?? `op ${hexByte(op)}`;
}

function hexByte(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

function bytesOf(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

type Mode = { kind: 'sim'; params: SimulationParams } | { kind: 'erg'; watts: number };

/**
 * FTMS smart trainer driver.
 *
 * Control point writes are serialized (one in flight; the next is written only
 * after the previous response, timeout or failure). A setSimulation (or
 * setTargetPower) call that arrives while an identical-kind command is the
 * last one queued replaces that command's bytes; every coalesced caller's
 * promise settles with the result of the command that is finally written.
 *
 * Calls made while not connected reject with DeviceDisconnectedError, but the
 * requested mode is remembered and re-applied after the next (re)connect,
 * together with a fresh Request Control.
 */
export class FtmsTrainer extends ManagedDevice<'trainer'> implements Trainer {
  readonly kind = 'trainer' as const;

  private readonly dataEmitter = createEmitter<TrainerData>();
  private readonly responseTimeoutMs: number;
  private readonly now: () => number;
  private readonly crankCadence = new CadenceFromCrankRevs();

  /** Connection usable for control point writes (set during setup, before `connected`). */
  private cpConn: GattConnection | null = null;
  private queue: Command[] = [];
  private inFlight: InFlight | null = null;
  private controlGranted = false;
  private mode: Mode | null = null;
  private hasCps = false;

  constructor(peripheral: BlePeripheral, options: FtmsTrainerOptions = {}) {
    super(peripheral, options);
    this.responseTimeoutMs = options.responseTimeoutMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  onData(listener: (data: TrainerData) => void): Unsubscribe {
    return this.dataEmitter.on(listener);
  }

  setSimulation(params: SimulationParams): Promise<void> {
    this.mode = { kind: 'sim', params: { ...params } };
    return this.command('sim', encodeSetIndoorBikeSimulation(params));
  }

  setTargetPower(watts: number): Promise<void> {
    this.mode = { kind: 'erg', watts };
    return this.command('power', encodeSetTargetPower(watts));
  }

  protected async setup(conn: GattConnection): Promise<void> {
    this.cpConn = conn;
    this.controlGranted = false;
    this.crankCadence.reset();

    await conn.subscribe(FTMS_SERVICE, FTMS_CONTROL_POINT, (v) => this.onControlPoint(v));
    this.diag('debug', 'subscribed', 'FTMS control point indications on');
    await conn.subscribe(FTMS_SERVICE, FTMS_INDOOR_BIKE_DATA, (v) => this.onIndoorBikeData(v));
    this.diag('debug', 'subscribed', 'FTMS indoor bike data notifications on');

    this.hasCps = false;
    try {
      if (await conn.hasService(CYCLING_POWER_SERVICE)) {
        await conn.subscribe(CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT, (v) =>
          this.onCyclingPower(v),
        );
        this.hasCps = true;
        this.diag('debug', 'subscribed', 'cycling power measurement notifications on (cadence fallback)');
      } else {
        this.diag('debug', 'no-cps', 'no cycling power service (cadence only from FTMS)');
      }
    } catch (err) {
      // CPS is only a cadence fallback; ignore.
      this.diag('debug', 'cps-failed', 'cycling power subscription failed (ignored)', { error: err });
    }

    // A refusal here does not fail the connection: data still flows and the
    // next command retries Request Control first.
    await this.ensureControl().catch((err: unknown) => {
      this.diag('warn', 'control-refused', 'Request Control was not granted', { error: err });
    });

    const mode = this.mode;
    if (mode) {
      // Re-apply after (re)connect without delaying the connection.
      const p =
        mode.kind === 'sim'
          ? this.command('sim', encodeSetIndoorBikeSimulation(mode.params))
          : this.command('power', encodeSetTargetPower(mode.watts));
      p.catch(() => {});
    }
  }

  protected override onLinkDown(): void {
    this.cpConn = null;
    this.controlGranted = false;
    const err = new DeviceDisconnectedError('link lost');
    const pending = this.queue;
    this.queue = [];
    this.inFlight?.settle(err);
    this.inFlight = null;
    for (const c of pending) for (const w of c.waiters) w.reject(err);
  }

  // ───────────── notifications ─────────────

  private onIndoorBikeData(view: DataView): void {
    const d = parseIndoorBikeData(view);
    if (!d) return;
    // A packet with the More Data bit set carries no speed; trainers that split
    // data across packets (e.g. power only in the second) emit what they have.
    const out: TrainerData = {};
    if (d.powerW !== undefined) out.powerW = d.powerW;
    if (d.speedKph !== undefined) out.speedKph = d.speedKph;
    if (d.cadenceRpm !== undefined) out.cadenceRpm = d.cadenceRpm;
    else if (this.hasCps) {
      const c = this.crankCadence.current(this.now());
      if (c !== undefined) out.cadenceRpm = c;
    }
    if (Object.keys(out).length > 0) this.dataEmitter.emit(out);
  }

  private onCyclingPower(view: DataView): void {
    const m = parseCyclingPowerMeasurement(view);
    if (m?.crank) this.crankCadence.update(m.crank, this.now());
  }

  private onControlPoint(view: DataView): void {
    const r = parseControlPointResponse(view);
    const f = this.inFlight;
    if (!r || !f || r.requestOpCode !== f.opCode) {
      this.diag('debug', 'cp-unexpected', 'unexpected control point indication', {
        bytes: bytesOf(view),
        expectedOp: f ? opName(f.opCode) : null,
      });
      return;
    }
    this.diag(r.result === 'success' ? 'debug' : 'warn', 'cp-response', `${opName(r.requestOpCode)} → ${r.result}`, {
      op: hexByte(r.requestOpCode),
      result: r.result,
      ms: Date.now() - f.sentAt,
    });
    if (r.result === 'success') f.settle();
    else f.settle(new ControlPointError(r.requestOpCode, r.result));
  }

  // ───────────── control point queue ─────────────

  private ensureControl(): Promise<void> {
    if (this.controlGranted) return Promise.resolve();
    const queued = this.queue.find((c) => c.key === 'control');
    if (queued || this.inFlight?.command.key === 'control') {
      return new Promise((resolve, reject) => {
        (queued ?? this.inFlight!.command).waiters.push({ resolve, reject });
      });
    }
    return this.enqueue('control', encodeRequestControl(), false);
  }

  private command(key: 'sim' | 'power', bytes: Uint8Array): Promise<void> {
    if (!this.cpConn) return Promise.reject(new DeviceDisconnectedError('trainer not connected'));
    if (!this.controlGranted) this.ensureControl().catch(() => {});
    return this.enqueue(key, bytes, true);
  }

  private enqueue(key: CommandKey, bytes: Uint8Array, coalesce: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const last = this.queue.at(-1);
      if (coalesce && last && last.key === key) {
        last.bytes = bytes;
        last.waiters.push({ resolve, reject });
      } else {
        this.queue.push({ key, bytes, waiters: [{ resolve, reject }] });
      }
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight) return;
    const conn = this.cpConn;
    const command = this.queue.shift();
    if (!command) return;
    if (!conn) {
      const err = new DeviceDisconnectedError('trainer not connected');
      for (const w of command.waiters) w.reject(err);
      this.pump();
      return;
    }
    const opCode = command.bytes[0] ?? FtmsOpCode.RequestControl;
    let done = false;
    const flight: InFlight = {
      command,
      opCode,
      sentAt: Date.now(),
      cancelTimeout: () => {},
      settle: (err?: unknown) => {
        if (done) return;
        done = true;
        flight.cancelTimeout();
        if (this.inFlight === flight) this.inFlight = null;
        if (err === undefined && command.key === 'control') this.controlGranted = true;
        for (const w of command.waiters) {
          if (err === undefined) w.resolve();
          else w.reject(err);
        }
        this.pump();
      },
    };
    this.inFlight = flight;
    flight.cancelTimeout = this.schedule(() => {
      this.diag('warn', 'cp-timeout', `${opName(opCode)}: no response within ${this.responseTimeoutMs} ms`, {
        op: hexByte(opCode),
      });
      flight.settle(new ControlPointTimeoutError(opCode));
    }, this.responseTimeoutMs);
    this.diag('debug', 'cp-request', `${opName(opCode)} sent`, {
      op: hexByte(opCode),
      bytes: command.bytes,
      coalesced: command.waiters.length,
    });
    conn.write(FTMS_SERVICE, FTMS_CONTROL_POINT, command.bytes).catch((err: unknown) => {
      this.diag('warn', 'cp-write-failed', `${opName(opCode)}: write failed`, { error: err });
      flight.settle(err);
    });
  }
}
