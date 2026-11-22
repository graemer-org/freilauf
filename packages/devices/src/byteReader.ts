/**
 * Little-endian cursor over a DataView. Every read returns `undefined` instead
 * of throwing when the buffer is too short, and a failed read leaves the
 * cursor where it was so callers can stop cleanly at the first truncation.
 */
export class ByteReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(view: DataView) {
    this.view = view;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  private take(n: number): number | undefined {
    if (this.remaining < n) return undefined;
    const at = this.offset;
    this.offset += n;
    return at;
  }

  skip(n: number): boolean {
    return this.take(n) !== undefined;
  }

  uint8(): number | undefined {
    const at = this.take(1);
    return at === undefined ? undefined : this.view.getUint8(at);
  }

  uint16(): number | undefined {
    const at = this.take(2);
    return at === undefined ? undefined : this.view.getUint16(at, true);
  }

  sint16(): number | undefined {
    const at = this.take(2);
    return at === undefined ? undefined : this.view.getInt16(at, true);
  }

  uint24(): number | undefined {
    const at = this.take(3);
    return at === undefined
      ? undefined
      : this.view.getUint16(at, true) | (this.view.getUint8(at + 2) << 16);
  }

  uint32(): number | undefined {
    const at = this.take(4);
    return at === undefined ? undefined : this.view.getUint32(at, true);
  }
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(max, Math.max(min, value));
}
