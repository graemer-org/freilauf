/**
 * GPX 1.0 / 1.1 import and export. Reads `<trk>/<trkseg>/<trkpt>` (falling back to
 * `<rte>/<rtept>`) with `<ele>`; everything else (waypoints, time, extensions, unknown
 * elements, namespaces) is ignored. Strict against what could hurt (DOCTYPE/entities, size,
 * point count, bad coordinates), tolerant of everything else. Never throws.
 */
import { cleanText, haversineM } from './geo';
import type { RouteTrack } from './types';
import type { XmlElement } from './xml';
import { parseXml } from './xml';

/** Input larger than this (UTF-8 bytes) is refused before parsing. */
export const MAX_GPX_BYTES = 20 * 1024 * 1024;
/** More track points than this are refused (a 20 MB file holds ~150 000 typical points). */
export const MAX_GPX_POINTS = 500_000;
export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 500;
/** Elevations outside this band (m) are treated as missing. */
const MIN_ELEVATION_M = -500;
const MAX_ELEVATION_M = 9_000;

export interface RawPoint {
  lat: number;
  lon: number;
  /** Metres; interpolated where the file had none, 0 if it had none at all. */
  ele: number;
}

/** What a GPX file contains, before any cleaning or resampling. */
export interface RawTrack {
  name: string;
  description?: string;
  points: RawPoint[];
  /** False when no point had an elevation (the route will be flat). */
  hasElevation: boolean;
}

export type GpxParseResult =
  { ok: true; track: RawTrack; warnings: string[] } | { ok: false; errors: string[] };

const NUMBER = /^[ \t\r\n]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\r\n]*$/;

const local = (name: string): string => name.slice(name.lastIndexOf(':') + 1);
const childrenNamed = (el: XmlElement, name: string): XmlElement[] =>
  el.children.filter((c) => local(c.name) === name);
const childText = (el: XmlElement | undefined, name: string): string | undefined => {
  const c = el ? childrenNamed(el, name)[0] : undefined;
  return c ? c.text : undefined;
};

/** Parses GPX text. Never throws. */
export function parseGpx(text: string): GpxParseResult {
  try {
    return parse(text);
  } catch {
    return { ok: false, errors: ['The file could not be read as GPX.'] };
  }
}

function parse(text: string): GpxParseResult {
  if (typeof text !== 'string') return { ok: false, errors: ['Input is not text'] };
  // Cheap check first: every UTF-16 unit is at least one byte.
  if (text.length > MAX_GPX_BYTES) return tooLarge();
  if (text.length > MAX_GPX_BYTES / 3) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 2 : 3;
    }
    if (bytes > MAX_GPX_BYTES) return tooLarge();
  }
  const xml = parseXml(text, {
    maxDepth: 32,
    // Points carry a few children each (ele, time, extensions); the point cap is checked below.
    maxElements: 4_000_000,
    maxAttributes: 64,
  });
  if (!xml.ok) return { ok: false, errors: [xml.error] };
  const root = xml.root;
  if (local(root.name) !== 'gpx') {
    return { ok: false, errors: [`Not a GPX file (root element <${root.name}>)`] };
  }
  const warnings: string[] = [];
  const version = root.attrs.get('version');
  if (version !== undefined && version !== '1.0' && version !== '1.1') {
    warnings.push(`Unknown GPX version ${version.slice(0, 10)}; read as GPX 1.1.`);
  }

  // Track points first; routes (planned, often sparse) only when there is no track.
  let source = 'track';
  let groups: XmlElement[][] = [];
  for (const trk of childrenNamed(root, 'trk')) {
    for (const seg of childrenNamed(trk, 'trkseg')) {
      const pts = childrenNamed(seg, 'trkpt');
      if (pts.length > 0) groups.push(pts);
    }
  }
  if (groups.length === 0) {
    source = 'route';
    for (const rte of childrenNamed(root, 'rte')) {
      const pts = childrenNamed(rte, 'rtept');
      if (pts.length > 0) groups.push(pts);
    }
    if (groups.length > 0) warnings.push('The file has no track; its route points were used.');
  }
  if (groups.length === 0) {
    return { ok: false, errors: ['The file contains no track or route points.'] };
  }
  if (groups.length > 1) {
    warnings.push(
      `The file has ${groups.length} ${source === 'track' ? 'track segments' : 'routes'}; they were joined in order.`,
    );
  }
  const total = groups.reduce((n, g) => n + g.length, 0);
  if (total > MAX_GPX_POINTS) {
    return {
      ok: false,
      errors: [`The file has ${total} points; at most ${MAX_GPX_POINTS} are supported.`],
    };
  }

  const points: { lat: number; lon: number; ele: number | null }[] = [];
  let badEle = 0;
  for (const el of groups.flat()) {
    const lat = coord(el.attrs.get('lat'));
    const lon = coord(el.attrs.get('lon'));
    const n = points.length + 1;
    if (lat === null || lon === null) {
      return { ok: false, errors: [`Point ${n} has a missing or invalid lat/lon.`] };
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { ok: false, errors: [`Point ${n} has coordinates out of range.`] };
    }
    const eleText = childText(el, 'ele');
    let ele: number | null = null;
    if (eleText !== undefined && eleText.trim() !== '') {
      const v = NUMBER.test(eleText) ? Number(eleText) : NaN;
      if (Number.isFinite(v) && v >= MIN_ELEVATION_M && v <= MAX_ELEVATION_M) ele = v;
      else badEle++;
    }
    points.push({ lat, lon, ele });
  }
  groups = [];

  let distinct = 1;
  for (let i = 1; i < points.length && distinct < 2; i++) {
    const a = points[0]!;
    const b = points[i]!;
    if (haversineM(a.lat, a.lon, b.lat, b.lon) >= 1) distinct++;
  }
  if (distinct < 2) {
    return { ok: false, errors: ['The file needs at least two distinct points.'] };
  }

  if (badEle > 0) warnings.push(`${badEle} points had an unreadable elevation; it was ignored.`);
  const withEle = points.filter((p) => p.ele !== null).length;
  const hasElevation = withEle > 0;
  if (!hasElevation) {
    warnings.push('This file has no elevation; the route will be flat.');
  } else if (withEle < points.length) {
    warnings.push(
      `${points.length - withEle} of ${points.length} points had no elevation; it was interpolated.`,
    );
  }

  const meta = childrenNamed(root, 'metadata')[0];
  const firstTrack = childrenNamed(root, source === 'track' ? 'trk' : 'rte')[0];
  const rawName =
    childText(meta, 'name') ?? childText(root, 'name') ?? childText(firstTrack, 'name') ?? '';
  const rawDesc =
    childText(meta, 'desc') ?? childText(root, 'desc') ?? childText(firstTrack, 'desc') ?? '';
  const name = cleanText(rawName, MAX_NAME_LENGTH) || 'Imported route';
  const description = cleanText(rawDesc, MAX_DESCRIPTION_LENGTH);

  return {
    ok: true,
    track: {
      name,
      ...(description ? { description } : {}),
      points: fillElevation(points),
      hasElevation,
    },
    warnings,
  };
}

