/** Small geodesy and hashing helpers. Pure. */

/** Mean Earth radius (m), as used by the haversine formula. */
export const EARTH_RADIUS_M = 6_371_008.8;

const RAD = Math.PI / 180;

/** Great-circle distance in metres (haversine; error well below 0.5 % at any scale). */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Local flat projection around an origin (equirectangular): metres east (x) and north (y).
 * Exactly invertible, so x/y and lat/lon of a track always agree. Distortion grows with the
 * distance from the origin (≈ 2 % scale error 100 km north or south of it at mid latitudes);
 * that only affects drawing, never the route distance (haversine on the original points).
 */
export interface Projection {
  lat0: number;
  lon0: number;
}

export function project(p: Projection, lat: number, lon: number): { x: number; y: number } {
  return {
    x: (lon - p.lon0) * RAD * EARTH_RADIUS_M * Math.cos(p.lat0 * RAD),
    y: (lat - p.lat0) * RAD * EARTH_RADIUS_M,
  };
}

export function unproject(p: Projection, x: number, y: number): { lat: number; lon: number } {
  const cos = Math.max(1e-9, Math.cos(p.lat0 * RAD));
  return {
    lat: p.lat0 + y / (RAD * EARTH_RADIUS_M),
    lon: p.lon0 + x / (RAD * EARTH_RADIUS_M * cos),
  };
}

/** FNV-1a 32-bit over the UTF-16 code units, base 36. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** UTF-8 byte length without TextEncoder (not available without DOM/Node libs). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Name/description cleanup: control characters removed, whitespace collapsed, length capped. */
export function cleanText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...t].slice(0, max).join('');
}
