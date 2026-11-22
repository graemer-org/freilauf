/**
 * Entry point of the Docker image (and `pnpm --filter @freilauf/web start`):
 *   PORT (default 8080), HOST (default all interfaces),
 *   STATIC_DIR (default ../../dist relative to this file), LOG_LEVEL=debug.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebServer, SIGNALLING_PATH } from './webServer.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawPort = process.env['PORT'] ?? '8080';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid PORT: ${rawPort}`);
  process.exit(1);
}
const host = process.env['HOST'] || undefined;
const root = path.resolve(process.env['STATIC_DIR'] || path.join(here, '../../dist'));
const verbose = process.env['LOG_LEVEL'] === 'debug';

const server = await createWebServer({
  root,
  log: (line) => console.log(line),
  logRequests: verbose,
});
const bound = await server.listen(port, host);
console.log(
  `freilauf web on http://${host ?? '0.0.0.0'}:${bound} (static: ${root}, signalling: ${SIGNALLING_PATH})`,
);

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
