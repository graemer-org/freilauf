import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiagnosticLog, LogFile } from './logFile';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-log-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const line = (n: number) => `line ${String(n).padStart(4, '0')} ${'x'.repeat(40)}`;

describe('LogFile', () => {
  it('queues lines and writes them on flush, creating the directory', async () => {
    const f = new LogFile({ dir: path.join(dir, 'logs'), flushMs: 10_000 });
    f.append('a');
    f.append('b');
    expect(fs.existsSync(f.filePath)).toBe(false); // nothing written synchronously
    await f.flush();
    expect(fs.readFileSync(f.filePath, 'utf8')).toBe('a\nb\n');
  });

  it('writes on its own after the flush delay', async () => {
    const f = new LogFile({ dir, flushMs: 5 });
    f.append('later');
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(f.filePath, 'utf8')).toBe('later\n');
  });

  it('rotates by size and keeps a bounded number of files', async () => {
    const f = new LogFile({ dir, maxBytes: 500, keep: 2, flushMs: 10_000 });
    for (let i = 0; i < 40; i++) {
      f.append(line(i));
      await f.flush();
    }
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual(['freilauf.1.log', 'freilauf.2.log', 'freilauf.log']);
    for (const n of names) expect(fs.statSync(path.join(dir, n)).size).toBeLessThanOrEqual(500);
    // Newest lines are in the current file, older ones in .1 and .2, nothing older survives.
    expect(fs.readFileSync(path.join(dir, 'freilauf.log'), 'utf8')).toContain(line(39));
    const all = await f.readAll();
    expect(all.indexOf('----- freilauf.2.log')).toBeLessThan(all.indexOf('----- freilauf.log'));
    expect(all).not.toContain(line(0));
    const info = await f.info();
    expect(info.directory).toBe(dir);
    expect(info.files.map((x) => x.name)).toEqual([
      'freilauf.log',
      'freilauf.1.log',
      'freilauf.2.log',
    ]);
  });

  it('flushSync writes and rotates synchronously (quit / crash path)', () => {
    const f = new LogFile({ dir, maxBytes: 200, keep: 1, flushMs: 10_000 });
    for (let i = 0; i < 10; i++) {
      f.append(line(i));
      f.flushSync();
    }
    expect(fs.readdirSync(dir).sort()).toEqual(['freilauf.1.log', 'freilauf.log']);
    f.close();
    f.append('after close');
    expect(fs.readFileSync(f.filePath, 'utf8')).toContain('after close');
  });

  it('never throws when the file cannot be written; drops, counts and reports later', async () => {
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    const f = new LogFile({ dir: blocked, flushMs: 10_000 });
    f.append('lost 1');
    f.append('lost 2');
    await expect(f.flush()).resolves.toBeUndefined();
    expect(() => f.flushSync()).not.toThrow();
    expect(f.dropped).toBe(2);
    expect(f.lastError).toMatch(/EEXIST|ENOTDIR/);

    // Once writing works again the count is written first.
    fs.rmSync(blocked);
    f.append('back');
    await f.flush();
    const text = fs.readFileSync(path.join(blocked, 'freilauf.log'), 'utf8');
    expect(text).toMatch(/WARN +log +2 log line\(s\) were dropped/);
    expect(text.trim().endsWith('back')).toBe(true);
  });

  it('drops (and counts) lines beyond the queue limit', async () => {
    const f = new LogFile({ dir, maxQueueBytes: 30, flushMs: 10_000 });
    for (let i = 0; i < 5; i++) f.append('0123456789');
    expect(f.dropped).toBe(3);
    await f.flush();
    expect(fs.readFileSync(f.filePath, 'utf8')).toContain('3 log line(s) were dropped');
  });

  it('readRecent returns the tail, reaching into the previous file when needed', async () => {
    const f = new LogFile({ dir, maxBytes: 300, keep: 1, flushMs: 10_000 });
    for (let i = 0; i < 8; i++) {
      f.append(line(i));
      await f.flush();
    }
    const recent = await f.readRecent(250);
    expect(recent.length).toBeLessThanOrEqual(250);
    expect(recent.endsWith(`${line(7)}\n`)).toBe(true);
    expect(recent.startsWith('line ')).toBe(true);
    expect(await f.readRecent(0)).toBe('');
  });
});

describe('DiagnosticLog', () => {
  it('formats, redacts and queues', async () => {
    const f = new LogFile({ dir, flushMs: 10_000 });
    const log = new DiagnosticLog(f, { console: false });
    log.setSecrets({ riderName: 'Grace Hopper', homeDir: '/home/grace' });
    log.scope('settings').info('Grace Hopper changed /home/grace/x', { who: 'Grace Hopper' });
    await f.flush();
    const text = fs.readFileSync(f.filePath, 'utf8');
    expect(text).toMatch(/INFO +settings +\[rider\] changed ~\/x \{"who":"\[rider\]"\}\n$/);
    expect(text).not.toContain('Grace');
  });
});
