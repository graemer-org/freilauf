/**
 * Always-on protocol capture for the Zwift Ride controllers (the protocol is
 * reverse-engineered; buttons and the lever layout are verified, the meaning
 * of the lever directions is not yet, docs/protocols/zwift-ride.md).
 * Pure: feed it the driver's raw frames; it writes compact log lines.
 *
 * - Keypad frames (0x23): every CHANGE is logged with its hex, the decoded
 *   pressed set, paddles (and any non-zero paddle at a location other than
 *   left/right, "otherPaddles"), the raw bitmap and any cleared bit that is not in
 *   the button table ("unknownBits" — a button we cannot map yet). Identical
 *   consecutive frames are collapsed into a count.
 * - Unknown message types: the first frame of each type in full, then counted
 *   (summary on flush()).
 * - Sync TX frames (handshake answers) are logged in full with an ASCII view.
 * - Battery messages (0x19): logged with their hex when the value (or grip)
 *   changes, so the still unverified layout can be checked. The decoded level
 *   is logged by the device monitor like every device's battery.
 * - raw mode (FREILAUF_BLE_LOG=1): additionally every frame, uncollapsed.
 */
import type { ControllerButton, RawFrame } from '@freilauf/devices';
import {
  RIDE_KNOWN_BUTTON_BITS,
  isHandshakeResponse,
  parseZwiftRideMessage,
} from '@freilauf/devices';
import { RateLimiter, hex } from './logFormat';
import type { ScopedLog } from './logger';

export interface ControllerCaptureOptions {
  log: ScopedLog;
  /** Log every frame as received too (FREILAUF_BLE_LOG=1). */
  raw?: boolean;
  now?: () => number;
}

function ascii(bytes: Uint8Array): string {
  return [...bytes].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
}

function bitList(bits: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 32; i++) {
    if ((bits >>> i) & 1) out.push(`0x${((1 << i) >>> 0).toString(16).padStart(5, '0')}`);
  }
  return out;
}

export class ControllerCapture {
  readonly #log: ScopedLog;
  readonly #raw: boolean;
  readonly #limit: RateLimiter;
  #lastAsync = '';
  #repeat = 0;
  #frames = 0;
  /** Bits seen set at least once: the "idle" pattern, to spot unmapped presses. */
  #seenSet = 0;
  #lastPressed: ControllerButton[] = [];
  /** Last logged battery level per grip ('whole' when the message names none). */
  readonly #battery = new Map<string, number>();
  readonly #unknownTypes = new Map<number, number>();
  readonly #reportedUnknown = new Map<number, number>();
  #unparseable = 0;

  constructor(options: ControllerCaptureOptions) {
    this.#log = options.log;
    this.#raw = options.raw ?? false;
    this.#limit = new RateLimiter(40, 10_000, options.now);
  }

  frame(frame: RawFrame): void {
    try {
      this.#frame(frame);
    } catch (err) {
      this.#log.warn('capture failed on a frame', { error: err, hex: hex(frame.bytes) });
    }
  }

  #frame(frame: RawFrame): void {
    const h = hex(frame.bytes);
    this.#frames++;
    if (this.#raw) this.#log.debug(`raw ${frame.characteristic} ${h}`);

    if (frame.characteristic === 'syncTx') {
      const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
      this.#log.info(
        isHandshakeResponse(view) ? 'handshake answer (RideOn…) on sync TX' : 'sync TX frame',
        { hex: h, ascii: ascii(frame.bytes), length: frame.bytes.length },
      );
      return;
    }

    if (h === this.#lastAsync) {
      this.#repeat++;
      return;
    }
    this.#flushRepeat();
    this.#lastAsync = h;

    const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
    const msg = parseZwiftRideMessage(view);
    if (!msg) {
      this.#unparseable++;
      if (this.#unparseable <= 5 || this.#limit.take('unparseable').allowed) {
        this.#log.warn('unparseable controller frame', {
          hex: h,
          length: frame.bytes.length,
          count: this.#unparseable,
        });
      }
      return;
    }
    switch (msg.type) {
      case 'keypad': {
        this.#seenSet |= msg.bitmap;
        const pressed = [...msg.pressed].sort();
        const unknown = this.#seenSet & ~msg.bitmap & ~RIDE_KNOWN_BUTTON_BITS;
        const down = pressed.filter((b) => !this.#lastPressed.includes(b));
        const up = this.#lastPressed.filter((b) => !pressed.includes(b));
        this.#lastPressed = pressed;
        const decision = this.#limit.take('keypad');
        if (!decision.allowed) return;
        const context: Record<string, unknown> = {
          hex: h,
          bitmap: `0x${msg.bitmap.toString(16)}`,
          pressed,
        };
        if (down.length) context.down = down;
        if (up.length) context.up = up;
        if (unknown) context.unknownBits = bitList(unknown);
        if (msg.paddles.length)
          context.paddles = msg.paddles.map((p) => `${p.side}:${p.value.toFixed(2)}`);
        // Locations 2 and 3 were always 0 so far; anything else is news.
        const others = msg.otherPaddles.filter((p) => p.value !== 0);
        if (others.length)
          context.otherPaddles = others.map((p) => `${p.location}:${p.value.toFixed(2)}`);
        if (decision.suppressed) context.suppressedBefore = decision.suppressed;
        const what = pressed.length ? pressed.join('+') : unknown ? 'unmapped bit(s)' : 'none';
        this.#log.info(`keypad ${h} → pressed ${what}`, context);
        return;
      }
      case 'battery': {
        const side = msg.side ?? 'whole';
        if (this.#battery.get(side) !== msg.percent) {
          this.#battery.set(side, msg.percent);
          this.#log.info(`battery ${msg.side ? `${msg.side} ` : ''}${msg.percent}%`, { hex: h });
        }
        return;
      }
      case 'idle':
        return;
      case 'unknown': {
        const n = (this.#unknownTypes.get(msg.messageType) ?? 0) + 1;
        this.#unknownTypes.set(msg.messageType, n);
        if (n === 1) {
          this.#log.info(
            `unknown message type 0x${msg.messageType.toString(16).padStart(2, '0')} (first occurrence)`,
            {
              hex: h,
              length: frame.bytes.length,
            },
          );
        }
        return;
      }
    }
  }

  #flushRepeat(): void {
    if (this.#repeat > 0) {
      this.#log.debug(`previous frame repeated ${this.#repeat}×`, { hex: this.#lastAsync });
      this.#repeat = 0;
    }
  }

  /** Writes pending counts (repeats, unknown message types). Call periodically and on disconnect. */
  flush(): void {
    this.#flushRepeat();
    const unknown = [...this.#unknownTypes].filter(
      ([t, n]) => n > 1 && n !== this.#reportedUnknown.get(t),
    );
    for (const [t, n] of unknown) this.#reportedUnknown.set(t, n);
    if (unknown.length) {
      this.#log.info('unknown message types seen', {
        counts: Object.fromEntries(
          unknown.map(([t, n]) => [`0x${t.toString(16).padStart(2, '0')}`, n]),
        ),
      });
    }
    for (const { suppressed } of this.#limit.drainSuppressed()) {
      this.#log.info(`${suppressed} frame changes not logged (rate limit)`);
    }
  }

  get frameCount(): number {
    return this.#frames;
  }
}
