/**
 * FIT CRC-16 (identical to CRC-16/ARC: reflected poly 0x8005, init 0),
 * computed with the nibble table from the FIT protocol document.
 */
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
] as const;

function nibble(i: number): number {
  return CRC_TABLE[i & 0x0f] ?? 0;
}

/** Feeds one byte into a running CRC and returns the new CRC. */
export function fitCrcByte(crc: number, byte: number): number {
  let tmp = nibble(crc);
  crc = (crc >> 4) & 0x0fff;
  crc = crc ^ tmp ^ nibble(byte);
  tmp = nibble(crc);
  crc = (crc >> 4) & 0x0fff;
  crc = crc ^ tmp ^ nibble(byte >> 4);
  return crc & 0xffff;
}

/** CRC over `bytes[start, end)`, optionally continuing from `crc`. */
export function fitCrc(bytes: Uint8Array, start = 0, end = bytes.length, crc = 0): number {
  for (let i = start; i < end; i++) crc = fitCrcByte(crc, bytes[i] ?? 0);
  return crc;
}
