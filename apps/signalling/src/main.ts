import { createSignallingServer } from './server.ts';

const rawPort = process.env['PORT'] ?? '8787';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid PORT: ${rawPort}`);
  process.exit(1);
}
const host = process.env['HOST'] || undefined;
const verbose = process.env['LOG_LEVEL'] === 'debug';

const server = await createSignallingServer({
  port,
  host,
  log: verbose ? (line) => console.log(line) : undefined,
});
console.log(`freilauf signalling listening on ${host ?? '0.0.0.0'}:${server.port}`);

function shutdown(): void {
  void server.close().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
