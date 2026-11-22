import { describe, expect, it } from 'vitest';
import {
  RIDE_BUTTON_MASK,
  RideButtonTracker,
  isHandshakeResponse,
  parseZwiftRideMessage,
} from './zwiftRide';

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

/** Encodes a keypad status frame the way the protocol notes describe it. */
function keypad(pressedMask: number, paddles: number[] = []): DataView {
  const varint = (n: number) => {
    const out: number[] = [];
    let v = n >>> 0;
    do {
      out.push((v & 0x7f) | (v > 0x7f ? 0x80 : 0));
      v >>>= 7;
    } while (v > 0);
    return out;
  };
  return view(0x23, 0x08, ...varint((0xffffffff & ~pressedMask) >>> 0), ...paddles);
}

describe('parseZwiftRideMessage', () => {
  it('reports no buttons when all bits are set', () => {
    const msg = parseZwiftRideMessage(view(0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f));
    expect(msg).toEqual({ type: 'keypad', pressed: new Set(), paddles: [], bitmap: 0xffffffff });
  });

  it('decodes each button from its cleared bit', () => {
    for (const [button, mask] of Object.entries(RIDE_BUTTON_MASK)) {
      const msg = parseZwiftRideMessage(keypad(mask));
      expect(msg?.type === 'keypad' && [...msg.pressed]).toEqual([button]);
    }
  });

  it('decodes chords', () => {
    const msg = parseZwiftRideMessage(
      keypad(RIDE_BUTTON_MASK.shiftUpRight | RIDE_BUTTON_MASK.a | RIDE_BUTTON_MASK.left),
    );
    expect(msg?.type === 'keypad' && [...msg.pressed].sort()).toEqual(['a', 'left', 'shiftUpRight']);
  });

  it('decodes analog paddles (zigzag value, location defaulting to left)', () => {
    // field 3 { location=1 (right), value=sint32 100 → zigzag 200 }; field 3 { value=-50 → 99 }
    const msg = parseZwiftRideMessage(
      keypad(0, [0x1a, 0x05, 0x08, 0x01, 0x10, 0xc8, 0x01, 0x1a, 0x02, 0x10, 0x63]),
    );
    expect(msg?.type === 'keypad' && msg.paddles).toEqual([
      { side: 'right', value: 1 },
      { side: 'left', value: -0.5 },
    ]);
  });

  it('decodes battery, idle and unknown messages', () => {
    expect(parseZwiftRideMessage(view(0x19, 0x10, 0x55))).toEqual({ type: 'battery', percent: 85 });
    expect(parseZwiftRideMessage(view(0x15))).toEqual({ type: 'idle' });
    expect(parseZwiftRideMessage(view(0x42, 1, 2, 3))).toEqual({ type: 'unknown', messageType: 0x42 });
  });

  it('returns null instead of throwing on malformed input', () => {
    expect(parseZwiftRideMessage(view())).toBeNull();
    expect(parseZwiftRideMessage(view(0x23))).toBeNull(); // no bitmap
    expect(parseZwiftRideMessage(view(0x23, 0x08, 0xff, 0xff))).toBeNull(); // truncated varint
    expect(parseZwiftRideMessage(view(0x23, 0x08, 0x00, 0x1a, 0x09, 0x01))).toBeNull(); // bad length
    expect(parseZwiftRideMessage(view(0x23, 0x0f, 0x00))).toBeNull(); // invalid wire type
  });

  it('respects the DataView offset', () => {
    const bytes = new Uint8Array([0xaa, 0xbb, 0x15]);
    expect(parseZwiftRideMessage(new DataView(bytes.buffer, 2))).toEqual({ type: 'idle' });
  });
});

describe('isHandshakeResponse', () => {
  it('accepts RideOn with trailing bytes', () => {
    expect(isHandshakeResponse(view(0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x01, 0x03))).toBe(true);
    expect(isHandshakeResponse(view(0x52, 0x69, 0x64, 0x65, 0x4f))).toBe(false);
    expect(isHandshakeResponse(view(0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f))).toBe(false);
  });
});

describe('RideButtonTracker', () => {
  it('emits press and release edges only on change', () => {
    const tracker = new RideButtonTracker();
    expect(tracker.update(new Set(['shiftUpRight']))).toEqual([
      { button: 'shiftUpRight', pressed: true },
    ]);
    expect(tracker.update(new Set(['shiftUpRight']))).toEqual([]);
    expect(tracker.update(new Set(['a']))).toEqual([
      { button: 'a', pressed: true },
      { button: 'shiftUpRight', pressed: false },
    ]);
    expect(tracker.reset()).toEqual([{ button: 'a', pressed: false }]);
    expect(tracker.reset()).toEqual([]);
  });
});
