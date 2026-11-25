/**
 * The sensor-relay helper's wire protocol, TypeScript side. The helper
 * (apps/desktop/native/sensor-relay, Rust) reads one JSON command per line on
 * stdin and writes one JSON event per line on stdout; see its protocol.rs and
 * docs/adr/0005-sensor-relay.md. sensorRelayProtocol.test.ts reads protocol.rs
 * and fails when PROTOCOL or the command/event names drift apart.
 *
 * Pure: no Node, no Electron. Events are parsed defensively — the helper is
 * our own program, but its output is still treated as untrusted input.
 */
import type { GattProperty, RelayService, RelayUpdate } from '@freilauf/devices';
import { toRelayHex } from '@freilauf/devices';

/** Must equal `PROTOCOL` in protocol.rs; a helper reporting another one is refused. */
export const SENSOR_RELAY_PROTOCOL = 1;

export const RELAY_COMMAND_TYPES = ['start', 'notify', 'stop', 'quit'] as const;
export const RELAY_EVENT_TYPES = [
  'ready',
  'adapter',
  'unsupported',
  'started',
  'stopped',
  'advertising',
  'subscribers',
  'write',
  'error',
] as const;

export interface WireCharacteristic {
  uuid: string;
  properties: GattProperty[];
  /** Initial value, lowercase hex. */
  value: string;
}

export interface WireService {
  uuid: string;
  characteristics: WireCharacteristic[];
}

export type RelayCommand =
  | { type: 'start'; services: WireService[] }
  | { type: 'notify'; service: string; characteristic: string; value: string }
  | { type: 'stop' }
  | { type: 'quit' };

export type RelayEvent =
  | { type: 'ready'; version: string; protocol: number; backend: string }
  | {
      type: 'adapter';
      lowEnergySupported: boolean;
      peripheralRoleSupported: boolean;
      centralRoleSupported: boolean;
      radioOn: boolean | null;
    }
  | { type: 'unsupported'; reason: string }
  | { type: 'started'; services: string[] }
  | { type: 'stopped' }
  | { type: 'advertising'; service: string; status: string }
  | { type: 'subscribers'; service: string; characteristic: string; centrals: string[] }
  | { type: 'write'; service: string; characteristic: string; value: string; central: string }
  | { type: 'error'; message: string };

/** One command as a line for the helper's stdin (with the newline). */
export function commandLine(command: RelayCommand): string {
  return `${JSON.stringify(command)}\n`;
}

export function startCommand(services: readonly RelayService[]): RelayCommand {
  return {
    type: 'start',
    services: services.map((s) => ({
      uuid: s.uuid,
      characteristics: s.characteristics.map((c) => ({
        uuid: c.uuid,
        properties: [...c.properties],
        value: toRelayHex(c.value),
      })),
    })),
  };
}

export function notifyCommand(update: RelayUpdate): RelayCommand {
  return {
    type: 'notify',
    service: update.service,
    characteristic: update.characteristic,
    value: toRelayHex(update.value),
  };
}

const MAX_TEXT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^(?:[0-9a-f]{2}){0,512}$/;
const CENTRAL = /^[A-Za-z0-9_-]{1,64}$/;

const text = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT;
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * Parses one stdout line into an event, or null for anything malformed or
 * unknown (the caller logs it). UUIDs must be canonical lowercase, as the
 * helper writes them.
 */
export function parseRelayEvent(line: string): RelayEvent | null {
  if (line.length > 64 * 1024) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  switch (e.type) {
    case 'ready':
      return text(e.version) &&
        typeof e.protocol === 'number' &&
        Number.isInteger(e.protocol) &&
        text(e.backend)
        ? { type: 'ready', version: e.version, protocol: e.protocol, backend: e.backend }
        : null;
    case 'adapter':
      return bool(e.lowEnergySupported) &&
        bool(e.peripheralRoleSupported) &&
        bool(e.centralRoleSupported) &&
        (e.radioOn === null || bool(e.radioOn))
        ? {
            type: 'adapter',
            lowEnergySupported: e.lowEnergySupported,
            peripheralRoleSupported: e.peripheralRoleSupported,
            centralRoleSupported: e.centralRoleSupported,
            radioOn: e.radioOn,
          }
        : null;
    case 'unsupported':
      return text(e.reason) ? { type: 'unsupported', reason: e.reason } : null;
    case 'started':
      return Array.isArray(e.services) && e.services.length <= 16 && e.services.every(uuid)
        ? { type: 'started', services: [...e.services] }
        : null;
    case 'stopped':
      return { type: 'stopped' };
    case 'advertising':
      return uuid(e.service) && text(e.status)
        ? { type: 'advertising', service: e.service, status: e.status }
        : null;
    case 'subscribers':
      return uuid(e.service) &&
        uuid(e.characteristic) &&
        Array.isArray(e.centrals) &&
        e.centrals.length <= 64 &&
        e.centrals.every((c) => typeof c === 'string' && CENTRAL.test(c))
        ? {
            type: 'subscribers',
            service: e.service,
            characteristic: e.characteristic,
            centrals: [...e.centrals],
          }
        : null;
    case 'write':
      return uuid(e.service) &&
        uuid(e.characteristic) &&
        typeof e.value === 'string' &&
        HEX.test(e.value) &&
        typeof e.central === 'string' &&
        CENTRAL.test(e.central)
        ? {
            type: 'write',
            service: e.service,
            characteristic: e.characteristic,
            value: e.value,
            central: e.central,
          }
        : null;
    case 'error':
      return typeof e.message === 'string'
        ? { type: 'error', message: e.message.slice(0, MAX_TEXT) }
        : null;
    default:
      return null;
  }
}

/**
 * Splits a byte stream into lines. Keeps an incomplete tail between chunks
 * and drops a runaway line (no newline within `maxLine` characters).
 */
export class LineSplitter {
  #buf = '';
  readonly #maxLine: number;
  #overflowed = false;

  constructor(maxLine = 64 * 1024) {
    this.#maxLine = maxLine;
  }

  /** The complete lines in `chunk` (without newlines, trimmed of a trailing \r). */
  push(chunk: string): string[] {
    this.#buf += chunk;
    const parts = this.#buf.split('\n');
    this.#buf = parts.pop() ?? '';
    const out: string[] = [];
    for (const p of parts) {
      if (this.#overflowed) {
        this.#overflowed = false; // the rest of a dropped line
        continue;
      }
      out.push(p.endsWith('\r') ? p.slice(0, -1) : p);
    }
    if (this.#buf.length > this.#maxLine) {
      this.#buf = '';
      this.#overflowed = true;
    }
    return out.filter((l) => l.length <= this.#maxLine);
  }
}
