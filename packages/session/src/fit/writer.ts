/** Growable little-endian byte buffer and FIT base-type value encoding. */

export interface BaseType {
  readonly id: number;
  readonly size: 1 | 2 | 4;
  readonly invalid: number;
  /** Smallest / largest valid raw value (inclusive). */
  readonly min: number;
  readonly max: number;
}

export const ENUM: BaseType = { id: 0x00, size: 1, invalid: 0xff, min: 0, max: 0xfe };
export const UINT8: BaseType = { id: 0x02, size: 1, invalid: 0xff, min: 0, max: 0xfe };
export const UINT16: BaseType = { id: 0x84, size: 2, invalid: 0xffff, min: 0, max: 0xfffe };
export const UINT32: BaseType = { id: 0x86, size: 4, invalid: 0xffffffff, min: 0, max: 0xfffffffe };
export const SINT32: BaseType = {
  id: 0x85,
  size: 4,
  invalid: 0x7fffffff,
  min: -0x7fffffff,
  max: 0x7ffffffe,
};
/** "z" types use 0 as invalid. */
export const UINT32Z: BaseType = { id: 0x8c, size: 4, invalid: 0, min: 1, max: 0xffffffff };

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, v & 0xff);
    this.length += 1;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, v & 0xffff, true);
    this.length += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
  }

  /** Writes a raw (already scaled) integer value of the given base type. */
  raw(type: BaseType, v: number): void {
    if (type.size === 1) this.u8(v);
    else if (type.size === 2) this.u16(v);
    else this.u32(v);
  }

  setU16(offset: number, v: number): void {
    this.view.setUint16(offset, v & 0xffff, true);
  }

  setU32(offset: number, v: number): void {
    this.view.setUint32(offset, v >>> 0, true);
  }

  /** Copy of the written bytes. */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/**
 * Converts a physical value to the raw stored integer: `round(value * scale - offset)`,
 * clamped into the type's valid range. `null`/non-finite → the invalid value.
 */
export function toRaw(type: BaseType, value: number | null | undefined, scale = 1, offset = 0): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return type.invalid;
  const raw = Math.round(value * scale - offset);
  if (!Number.isFinite(raw)) return type.invalid;
  return Math.min(type.max, Math.max(type.min, raw));
}
