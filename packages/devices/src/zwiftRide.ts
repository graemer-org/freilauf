import type { ControllerButton } from './types';

/**
 * Parser for the handlebar controllers of the Zwift Ride smart frame.
 * Protocol notes, sources and open questions: docs/protocols/zwift-ride.md.
 * Pure functions over bytes; the BLE driver lives in zwiftRideController.ts.
 */

/** Newer controllers expose the 16-bit service, older ones the 128-bit one. */
export const ZWIFT_RIDE_SERVICE = '0000fc82-0000-1000-8000-00805f9b34fb';
export const ZWIFT_LEGACY_SERVICE = '00000001-19ca-4651-86e5-fa29dcdd09d1';
/** Notifications: button state, battery, idle. */
export const ZWIFT_ASYNC_CHARACTERISTIC = '00000002-19ca-4651-86e5-fa29dcdd09d1';
/** App → controller writes. */
export const ZWIFT_SYNC_RX_CHARACTERISTIC = '00000003-19ca-4651-86e5-fa29dcdd09d1';
/** Controller → app responses (indications). */
export const ZWIFT_SYNC_TX_CHARACTERISTIC = '00000004-19ca-4651-86e5-fa29dcdd09d1';

/** ASCII "RideOn": written by the app to start the session, echoed by the controller. */
export const ZWIFT_HANDSHAKE = new Uint8Array([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]);

export const ZwiftMessageType = {
  rideKeypadStatus: 0x23,
  idle: 0x15,
  battery: 0x19,
} as const;

/** Bit positions in the keypad status bitmap. A CLEARED bit means "pressed". */
export const RIDE_BUTTON_MASK: Readonly<Record<ControllerButton, number>> = {
  left: 0x00001,
  up: 0x00002,
  right: 0x00004,
  down: 0x00008,
  a: 0x00010,
  b: 0x00020,
  y: 0x00040,
  z: 0x00100,
  shiftUpLeft: 0x00200,
  shiftDownLeft: 0x00400,
  powerUpLeft: 0x00800,
  onOffLeft: 0x01000,
  shiftUpRight: 0x02000,
  shiftDownRight: 0x04000,
  powerUpRight: 0x10000,
  onOffRight: 0x20000,
};

const ALL_BUTTONS = Object.keys(RIDE_BUTTON_MASK) as ControllerButton[];

/** OR of every known button mask: bits outside it are not (yet) mapped to a button. */
export const RIDE_KNOWN_BUTTON_BITS = ALL_BUTTONS.reduce((acc, b) => acc | RIDE_BUTTON_MASK[b], 0);

export interface RidePaddle {
  side: 'left' | 'right';
  /** −1 … 1 */
  value: number;
}

export type ZwiftRideMessage =
  | {
      type: 'keypad';
      pressed: ReadonlySet<ControllerButton>;
      paddles: RidePaddle[];
      /** The raw button bitmap (low 32 bits), for protocol captures. */
      bitmap: number;
    }
  | { type: 'battery'; percent: number }
  | { type: 'idle' }
  | { type: 'unknown'; messageType: number };

/** True if the bytes start with "RideOn" (the controller may append version bytes). */
export function isHandshakeResponse(data: DataView): boolean {
  if (data.byteLength < ZWIFT_HANDSHAKE.length) return false;
  return ZWIFT_HANDSHAKE.every((byte, i) => data.getUint8(i) === byte);
}

/**
 * Parses one notification from the async characteristic. Never throws:
 * malformed or truncated input yields null, unknown message types are
 * reported as such so they can be logged for protocol work.
 */
