import fs from 'node:fs';
import path from 'node:path';
import { RelayUuid, relayServices } from '@freilauf/devices';
import { describe, expect, it } from 'vitest';
import {
  LineSplitter,
  RELAY_COMMAND_TYPES,
  RELAY_EVENT_TYPES,
  SENSOR_RELAY_PROTOCOL,
  commandLine,
  notifyCommand,
  parseRelayEvent,
  startCommand,
} from './sensorRelayProtocol';

const rustSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../native/sensor-relay/src/protocol.rs'),
  'utf8',
);

/** Variant names of `pub enum <name> { … }` in the Rust source. */
function rustVariants(name: string): string[] {
  const start = rustSource.indexOf(`pub enum ${name} {`);
  expect(start).toBeGreaterThan(-1);
  const end = rustSource.indexOf('\n}\n', start);
  const body = rustSource.slice(start, end);
  return [...body.matchAll(/^ {4}([A-Z]\w*)\s*[{,]/gm)].map((m) => m[1] ?? '');
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function rustStringArray(name: string): string[] {
  const m = new RegExp(`pub const ${name}: \\[&str; \\d+\\]\\s*=\\s*\\[([^\\]]*)\\]`).exec(
    rustSource,
  );
  expect(m, name).not.toBeNull();
  return [...(m?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? '');
}

describe('sync with protocol.rs', () => {
  it('has the same protocol version', () => {
    const m = /pub const PROTOCOL: u32 = (\d+);/.exec(rustSource);
    expect(Number(m?.[1])).toBe(SENSOR_RELAY_PROTOCOL);
  });

  it('has the same command and event names', () => {
    expect(rustVariants('Command').map(lowerFirst)).toEqual([...RELAY_COMMAND_TYPES]);
    expect(rustVariants('Event').map(lowerFirst)).toEqual([...RELAY_EVENT_TYPES]);
    expect(rustStringArray('COMMAND_TYPES')).toEqual([...RELAY_COMMAND_TYPES]);
    expect(rustStringArray('EVENT_TYPES')).toEqual([...RELAY_EVENT_TYPES]);
  });

  it('knows every property the helper accepts', () => {
    expect(rustVariants('Property').map(lowerFirst)).toEqual([
      'read',
      'notify',
      'indicate',
      'write',
    ]);
  });
});

describe('commands', () => {
  it('serialises start with hex values, one line', () => {
    const line = commandLine(startCommand(relayServices(['heartRate'])));
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    const parsed = JSON.parse(line) as {
      type: string;
      services: { uuid: string; characteristics: { uuid: string; value: string }[] }[];
    };
    expect(parsed.type).toBe('start');
    expect(parsed.services[0]?.uuid).toBe(RelayUuid.heartRateService);
    expect(parsed.services[0]?.characteristics.map((c) => c.value)).toEqual(['0400', '01']);
  });

  it('serialises notify', () => {
    const c = notifyCommand({
      service: RelayUuid.heartRateService,
      characteristic: RelayUuid.heartRateMeasurement,
      value: new Uint8Array([0x06, 0x8c]),
    });
    expect(c).toEqual({
      type: 'notify',
      service: RelayUuid.heartRateService,
      characteristic: RelayUuid.heartRateMeasurement,
      value: '068c',
    });
  });
});

describe('parseRelayEvent', () => {
  const S = RelayUuid.cscService;
  const C = RelayUuid.scControlPoint;

  it('parses every event the helper writes', () => {
    expect(
      parseRelayEvent('{"type":"ready","version":"0.1.0","protocol":1,"backend":"winrt"}'),
    ).toEqual({ type: 'ready', version: '0.1.0', protocol: 1, backend: 'winrt' });
    expect(
      parseRelayEvent(
        '{"type":"adapter","lowEnergySupported":true,"peripheralRoleSupported":false,"centralRoleSupported":true,"radioOn":null}',
      ),
    ).toEqual({
      type: 'adapter',
      lowEnergySupported: true,
      peripheralRoleSupported: false,
      centralRoleSupported: true,
      radioOn: null,
    });
    expect(parseRelayEvent('{"type":"unsupported","reason":"no"}')).toEqual({
      type: 'unsupported',
      reason: 'no',
    });
    expect(parseRelayEvent(`{"type":"started","services":["${S}"]}`)).toEqual({
      type: 'started',
      services: [S],
    });
    expect(parseRelayEvent('{"type":"stopped"}')).toEqual({ type: 'stopped' });
    expect(parseRelayEvent(`{"type":"advertising","service":"${S}","status":"started"}`)).toEqual({
      type: 'advertising',
      service: S,
      status: 'started',
    });
    expect(
      parseRelayEvent(
        `{"type":"subscribers","service":"${S}","characteristic":"${C}","centrals":["c1a2b3c4"]}`,
      ),
    ).toEqual({ type: 'subscribers', service: S, characteristic: C, centrals: ['c1a2b3c4'] });
    expect(
      parseRelayEvent(
        `{"type":"write","service":"${S}","characteristic":"${C}","value":"0100000000","central":"c1"}`,
      ),
    ).toEqual({ type: 'write', service: S, characteristic: C, value: '0100000000', central: 'c1' });
    expect(parseRelayEvent('{"type":"error","message":"x"}')).toEqual({
      type: 'error',
      message: 'x',
    });
  });

  it('rejects junk and malformed fields', () => {
    for (const line of [
      '',
      'garbage',
      'null',
      '[]',
      '{"type":"explode"}',
      '{"type":"ready","version":"1","protocol":"1","backend":"x"}',
      '{"type":"ready","version":"1","protocol":1.5,"backend":"x"}',
      '{"type":"started","services":["180d"]}',
      `{"type":"started","services":["${S.toUpperCase()}"]}`,
      `{"type":"subscribers","service":"${S}","characteristic":"${C}","centrals":["a b"]}`,
      `{"type":"subscribers","service":"${S}","characteristic":"${C}","centrals":"c1"}`,
      `{"type":"write","service":"${S}","characteristic":"${C}","value":"0","central":"c1"}`,
      '{"type":"unsupported"}',
      `{"type":"unsupported","reason":"${'x'.repeat(600)}"}`,
    ]) {
      expect(parseRelayEvent(line), line.slice(0, 60)).toBeNull();
    }
  });

  it('truncates long error messages instead of dropping them', () => {
    const e = parseRelayEvent(JSON.stringify({ type: 'error', message: 'y'.repeat(2000) }));
    expect(e?.type === 'error' && e.message.length).toBe(500);
  });
});

describe('LineSplitter', () => {
  it('joins chunks and splits lines, CRLF too', () => {
    const s = new LineSplitter();
    expect(s.push('{"a"')).toEqual([]);
    expect(s.push(':1}\r\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(s.push(':3}\n')).toEqual(['{"c":3}']);
  });

  it('drops a runaway line and recovers at the next newline', () => {
    const s = new LineSplitter(10);
    expect(s.push('x'.repeat(25))).toEqual([]);
    expect(s.push('yyy\nok\n')).toEqual(['ok']);
  });
});
