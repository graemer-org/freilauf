import { describe, expect, it } from 'vitest';
import {
  RateLimiter,
  describeError,
  describeUrl,
  formatLogLine,
  logFileNames,
  maskCode,
  normaliseSource,
  redact,
  redactEntry,
  rotatedName,
  rotationPlan,
  sessionHeaderEntries,
  shouldRotate,
  tailText,
  toJsonSafe,
} from './logFormat';

const T = Date.UTC(2026, 10, 22, 8, 0, 0, 123);

describe('formatLogLine', () => {
  it('writes time, level, source, message and compact JSON context', () => {
    expect(
      formatLogLine({
        time: T,
        level: 'info',
        source: 'ble',
        message: 'connected',
        context: { ms: 812 },
      }),
    ).toBe('2026-11-22T08:00:00.123Z INFO  ble      connected {"ms":812}');
  });

  it('keeps one event on one line and drops empty contexts', () => {
    const line = formatLogLine({
      time: T,
      level: 'error',
      source: 'main',
      message: 'a\nb\r\nc',
      context: {},
    });
    expect(line).toBe('2026-11-22T08:00:00.123Z ERROR main     a ⏎ b ⏎ c');
    const ctx = formatLogLine({
      time: T,
      level: 'warn',
      source: 'x',
      message: 'm',
      context: { stack: 'Error: x\n    at f (a.js:1:1)' },
    });
    expect(ctx.split('\n')).toHaveLength(1);
  });

  it('normalises bad sources and levels instead of throwing', () => {
    expect(normaliseSource('Bad Source!')).toBe('unknown');
    expect(normaliseSource('P2P')).toBe('p2p');
    const line = formatLogLine({ time: T, level: 'nope' as never, source: 'ride', message: 'x' });
    expect(line).toContain(' INFO  ride ');
  });

  it('truncates long messages', () => {
    const line = formatLogLine({
      time: T,
      level: 'info',
      source: 'ble',
      message: 'x'.repeat(5000),
    });
    expect(line.length).toBeLessThan(2100);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('toJsonSafe', () => {
  it('handles errors, bytes, cycles, bigints and functions', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const err = new TypeError('boom', { cause: new Error('inner') });
    const safe = toJsonSafe({
      err,
      bytes: new Uint8Array([0x23, 0x08, 0xff]),
      cyclic,
      big: 10n,
      fn: () => 1,
      nan: Number.NaN,
    }) as Record<string, unknown>;
    expect(safe.bytes).toBe('23 08 ff');
    expect((safe.cyclic as Record<string, unknown>).self).toBe('[circular]');
    expect(safe.big).toBe('10');
    expect('fn' in safe).toBe(false);
    expect(safe.nan).toBe('NaN');
    const e = safe.err as Record<string, unknown>;
    expect(e).toMatchObject({ name: 'TypeError', message: 'boom', cause: { message: 'inner' } });
    expect(String(e.stack)).toContain('TypeError: boom');
  });

  it('describes DOMException-like errors with their name and code', () => {
    expect(
      describeError({ name: 'NetworkError', message: 'Connection failed', code: 19 }),
    ).toMatchObject({
      name: 'NetworkError',
      message: 'Connection failed',
      code: 19,
    });
    expect(describeError('plain')).toEqual({ name: 'string', message: 'plain' });
  });
});

describe('redact', () => {
  it('masks the rider name, case-insensitively, as a whole word', () => {
    expect(redact('Ada Lovelace joined; ada lovelace again', { riderName: 'Ada Lovelace' })).toBe(
      '[rider] joined; [rider] again',
    );
    expect(redact('Max and Maxine', { riderName: 'Max' })).toBe('[rider] and Maxine');
  });

  it('leaves the default name alone (it is not personal and is also a settings path)', () => {
    expect(redact('rider.name changed', { riderName: 'Rider' })).toBe('rider.name changed');
  });

  it('removes URL credentials and query strings', () => {
    expect(redact('connect wss://bob:secret@sig.example.org/signal?token=abc failed')).toBe(
      'connect wss://***@sig.example.org/signal?… failed',
    );
  });

  it('masks room codes in join links, after "room", and when given explicitly', () => {
    expect(redact('freilauf://join/ABCDEF?s=wss%3A%2F%2Fx')).toBe('freilauf://join/AB****?…');
    expect(redact('joined room ABCDEF')).toBe('joined room AB****');
    expect(redact('{"roomCode":"XYZ234"}')).toBe('{"roomCode":"XY****"}');
    expect(redact('code HJKMNP is open', { codes: ['HJKMNP'] })).toBe('code HJ**** is open');
    // Ordinary words after "room" are not codes.
    expect(redact('room create failed')).toBe('room create failed');
  });

  it('replaces the home directory (it contains the account name)', () => {
    expect(
      redact('at C:\\Users\\Ada\\AppData\\x.js and file:///C:/Users/Ada/app', {
        homeDir: 'C:\\Users\\Ada',
      }),
    ).toBe('at ~\\AppData\\x.js and file:///~/app');
  });

  it('redacts inside contexts too', () => {
    const e = redactEntry(
      {
        time: T,
        level: 'info',
        source: 'p2p',
        message: 'hi Ada',
        context: { nested: { who: 'Ada', list: ['Ada'] }, n: 1 },
      },
      { riderName: 'Ada' },
    );
    expect(e.message).toBe('hi [rider]');
    expect(e.context).toEqual({ nested: { who: '[rider]', list: ['[rider]'] }, n: 1 });
  });

  it('maskCode and describeUrl', () => {
    expect(maskCode('ABCDEF')).toBe('AB****');
    expect(maskCode('A')).toBe('*');
    expect(describeUrl('wss://u:p@sig.example.org:8443/signal?room=ABCDEF')).toBe(
      'wss://sig.example.org:8443/…',
    );
    expect(describeUrl('ws://localhost:8787')).toBe('ws://localhost:8787');
    expect(describeUrl('nope')).toBe('[invalid url]');
  });
});

describe('RateLimiter', () => {
  it('allows `limit` per window and reports what was suppressed', () => {
    let now = 0;
    const rl = new RateLimiter(2, 1000, () => now);
    expect(rl.take('a')).toEqual({ allowed: true, suppressed: 0 });
    expect(rl.take('a')).toEqual({ allowed: true, suppressed: 0 });
    expect(rl.take('a').allowed).toBe(false);
    expect(rl.take('a').allowed).toBe(false);
    expect(rl.take('b').allowed).toBe(true); // keys are independent
    now = 1000;
    expect(rl.take('a')).toEqual({ allowed: true, suppressed: 2 });
    expect(rl.take('a')).toEqual({ allowed: true, suppressed: 0 });
    rl.take('a');
    expect(rl.drainSuppressed()).toEqual([{ key: 'a', suppressed: 1 }]);
    expect(rl.drainSuppressed()).toEqual([]);
  });
});

describe('rotation', () => {
  it('rotates only a non-empty file that would grow beyond the limit', () => {
    expect(shouldRotate(0, 5000, 1000)).toBe(false);
    expect(shouldRotate(900, 50, 1000)).toBe(false);
    expect(shouldRotate(900, 101, 1000)).toBe(true);
  });

  it('names and plans the files', () => {
    expect(rotatedName('freilauf.log', 0)).toBe('freilauf.log');
    expect(rotatedName('freilauf.log', 2)).toBe('freilauf.2.log');
    expect(logFileNames('freilauf.log', 3)).toEqual([
      'freilauf.log',
      'freilauf.1.log',
      'freilauf.2.log',
      'freilauf.3.log',
    ]);
    expect(rotationPlan('freilauf.log', 3)).toEqual([
      { op: 'delete', name: 'freilauf.3.log' },
      { op: 'rename', from: 'freilauf.2.log', to: 'freilauf.3.log' },
      { op: 'rename', from: 'freilauf.1.log', to: 'freilauf.2.log' },
      { op: 'rename', from: 'freilauf.log', to: 'freilauf.1.log' },
    ]);
  });
});

describe('tailText and session header', () => {
  it('tails at a line boundary', () => {
    expect(tailText('aaa\nbbb\nccc\n', 6)).toBe('ccc\n');
    expect(tailText('short', 100)).toBe('short');
    expect(tailText('x', 0)).toBe('');
  });

  it('builds header entries from facts', () => {
    const entries = sessionHeaderEntries(
      {
        sessionId: 'abcd1234',
        app: 'Freilauf',
        version: '1.2.3',
        facts: { os: { platform: 'win32' }, sim: true },
      },
      T,
    );
    expect(entries.map((e) => formatLogLine(e))).toEqual([
      '2026-11-22T08:00:00.123Z INFO  session  ===== Freilauf 1.2.3 session abcd1234 started =====',
      '2026-11-22T08:00:00.123Z INFO  session  os {"platform":"win32"}',
      '2026-11-22T08:00:00.123Z INFO  session  sim {"value":true}',
    ]);
  });
});
