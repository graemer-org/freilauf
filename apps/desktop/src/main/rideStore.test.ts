import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RecordedRide } from '@freilauf/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RideStore, exportFileName, rideFileId } from './rideStore';

function ride(id: string, startedAt: number, n = 3): RecordedRide {
  return {
    id,
    name: `Ride ${id}`,
    startedAt,
    riderMassKg: 75,
    samples: Array.from({ length: n }, (_, i) => ({
      timestamp: startedAt + i * 1000,
      elapsedS: i,
      powerW: 200,
      cadenceRpm: 90,
      heartRateBpm: i === 0 ? null : 140,
      speedMps: 10,
      distanceM: i * 10,
      gradePercent: 0,
      gear: 12,
    })),
  };
}

describe('rideFileId', () => {
  it('keeps safe ids unchanged and is idempotent', () => {
    for (const id of ['abc', 'ride-2026_11_22', 'a.b', '0123456789abcdef']) {
      expect(rideFileId(id)).toBe(id);
      expect(rideFileId(rideFileId(id))).toBe(rideFileId(id));
    }
    const iso = rideFileId('2026-11-22T10:00:00.000Z');
    expect(iso).toBe('2026-11-22T10_00_00.000Z');
    expect(rideFileId(iso)).toBe(iso);
  });

  it('can never escape the directory', () => {
    const dir = path.resolve('/tmp/rides-test');
    const store = new RideStore(dir);
    for (const evil of [
      '../evil',
      '../../etc/passwd',
      '..\\..\\Windows\\win.ini',
      '/abs/path',
      'C:\\abs',
      'a/../../b',
      '.hidden',
      'x\u0000y',
      '%2e%2e%2f',
    ]) {
      const p = store.pathFor(evil, '.json');
      expect(path.dirname(p)).toBe(dir);
      expect(path.basename(p).startsWith('.')).toBe(false);
    }
  });

  it('rejects ids that map to nothing and Windows device names', () => {
    for (const bad of ['', '..', '...', '/', '\\\\', '   ']) {
      expect(() => rideFileId(bad)).toThrow();
    }
    expect(rideFileId('CON')).toBe('_CON');
    expect(rideFileId('nul.txt')).toBe('_nul.txt');
    expect(rideFileId('x'.repeat(500)).length).toBeLessThanOrEqual(100);
  });
});

describe('exportFileName', () => {
  it('produces a safe file name', () => {
    const name = exportFileName({
      ...ride('a', new Date(2026, 10, 22, 7, 5).getTime()),
      name: 'Morning: <spin>/"x"',
    });
    expect(name).toBe('freilauf_2026-11-22_0705_Morning spinx.fit');
  });
});

describe('RideStore', () => {
  let dir: string;
  let store: RideStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-rides-'));
    store = new RideStore(path.join(dir, 'rides'), () => undefined);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists nothing when the directory does not exist', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('saves, lists newest first, skips corrupt files', async () => {
    await store.save(ride('old', 1_000_000), true);
    await store.save(ride('new', 2_000_000, 11), false);
    fs.writeFileSync(path.join(store.dir, 'broken.json'), '{nope');
    fs.writeFileSync(path.join(store.dir, 'wrong-shape.json'), '{"ride": {"id": 1}}');
    const log = vi.fn();
    const list = await new RideStore(store.dir, log).list();
    expect(list.map((r) => r.id)).toEqual(['new', 'old']);
    expect(list[0]).toMatchObject({
      name: 'Ride new',
      startedAt: 2_000_000,
      finished: false,
      durationS: 10,
      distanceM: 100,
      avgPowerW: 200,
    });
    expect(list[1]?.finished).toBe(true);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('overwrites on re-save (autosave → finished)', async () => {
    await store.save(ride('r', 1), false);
    await store.save(ride('r', 1, 5), true);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.finished).toBe(true);
    expect(fs.readdirSync(store.dir)).toEqual(['r.json']);
  });

  it('loads one full ride, null for missing or corrupt files', async () => {
    const r = ride('full', 1_000_000, 11);
    await store.save(r, true);
    expect(await store.loadRide('full')).toEqual(r);
    expect(await store.loadRide('missing')).toBeNull();
    fs.writeFileSync(path.join(store.dir, 'broken.json'), '{nope');
    const log = vi.fn();
    expect(await new RideStore(store.dir, log).loadRide('broken')).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(await store.loadRide('../escape')).toBeNull();
  });

  it('rejects invalid rides', async () => {
    await expect(store.save({ id: 'x' } as unknown as RecordedRide, true)).rejects.toThrow();
  });

  it('exports FIT next to the JSON and copies to the chosen path', async () => {
    await store.save(ride('fit', Date.UTC(2026, 0, 1)), true);
    const target = path.join(dir, 'out', 'chosen');
    fs.mkdirSync(path.dirname(target));
    const choose = vi.fn(async () => target);
    const result = await store.exportFit('fit', choose);
    expect(choose).toHaveBeenCalledWith(expect.stringMatching(/^freilauf_.*\.fit$/));
    expect(result).toBe(`${target}.fit`);
    const fit = fs.readFileSync(path.join(store.dir, 'fit.fit'));
    expect(fit.subarray(8, 12).toString('ascii')).toBe('.FIT');
    expect(fs.readFileSync(`${target}.fit`).equals(fit)).toBe(true);
  });

  it('returns null when export is cancelled (the .fit stays next to the JSON)', async () => {
    await store.save(ride('c', 1), true);
    expect(await store.exportFit('c', async () => null)).toBeNull();
    expect(fs.existsSync(path.join(store.dir, 'c.fit'))).toBe(true);
  });

  it('deletes JSON and FIT', async () => {
    await store.save(ride('d', 1), true);
    await store.exportFit('d', async () => null);
    await store.delete('d');
    await store.delete('d');
    expect(fs.readdirSync(store.dir)).toEqual([]);
  });
});
