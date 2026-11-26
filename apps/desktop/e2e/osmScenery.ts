/**
 * Helpers for the scenery e2e tests: a fake Overpass server on 127.0.0.1 that answers every
 * query with the synthetic fixture (packages/routes/fixtures/osm), and a GPX excerpt (the first
 * kilometres) of packages/routes/fixtures/isar-ursprung.gpx that the fixture lines up with.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const fixtures = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'routes',
  'fixtures',
);
export const OVERPASS_FIXTURE = path.join(fixtures, 'osm', 'isar-ursprung.overpass.json');
export const ISAR_GPX = path.join(fixtures, 'isar-ursprung.gpx');

export interface FakeOverpass {
  url: string;
  requests: { userAgent: string; contentType: string; body: string }[];
  close(): Promise<void>;
}

/** Answers POST /api/interpreter with the fixture; `status` lets a test simulate a busy server. */
export async function fakeOverpass(status: () => number = () => 200): Promise<FakeOverpass> {
  const body = fs.readFileSync(OVERPASS_FIXTURE, 'utf8');
  const requests: FakeOverpass['requests'] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => {
      requests.push({
        userAgent: String(req.headers['user-agent'] ?? ''),
        contentType: String(req.headers['content-type'] ?? ''),
        body: data,
      });
      const s = status();
      if (req.method !== 'POST' || !req.url?.startsWith('/api/interpreter') || s !== 200) {
        res.writeHead(req.method === 'POST' ? s : 405, { 'retry-after': '1' }).end('busy');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/interpreter`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The first `km` of the Isar fixture as a GPX file (same points, so the fixture lines up). */
export function isarExcerpt(km = 7): string {
  const text = fs.readFileSync(ISAR_GPX, 'utf8');
  const pts = [...text.matchAll(/<trkpt[\s\S]*?<\/trkpt>/g)].map((m) => m[0]);
  const ll = (p: string) => {
    const lat = Number(/lat="([^"]+)"/.exec(p)![1]);
    const lon = Number(/lon="([^"]+)"/.exec(p)![1]);
    return { lat, lon };
  };
  const rad = Math.PI / 180;
  let dist = 0;
  const kept = [pts[0]!];
  for (let i = 1; i < pts.length && dist < km * 1000; i++) {
    const a = ll(pts[i - 1]!);
    const b = ll(pts[i]!);
    const x = (b.lon - a.lon) * rad * Math.cos(a.lat * rad);
    const y = (b.lat - a.lat) * rad;
    dist += Math.hypot(x, y) * 6_371_000;
    kept.push(pts[i]!);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="freilauf-e2e" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>Isar valley test</name><trkseg>
${kept.join('\n')}
</trkseg></trk>
</gpx>`;
}
