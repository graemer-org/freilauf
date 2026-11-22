import { describe, expect, it } from 'vitest';
import type { RecordedRide } from '@freilauf/session';
import { exportFileName, MemoryRideRecordStore, RideRepository } from './rideRepository';

function ride(id: string, startedAt: number, seconds = 30, name = 'Morning ride'): RecordedRide {
  return {
    id,
    name,
    startedAt,
    riderMassKg: 75,
    samples: Array.from({ length: seconds }, (_, i) => ({
      timestamp: startedAt + i * 1000,
      elapsedS: i,
      powerW: 200,
      cadenceRpm: 90,
      heartRateBpm: 140,
      speedMps: 10,
      distanceM: i * 10,
      gradePercent: 0,
      gear: 12,
    })),
  };
}

function setup() {
  const downloads: { name: string; bytes: Uint8Array; type: string }[] = [];
  const repo = new RideRepository(
    new MemoryRideRecordStore(),
    (name, bytes, type) => downloads.push({ name, bytes, type }),
    () => 1_700_000_000_000,
  );
  return { repo, downloads };
}

describe('RideRepository', () => {
  it('lists saved rides newest first with summaries', async () => {
    const { repo } = setup();
    await repo.save(ride('a', 1_000_000), true);
    await repo.save(ride('b', 2_000_000, 60), false);
    const list = await repo.list();
    expect(list.map((r) => r.id)).toEqual(['b', 'a']);
    expect(list[0]).toMatchObject({ id: 'b', finished: false, name: 'Morning ride' });
    expect(list[0]?.durationS).toBeGreaterThan(50);
    expect(list[0]?.avgPowerW).toBeCloseTo(200, 0);
    expect(list[1]?.finished).toBe(true);
  });

  it('overwrites an autosave with the finished ride', async () => {
    const { repo } = setup();
    await repo.save(ride('a', 1_000_000, 10), false);
    await repo.save(ride('a', 1_000_000, 40), true);
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.finished).toBe(true);
  });

  it('rejects invalid rides', async () => {
    const { repo } = setup();
    await expect(repo.save({ id: '' } as unknown as RecordedRide, true)).rejects.toThrow(/invalid/);
  });

  it('exports a .fit download and returns its name', async () => {
    const { repo, downloads } = setup();
    const r = ride('a', new Date(2026, 10, 22, 7, 5).getTime());
    await repo.save(r, true);
    const name = await repo.exportFit('a');
    expect(name).toBe('freilauf_2026-11-22_0705_Morning ride.fit');
    expect(downloads).toHaveLength(1);
    const bytes = downloads[0]!.bytes;
    // FIT header: size 14, ".FIT" signature at bytes 8..11.
    expect(bytes[0]).toBe(14);
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('.FIT');
    expect(bytes.byteLength).toBeGreaterThan(30 * 10);
  });

  it('fails export for unknown rides', async () => {
    const { repo } = setup();
    await expect(repo.exportFit('nope')).rejects.toThrow(/not found/);
  });

  it('deletes rides', async () => {
    const { repo } = setup();
    await repo.save(ride('a', 1), true);
    await repo.delete('a');
    expect(await repo.list()).toEqual([]);
  });

  it('builds safe file names', () => {
    expect(exportFileName(ride('x', new Date(2026, 0, 2, 3, 4).getTime(), 1, ' a/b:c  d '))).toBe(
      'freilauf_2026-01-02_0304_abc d.fit',
    );
    expect(exportFileName(ride('x', new Date(2026, 0, 2, 3, 4).getTime(), 1, ''))).toBe(
      'freilauf_2026-01-02_0304.fit',
    );
  });
});
