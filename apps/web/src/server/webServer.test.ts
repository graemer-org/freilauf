import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cacheControlFor,
  createWebServer,
  IMMUTABLE,
  loadStaticFiles,
  resolveRequest,
  REVALIDATE,
  type WebServer,
} from './webServer.ts';

let dir: string;
let server: WebServer;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'freilauf-web-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Freilauf</title>');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), `console.log(${'1+'.repeat(2000)}1);`);
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
  writeFileSync(path.join(dir, '.secret'), 'nope');
  server = await createWebServer({ root: dir });
  base = `http://127.0.0.1:${await server.listen(0, '127.0.0.1')}`;
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('static resolution', () => {
  it('maps paths, SPA fallback and 404s', () => {
    const files = loadStaticFiles(dir);
    const r = (p: string) => {
      const x = resolveRequest(files, p);
      return x.kind === 'file' ? x.urlPath : null;
    };
    expect(r('/')).toBe('/index.html');
    expect(r('/assets/index-abc123.js')).toBe('/assets/index-abc123.js');
    expect(r('/history')).toBe('/index.html');
    expect(r('/assets/missing.js')).toBeNull();
    expect(r('/assets/nested')).toBeNull();
    expect(r('/missing.png')).toBeNull();
    expect(r('/../package.json')).toBeNull();
    expect(r('/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(r('/%E0%A4%A')).toBeNull();
    expect(r('/.secret')).toBeNull();
  });

  it('caches hashed assets forever and revalidates the rest', () => {
    expect(cacheControlFor('/assets/index-abc123.js')).toBe(IMMUTABLE);
    expect(cacheControlFor('/index.html')).toBe(REVALIDATE);
  });
});

describe('web server', () => {
  it('serves index.html with security headers and no-cache', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self' ws: wss:");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('permissions-policy')).toContain('bluetooth=(self)');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves hashed assets immutable, gzipped, with 304 revalidation', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(await res.text()).toMatch(/^console\.log/);
    const etag = res.headers.get('etag')!;
    const again = await fetch(`${base}/assets/index-abc123.js`, {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
  });

  it('falls back to index.html for app routes and 404s missing assets', async () => {
    expect((await fetch(`${base}/some/route`)).status).toBe(200);
    expect((await fetch(`${base}/assets/gone.js`)).status).toBe(404);
    expect((await fetch(`${base}/.secret`)).status).toBe(404);
  });

  it('answers health checks and refuses other methods', async () => {
    expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok\n');
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('serves the signalling WebSocket at /signal on the same port', async () => {
    // Node 22's built-in (browser-compatible) WebSocket client.
    const ws = new WebSocket(`${base.replace('http', 'ws')}/signal`);
    const reply = await new Promise<unknown>((resolve, reject) => {
      ws.addEventListener('open', () =>
        ws.send(JSON.stringify({ type: 'join', room: 'ROOM42', peerId: 'peer-a', name: 'A' })),
      );
      ws.addEventListener('message', (e) => resolve(JSON.parse(String(e.data))), { once: true });
      ws.addEventListener('error', () => reject(new Error('websocket error')));
    });
    expect(reply).toMatchObject({ type: 'joined', room: 'ROOM42' });
    ws.close();
    expect((await fetch(`${base}/signal`)).status).toBe(426);
  });
});