function tooLarge(): GpxParseResult {
  return { ok: false, errors: [`The file is larger than ${MAX_GPX_BYTES / 1024 / 1024} MB.`] };
}

function coord(raw: string | undefined): number | null {
  if (raw === undefined || !NUMBER.test(raw)) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** Missing elevations: linear in distance between known neighbours, held flat at the ends. */
function fillElevation(points: { lat: number; lon: number; ele: number | null }[]): RawPoint[] {
  const known = points.findIndex((p) => p.ele !== null);
  if (known === -1) return points.map((p) => ({ lat: p.lat, lon: p.lon, ele: 0 }));
  const dist: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    dist.push(dist[i - 1]! + haversineM(a.lat, a.lon, b.lat, b.lon));
  }
  const out: RawPoint[] = [];
  let prev = -1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.ele !== null) {
      out.push({ lat: p.lat, lon: p.lon, ele: p.ele });
      prev = i;
      continue;
    }
    let next = i + 1;
    while (next < points.length && points[next]!.ele === null) next++;
    let ele: number;
    if (prev === -1) ele = points[next]!.ele!;
    else if (next >= points.length) ele = points[prev]!.ele!;
    else {
      const e0 = points[prev]!.ele!;
      const e1 = points[next]!.ele!;
      const span = dist[next]! - dist[prev]!;
      ele = span > 0 ? e0 + ((e1 - e0) * (dist[i]! - dist[prev]!)) / span : e0;
    }
    out.push({ lat: p.lat, lon: p.lon, ele });
  }
  return out;
}

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * GPX 1.1 of a prepared route: one track with one segment, one point per sample (the
 * resampled, smoothed route, not the original file). Coordinates with 7 decimals (~1 cm),
 * elevation with 1 decimal.
 */
export function routeToGpx(track: RouteTrack): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Freilauf" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata>',
    `    <name>${escapeXml(track.name)}</name>`,
  ];
  if (track.description) lines.push(`    <desc>${escapeXml(track.description)}</desc>`);
  lines.push(
    '  </metadata>',
    '  <trk>',
    `    <name>${escapeXml(track.name)}</name>`,
    '    <trkseg>',
  );
  for (let i = 0; i < track.count; i++) {
    lines.push(
      `      <trkpt lat="${track.lat[i]!.toFixed(7)}" lon="${track.lon[i]!.toFixed(7)}"><ele>${track.elevationM[i]!.toFixed(1)}</ele></trkpt>`,
    );
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
  return lines.join('\n');
}