export function parseZwiftRideMessage(data: DataView): ZwiftRideMessage | null {
  if (data.byteLength < 1) return null;
  const messageType = data.getUint8(0);
  const body = new Uint8Array(data.buffer, data.byteOffset + 1, data.byteLength - 1);

  switch (messageType) {
    case ZwiftMessageType.rideKeypadStatus: {
      const fields = decodeProtobuf(body);
      if (!fields) return null;
      const bitmap = fields.find((f) => f.field === 1 && f.wire === 0);
      if (!bitmap || bitmap.wire !== 0) return null;
      const bits = Number(bitmap.value & 0xffffffffn);
      const pressed = new Set<ControllerButton>();
      for (const button of ALL_BUTTONS) {
        if ((bits & RIDE_BUTTON_MASK[button]) === 0) pressed.add(button);
      }
      const paddles: RidePaddle[] = [];
      for (const f of fields) {
        if (f.field !== 3 || f.wire !== 2) continue;
        const paddle = parsePaddle(f.bytes);
        if (paddle) paddles.push(paddle);
      }
      return { type: 'keypad', pressed, paddles, bitmap: bits >>> 0 };
    }
    case ZwiftMessageType.battery: {
      const fields = decodeProtobuf(body);
      const level = fields?.find((f) => f.field === 2 && f.wire === 0);
      if (!level || level.wire !== 0) return { type: 'unknown', messageType };
      return { type: 'battery', percent: Math.min(100, Number(level.value)) };
    }
    case ZwiftMessageType.idle:
      return { type: 'idle' };
    default:
      return { type: 'unknown', messageType };
  }
}

/** Turns successive keypad states into press/release edges. */
export class RideButtonTracker {
  #pressed: ReadonlySet<ControllerButton> = new Set();

  update(pressed: ReadonlySet<ControllerButton>): { button: ControllerButton; pressed: boolean }[] {
    const events: { button: ControllerButton; pressed: boolean }[] = [];
    for (const button of pressed) {
      if (!this.#pressed.has(button)) events.push({ button, pressed: true });
    }
    for (const button of this.#pressed) {
      if (!pressed.has(button)) events.push({ button, pressed: false });
    }
    this.#pressed = new Set(pressed);
    return events;
  }

  /** Releases everything, e.g. when the link drops while a button is held. */
  reset(): { button: ControllerButton; pressed: boolean }[] {
    return this.update(new Set());
  }
}

function parsePaddle(bytes: Uint8Array): RidePaddle | null {
  const fields = decodeProtobuf(bytes);
  if (!fields) return null;
  // proto3 omits default values: a missing location means 0 (left), a missing value 0.
  const location = fields.find((f) => f.field === 1 && f.wire === 0);
  const value = fields.find((f) => f.field === 2 && f.wire === 0);
  const loc = location && location.wire === 0 ? Number(location.value) : 0;
  if (loc !== 0 && loc !== 1) return null;
  const raw = value && value.wire === 0 ? zigzag(value.value) : 0;
  return { side: loc === 0 ? 'left' : 'right', value: Math.max(-1, Math.min(1, raw / 100)) };
}

function zigzag(n: bigint): number {
  return Number((n >> 1n) ^ -(n & 1n));
}

type ProtoField =
  | { field: number; wire: 0; value: bigint }
  | { field: number; wire: 2; bytes: Uint8Array };

/** Minimal protobuf wire-format reader (varint and length-delimited; fixed32/64 skipped). */
function decodeProtobuf(bytes: Uint8Array): ProtoField[] | null {
  const fields: ProtoField[] = [];
  let pos = 0;
  const varint = (): bigint | null => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[pos++];
      if (byte === undefined) return null;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
    return null;
  };
  while (pos < bytes.length) {
    const tag = varint();
    if (tag === null) return null;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const value = varint();
      if (value === null) return null;
      fields.push({ field, wire, value });
    } else if (wire === 2) {
      const length = varint();
      if (length === null || pos + Number(length) > bytes.length) return null;
      fields.push({ field, wire, bytes: bytes.subarray(pos, pos + Number(length)) });
      pos += Number(length);
    } else if (wire === 5 || wire === 1) {
      pos += wire === 5 ? 4 : 8;
      if (pos > bytes.length) return null;
    } else {
      return null;
    }
  }
  return fields;
}
