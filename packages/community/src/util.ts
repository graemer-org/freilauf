/**
 * Small, dependency-free helpers shared by the community modules. Nothing here touches the DOM,
 * Node or the clock; everything is deterministic.
 */

/** UTF-8 byte length of a string (lone surrogates count as 3 bytes, like U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A finite integer in [min, max]. */
export function isIntIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Control characters (C0, DEL, C1), bidi overrides/isolates/marks, zero-width characters and
 * other invisible formatting that could be abused to spoof names in the UI.
 */
const UNSAFE_CHARS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]',
  'g',
);

/**
 * Makes a user-supplied string safe to display and store: removes unsafe/invisible characters,
 * collapses whitespace, trims and cuts to `maxCodePoints` code points (never splitting a
 * surrogate pair). Non-strings become ''.
 */
export function sanitizeText(v: unknown, maxCodePoints: number): string {
  if (typeof v !== 'string') return '';
  // Pre-cut very long input so the regexes below stay cheap.
  const pre = v.length > maxCodePoints * 4 + 64 ? v.slice(0, maxCodePoints * 4 + 64) : v;
  const cleaned = pre
    .replace(UNSAFE_CHARS, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(cleaned);
  return points.length > maxCodePoints ? points.slice(0, maxCodePoints).join('').trim() : cleaned;
}

/** Stable id format for riders and challenges: URL-safe base64 alphabet, 8–32 characters. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{8,32}$/;

export function isId(v: unknown): v is string {
  return typeof v === 'string' && ID_PATTERN.test(v);
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A random id of `length` characters from the URL-safe base64 alphabet (6 bits each). The
 * caller supplies the randomness (`random()` in [0, 1), e.g. backed by `crypto.getRandomValues`),
 * which keeps this module free of platform APIs and the tests deterministic.
 */
export function randomId(random: () => number, length = 16): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const r = random();
    const x = Number.isFinite(r) ? Math.floor(clamp(r, 0, 0.999999999) * 64) : 0;
    out += ID_ALPHABET[x] ?? 'A';
  }
  return out;
}

/** Deterministic pseudo-random generator (mulberry32) — for tests and simulations. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `JSON.parse` that never throws; returns `undefined` on malformed input. */
export function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
