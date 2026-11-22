/**
 * Production server for the web build: serves the static app (dist/) and
 * the group-ride signalling WebSocket at /signal on ONE port, so a single
 * `ports:` mapping or reverse-proxy entry is enough.
 *
 * The (small) build output is read into memory at start: only files that
 * exist in dist/ can ever be served, so path traversal is impossible by
 * construction, and the container's root filesystem can be read-only.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createSignallingServer, type SignallingServer } from '../../../signalling/src/server.ts';
import { SECURITY_HEADERS } from './securityHeaders.ts';

export const SIGNALLING_PATH = '/signal';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';

export interface StaticFile {
  body: Buffer;
  gzip: Buffer | null;
  contentType: string;
  etag: string;
  cacheControl: string;
}

/** Vite puts content-hashed files under /assets/; everything else must revalidate. */
export function cacheControlFor(urlPath: string): string {
  return urlPath.startsWith('/assets/') ? IMMUTABLE : REVALIDATE;
}

/** Reads every file below `root` into a map keyed by URL path (`/assets/x.js`). */
export function loadStaticFiles(root: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() && !statSync(full).isFile()) continue;
      const urlPath = '/' + path.relative(root, full).split(path.sep).join('/');
      const body = readFileSync(full);
      const contentType =
        CONTENT_TYPES[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream';
      const gzip =
        COMPRESSIBLE.test(contentType) && body.byteLength > 1024
          ? gzipSync(body, { level: 9 })
          : null;
      files.set(urlPath, {
        body,
        gzip: gzip && gzip.byteLength < body.byteLength ? gzip : null,
        contentType,
        etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
        cacheControl: cacheControlFor(urlPath),
      });
    }
  };
  walk(root);
  return files;
}

export type Resolution =
  { kind: 'file'; urlPath: string; file: StaticFile } | { kind: 'not-found' };

/**
 * Maps a request path to a file. Paths without a file extension that are
 * not files fall back to /index.html (SPA routing); a missing asset is a 404
 * (an HTML page would only confuse the browser's module loader).
 */
export function resolveRequest(
  files: ReadonlyMap<string, StaticFile>,
  rawPath: string,
): Resolution {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    return { kind: 'not-found' };
  }
  if (urlPath.includes('\0') || /(^|\/)\.\.(\/|$)/.test(urlPath)) return { kind: 'not-found' };
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const direct = files.get(urlPath);
  if (direct) return { kind: 'file', urlPath, file: direct };
  const last = urlPath.slice(urlPath.lastIndexOf('/') + 1);
  if (!last.includes('.') && !urlPath.startsWith('/assets/')) {
    const index = files.get('/index.html');
    if (index) return { kind: 'file', urlPath: '/index.html', file: index };
  }
  return { kind: 'not-found' };
}

function acceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers['accept-encoding'];
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  return /\bgzip\b(?!\s*;\s*q=0(\.0*)?\b)/i.test(value);
}

export interface WebServerOptions {
  /** Directory with the built app (apps/web/dist). */
  root: string;
  /** Serve the signalling WebSocket at /signal. Default true. */
  signalling?: boolean;
  log?: (line: string) => void;
  logRequests?: boolean;
}

export interface WebServer {
  readonly http: Server;
  readonly signalling: SignallingServer | null;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  const log = options.log ?? (() => {});
  const files = loadStaticFiles(options.root);
  if (!files.has('/index.html')) {
    throw new Error(`no index.html in ${options.root}; build the web app first`);
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const method = req.method ?? 'GET';
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad request\n');
      return;
    }
    if (options.logRequests) log(`${method} ${pathname}`);

    if (pathname === '/healthz') {
      res
        .writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        })
        .end(method === 'HEAD' ? undefined : 'ok\n');
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res
        .writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
        .end('Method not allowed\n');
      return;
    }
    if (pathname === SIGNALLING_PATH) {
      res
        .writeHead(426, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        })
        .end('Freilauf signalling: connect via WebSocket.\n');
      return;
    }

    const found = resolveRequest(files, pathname);
    if (found.kind === 'not-found') {
      res
        .writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-cache',
        })
        .end(method === 'HEAD' ? undefined : 'Not found\n');
      return;
    }
    const { file } = found;
    const headers: Record<string, string> = {
      'content-type': file.contentType,
      'cache-control': file.cacheControl,
      etag: file.etag,
    };
    if (file.gzip) headers['vary'] = 'Accept-Encoding';
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers).end();
      return;
    }
    const gzip = file.gzip !== null && acceptsGzip(req);
    const body = gzip && file.gzip ? file.gzip : file.body;
    if (gzip) headers['content-encoding'] = 'gzip';
    headers['content-length'] = String(body.byteLength);
    res.writeHead(200, headers).end(method === 'HEAD' ? undefined : body);
  };

  const http = createServer(handle);
  // Close idle keep-alive sockets promptly on shutdown.
  http.keepAliveTimeout = 5_000;
  const signalling =
    options.signalling === false
      ? null
      : await createSignallingServer({
          server: http,
          path: SIGNALLING_PATH,
          // Room open/close lines name room codes: only when debugging.
          log: options.logRequests ? log : undefined,
        });

  return {
    http,
    signalling,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => {
          http.off('error', reject);
          const address = http.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      }),
    close: async () => {
      await signalling?.close();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}
