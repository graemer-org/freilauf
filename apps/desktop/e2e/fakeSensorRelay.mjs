#!/usr/bin/env node
// A stand-in for the native sensor-relay helper (apps/desktop/native/sensor-relay)
// that speaks the same newline-delimited JSON protocol, for unit-integration and
// Electron e2e tests on any OS. Point the app at it with
//   FREILAUF_SENSOR_RELAY_HELPER=<this file>   (unpackaged builds only)
//
// Behaviour, from the environment:
//   FAKE_RELAY_MODE      ok (default) | unsupported | badProtocol | crash (exit 3 after `start`)
//   FAKE_RELAY_REASON    the reason sent with `unsupported`
//   FAKE_RELAY_LOG       file: every command received is appended as {"t":ms,"cmd":{…}}
//   FAKE_RELAY_CONTROL   file: polled; every new line in it is written to stdout as an
//                        event (e.g. a `subscribers` event, as if a watch subscribed)
import fs from 'node:fs';

const mode = process.env.FAKE_RELAY_MODE || 'ok';
const logFile = process.env.FAKE_RELAY_LOG || '';
const controlFile = process.env.FAKE_RELAY_CONTROL || '';
const reason =
  process.env.FAKE_RELAY_REASON ||
  "This computer's Bluetooth adapter cannot act as a sensor (fake helper).";

const send = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const record = (cmd) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), cmd })}\n`);
};

send({
  type: 'ready',
  version: 'fake',
  protocol: mode === 'badProtocol' ? 99 : 1,
  backend: 'fake',
});
send({
  type: 'adapter',
  lowEnergySupported: true,
  peripheralRoleSupported: mode !== 'unsupported',
  centralRoleSupported: true,
  radioOn: true,
});
if (mode === 'unsupported') send({ type: 'unsupported', reason });

let controlOffset = 0;
const timer = controlFile
  ? setInterval(() => {
      let text = '';
      try {
        text = fs.readFileSync(controlFile, 'utf8');
      } catch {
        return;
      }
      if (text.length <= controlOffset) return;
      const fresh = text.slice(controlOffset);
      const end = fresh.lastIndexOf('\n');
      if (end < 0) return;
      controlOffset += end + 1;
      for (const line of fresh.slice(0, end).split('\n'))
        if (line.trim()) process.stdout.write(`${line}\n`);
    }, 50)
  : null;

const quit = (code = 0) => {
  if (timer) clearInterval(timer);
  process.exit(code);
};

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      send({ type: 'error', message: `bad command: ${line.slice(0, 40)}` });
      continue;
    }
    record(cmd);
    switch (cmd.type) {
      case 'start':
        if (mode === 'unsupported') {
          send({ type: 'unsupported', reason });
        } else if (mode === 'crash') {
          quit(3);
        } else {
          const services = cmd.services.map((s) => s.uuid);
          send({ type: 'started', services });
          for (const service of services) send({ type: 'advertising', service, status: 'started' });
        }
        break;
      case 'stop':
        send({ type: 'stopped' });
        break;
      case 'quit':
        quit(0);
        break;
      default:
        break;
    }
  }
});
process.stdin.on('end', () => quit(0));
