import { describe, expect, it } from 'vitest';
import { MAX_GPX_BYTES, parseGpx, routeToGpx } from './gpx';
import { buildRoute } from './build';

const pt = (lat: number, lon: number, ele?: number, tag = 'trkpt') =>
  `<${tag} lat="${lat}" lon="${lon}">${ele === undefined ? '' : `<ele>${ele}</ele>`}</${tag}>`;
const line = (n: number, ele?: (i: number) => number | undefined, tag = 'trkpt') =>
  Array.from({ length: n }, (_, i) => pt(10 + i * 0.0005, 20, ele ? ele(i) : 100 + i, tag)).join(
    '',
  );

const GPX11 = (
  body: string,
  meta = '<metadata><name>Morning loop</name><desc>Nice</desc></metadata>',
) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${meta}${body}</gpx>`;

describe('parseGpx: accepted files', () => {
  it('reads GPX 1.1 tracks with metadata name and description', () => {
    const r = parseGpx(GPX11(`<trk><name>Track name</name><trkseg>${line(5)}</trkseg></trk>`));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.track.name).toBe('Morning loop');
    expect(r.track.description).toBe('Nice');
    expect(r.track.points).toHaveLength(5);
    expect(r.track.points[2]).toEqual({ lat: 10.001, lon: 20, ele: 102 });
    expect(r.track.hasElevation).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('reads GPX 1.0 (name on the root, no metadata)', () => {
    const r = parseGpx(
      `<gpx version="1.0" xmlns="http://www.topografix.com/GPX/1/0"><name>Old</name><trk><trkseg>${line(3)}</trkseg></trk></gpx>`,
    );
    expect(r.ok && r.track.name).toBe('Old');
  });

  it('falls back to route points with a warning', () => {
    const r = parseGpx(GPX11(`<rte><name>Planned</name>${line(4, undefined, 'rtept')}</rte>`, ''));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.track.name).toBe('Planned');
    expect(r.track.points).toHaveLength(4);
    expect(r.warnings.join()).toMatch(/route points/);
  });

  it('joins several segments and tracks in order, with a warning', () => {
    const r = parseGpx(
      GPX11(
        `<trk><trkseg>${pt(1, 1, 5)}${pt(1.001, 1, 6)}</trkseg><trkseg>${pt(1.002, 1, 7)}</trkseg></trk><trk><trkseg>${pt(1.003, 1, 8)}</trkseg></trk>`,
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.track.points.map((p) => p.ele)).toEqual([5, 6, 7, 8]);
    expect(r.warnings.join()).toMatch(/3 track segments/);
  });

  it('accepts a file without any elevation as a flat route, saying so', () => {
    const r = parseGpx(GPX11(`<trk><trkseg>${line(4, () => undefined)}</trkseg></trk>`));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.track.hasElevation).toBe(false);
    expect(r.track.points.every((p) => p.ele === 0)).toBe(true);
    expect(r.warnings).toContain('This file has no elevation; the route will be flat.');
  });

  it('interpolates missing elevations by distance', () => {
    const r = parseGpx(
      GPX11(
        `<trk><trkseg>${line(5, (i) => (i === 0 ? 100 : i === 4 ? 140 : undefined))}</trkseg></trk>`,
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.track.points.map((p) => Math.round(p.ele))).toEqual([100, 110, 120, 130, 140]);
    expect(r.warnings.join()).toMatch(/3 of 5 points had no elevation/);
  });

  it('ignores namespaces, prefixes, waypoints, extensions, time and unknown elements', () => {
    const r = parseGpx(
      `﻿<?xml version="1.0"?><g:gpx version="1.1" xmlns:g="http://www.topografix.com/GPX/1/1" xmlns:x="urn:x">
       <g:metadata><g:name><![CDATA[Café & <co>]]></g:name></g:metadata>
       <g:wpt lat="5" lon="5"><g:name>Viewpoint</g:name></g:wpt>
       <g:trk><g:type>road</g:type><x:whatever a="1"/><g:trkseg>
         <g:trkpt lat="1" lon="1"><g:ele>10</g:ele><g:time>2026-01-01T00:00:00Z</g:time>
           <g:extensions><x:hr>120</x:hr></g:extensions></g:trkpt>
         <g:trkpt lat="1.001" lon="1"><g:ele>11</g:ele></g:trkpt>
       </g:trkseg></g:trk></g:gpx>`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.track.name).toBe('Café & <co>');
    expect(r.track.points).toHaveLength(2);
  });

  it('decodes entities in names', () => {
    const r = parseGpx(
      GPX11(
        `<trk><trkseg>${line(2)}</trkseg></trk>`,
        '<metadata><name>A &amp; B &#x2192;</name></metadata>',
      ),
    );
    expect(r.ok && r.track.name).toBe('A & B →');
  });
});

describe('parseGpx: rejected files', () => {
  const cases: [string, string, RegExp][] = [
    ['not XML', 'hello', /Malformed XML|root element/],
    ['malformed XML', '<gpx><trk></gpx>', /Malformed XML/],
    ['DOCTYPE', '<!DOCTYPE gpx [<!ENTITY x "y">]><gpx version="1.1"></gpx>', /DOCTYPE/],
    ['entity reference', GPX11(`<trk><name>&x;</name><trkseg>${line(2)}</trkseg></trk>`), /entity/],
    ['wrong root', '<kml></kml>', /Not a GPX file/],
    ['no points', GPX11('<trk><trkseg></trkseg></trk>'), /no track or route points/],
    [
      'missing lat',
      GPX11('<trk><trkseg><trkpt lon="1"/><trkpt lat="1" lon="2"/></trkseg></trk>'),
      /Point 1/,
    ],
    [
      'non-finite lat',
      GPX11('<trk><trkseg><trkpt lat="1e999" lon="1"/><trkpt lat="1" lon="2"/></trkseg></trk>'),
      /invalid/,
    ],
    [
      'NaN lon',
      GPX11('<trk><trkseg><trkpt lat="1" lon="NaN"/><trkpt lat="1" lon="2"/></trkseg></trk>'),
      /invalid/,
    ],
    [
      'lat out of range',
      GPX11('<trk><trkseg><trkpt lat="91" lon="1"/><trkpt lat="1" lon="2"/></trkseg></trk>'),
      /out of range/,
    ],
    [
      'lon out of range',
      GPX11('<trk><trkseg><trkpt lat="1" lon="181"/><trkpt lat="1" lon="2"/></trkseg></trk>'),
      /out of range/,
    ],
    ['one point', GPX11(`<trk><trkseg>${pt(1, 1, 1)}</trkseg></trk>`), /two distinct/],
    [
      'identical points',
      GPX11(`<trk><trkseg>${pt(1, 1, 1)}${pt(1, 1, 2)}${pt(1, 1.000001, 2)}</trkseg></trk>`),
      /two distinct/,
    ],
  ];
  it.each(cases)('%s', (_name, text, error) => {
    const r = parseGpx(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(error);
  });

  it('refuses files over 20 MB without parsing them', () => {
    const r = parseGpx(' '.repeat(MAX_GPX_BYTES + 1));
    expect(r).toEqual({ ok: false, errors: ['The file is larger than 20 MB.'] });
  });

  it('refuses more than 500 000 points', () => {
    const many = '<trkpt lat="1" lon="1"/>'.repeat(500_001);
    const r = parseGpx(GPX11(`<trk><trkseg>${many}</trkseg></trk>`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/500000/);
  });

  it('treats unreadable elevations as missing, with a warning', () => {
    const r = parseGpx(
      GPX11(
        `<trk><trkseg>${pt(1, 1, 5)}<trkpt lat="1.001" lon="1"><ele>high</ele></trkpt>${pt(1.002, 1, 7)}</trkseg></trk>`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.track.points[1]!.ele).toBeCloseTo(6, 3);
      expect(r.warnings.join()).toMatch(/unreadable elevation/);
    }
  });

  it('never throws on arbitrary input', () => {
    for (const s of [
      '',
      '<',
      '<gpx',
      '<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="1">',
      '\u0000',
    ]) {
      expect(() => parseGpx(s)).not.toThrow();
      expect(parseGpx(s).ok).toBe(false);
    }
    expect(parseGpx(undefined as unknown as string).ok).toBe(false);
  });
});

describe('routeToGpx', () => {
  it('round-trips through parseGpx and buildRoute', () => {
    const parsed = parseGpx(
      GPX11(
        `<trk><trkseg>${line(60, (i) => 100 + i * 0.5)}</trkseg></trk>`,
        '<metadata><name>R &amp; D</name></metadata>',
      ),
    );
    if (!parsed.ok) throw new Error('parse');
    const track = buildRoute(parsed.track);
    const gpx = routeToGpx(track);
    const again = parseGpx(gpx);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.track.name).toBe('R & D');
    expect(again.track.points).toHaveLength(track.count);
    const rebuilt = buildRoute(again.track);
    expect(rebuilt.totalDistanceM).toBeCloseTo(track.totalDistanceM, 0);
    expect(rebuilt.ascentM).toBeCloseTo(track.ascentM, 0);
  });
});
