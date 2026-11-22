import { describe, expect, it } from 'vitest';
import { RIDE_BUTTON_MASK, ZWIFT_HANDSHAKE } from '@freilauf/devices';
import type { LogContext } from '../../shared/contract';
import { ControllerCapture } from './controllerCapture';
import type { ScopedLog } from './logger';

function recorder() {
  const lines: { level: string; message: string; context?: LogContext }[] = [];
  const log: ScopedLog = {
    debug: (message, context) => lines.push({ level: 'debug', message, context }),
    info: (message, context) => lines.push({ level: 'info', message, context }),
    warn: (message, context) => lines.push({ level: 'warn', message, context }),
    error: (message, context) => lines.push({ level: 'error', message, context }),
  };
  return { lines, log };
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    out.push((v & 0x7f) | (v > 0x7f ? 0x80 : 0));
    v >>>= 7;
  } while (v > 0);
  return out;
}

/** Keypad frame with the given bits cleared (= pressed). */
function keypad(clearedBits: number): { characteristic: 'async'; bytes: Uint8Array } {
  return {
    characteristic: 'async',
    bytes: new Uint8Array([0x23, 0x08, ...varint((0xffffffff & ~clearedBits) >>> 0)]),
  };
}

describe('ControllerCapture', () => {
  it('logs keypad changes with decoded buttons and collapses repeats', () => {
    const { lines, log } = recorder();
    const c = new ControllerCapture({ log, now: () => 0 });
    c.frame(keypad(0)); // idle
    c.frame(keypad(0));
    c.frame(keypad(0));
    c.frame(keypad(RIDE_BUTTON_MASK.shiftUpRight));
    c.frame(keypad(0));
    expect(lines.map((l) => l.message)).toEqual([
      'keypad 23 08 ff ff ff ff 0f → pressed none',
      'previous frame repeated 2×',
      'keypad 23 08 ff bf ff ff 0f → pressed shiftUpRight',
      'keypad 23 08 ff ff ff ff 0f → pressed none',
    ]);
    expect(lines[2]!.context).toMatchObject({
      pressed: ['shiftUpRight'],
      down: ['shiftUpRight'],
      bitmap: '0xffffdfff',
    });
    expect(lines[3]!.context).toMatchObject({ pressed: [], up: ['shiftUpRight'] });
  });

  it('points out cleared bits that are not in the button table', () => {
    const { lines, log } = recorder();
    const c = new ControllerCapture({ log, now: () => 0 });
    c.frame(keypad(0));
    c.frame(keypad(0x00080)); // bit 7 is not mapped to any button
    expect(lines[1]!.message).toBe('keypad 23 08 ff fe ff ff 0f → pressed unmapped bit(s)');
    expect(lines[1]!.context).toMatchObject({ unknownBits: ['0x00080'] });
  });

  it('logs the first frame of an unknown type in full, then counts', () => {
    const { lines, log } = recorder();
    const c = new ControllerCapture({ log, now: () => 0 });
    c.frame({ characteristic: 'async', bytes: new Uint8Array([0x2a, 0x01]) });
    c.frame({ characteristic: 'async', bytes: new Uint8Array([0x2a, 0x02]) });
    c.frame({ characteristic: 'async', bytes: new Uint8Array([0x2a, 0x03]) });
    c.flush();
    c.flush(); // nothing new: no second summary
    expect(lines.map((l) => l.message)).toEqual([
      'unknown message type 0x2a (first occurrence)',
      'unknown message types seen',
    ]);
    expect(lines[0]!.context).toMatchObject({ hex: '2a 01' });
    expect(lines[1]!.context).toEqual({ counts: { '0x2a': 3 } });
  });

  it('logs handshake answers, battery changes and, in raw mode, every frame', () => {
    const { lines, log } = recorder();
    const c = new ControllerCapture({ log, raw: true, now: () => 0 });
    c.frame({ characteristic: 'syncTx', bytes: new Uint8Array([...ZWIFT_HANDSHAKE, 0x01, 0x02]) });
    c.frame({ characteristic: 'async', bytes: new Uint8Array([0x19, 0x10, 0x50]) });
    c.frame({ characteristic: 'async', bytes: new Uint8Array([0x19, 0x10, 0x50]) });
    c.battery(80); // same value via the driver event: not repeated
    const messages = lines.map((l) => l.message);
    expect(messages).toContain('handshake answer (RideOn…) on sync TX');
    expect(lines.find((l) => l.message.startsWith('handshake'))!.context).toMatchObject({
      ascii: 'RideOn..',
    });
    expect(messages.filter((m) => m === 'battery 80%')).toHaveLength(1);
    expect(messages.filter((m) => m.startsWith('raw async'))).toHaveLength(2);
  });
});
