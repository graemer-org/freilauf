/**
 * Ride persistence: `<dir>/<id>.json` (+ `<id>.fit` after export). No Electron
 * imports: the "Save as…" dialog is injected (unit-tested in rideStore.test.ts).
 *
 * File format: `{ formatVersion: 1, finished, savedAt, ride: RecordedRide }`.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { RecordedRide } from '@freilauf/session';
import { encodeFit, rideSummary } from '@freilauf/session';
import type { RideListItem } from '../shared/contract';
import { writeFileAtomic } from './atomicWrite';
import { isPlainObject } from './settings';
import { isRecordedRide } from './validate';

const FORMAT_VERSION = 1;
const MAX_ID_LENGTH = 100;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Maps a ride id to a safe file stem: only `[A-Za-z0-9._-]`, no leading dots,
 * no Windows reserved device names, bounded length. Idempotent, so the stem
 * returned by `list()` and the original ride id address the same file.
 * Throws for ids that map to nothing.
 */
export function rideFileId(id: string): string {
  if (typeof id !== 'string') throw new Error('ride id must be a string');
  let s = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  s = s.slice(0, MAX_ID_LENGTH).replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED.test(s.split('.')[0] ?? '')) s = `_${s}`;
  if (s === '' || /^_*$/.test(s)) throw new Error(`invalid ride id: ${JSON.stringify(id)}`);
  return s;
}

/** File-name friendly version of a ride name for the "Save as…" default. */
export function exportFileName(ride: RecordedRide): string {
  const d = new Date(Number.isFinite(ride.startedAt) ? ride.startedAt : Date.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const name = ride.name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `freilauf_${stamp}${name ? `_${name}` : ''}.fit`;
}

interface StoredRide {
  formatVersion: number;
  finished: boolean;
  savedAt: number;
  ride: RecordedRide;
}

export type ChooseExportPath = (defaultFileName: string) => Promise<string | null>;

export class RideStore {
  readonly dir: string;
  private readonly log: (msg: string) => void;

  constructor(dir: string, log: (msg: string) => void = (m) => console.warn(`[rides] ${m}`)) {
    this.dir = path.resolve(dir);
    this.log = log;
  }

  /** Absolute path for `<id><ext>`, guaranteed to be inside `dir`. */
  pathFor(id: string, ext: '.json' | '.fit'): string {
    const p = path.resolve(this.dir, rideFileId(id) + ext);
    if (path.dirname(p) !== this.dir)
      throw new Error(`ride path escapes the rides directory: ${id}`);
    return p;
  }

  async save(ride: RecordedRide, finished: boolean): Promise<void> {
    if (!isRecordedRide(ride)) throw new Error('invalid ride');
    const stored: StoredRide = {
      formatVersion: FORMAT_VERSION,
      finished: finished === true,
      savedAt: Date.now(),
      ride,
    };
    await writeFileAtomic(this.pathFor(ride.id, '.json'), JSON.stringify(stored));
  }

  async load(id: string): Promise<StoredRide> {
    const text = await fsp.readFile(this.pathFor(id, '.json'), 'utf8');
    const raw = JSON.parse(text) as unknown;
    if (!isPlainObject(raw) || !isRecordedRide(raw.ride))
      throw new Error(`corrupt ride file for ${id}`);
    return {
      formatVersion: Number(raw.formatVersion) || 1,
      finished: raw.finished === true,
      savedAt: Number(raw.savedAt) || 0,
      ride: raw.ride,
    };
  }

  /** The recorded ride, or null when there is no (readable) file for `id`. Never throws. */
  async loadRide(id: string): Promise<RecordedRide | null> {
    try {
      return (await this.load(id)).ride;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`could not load ride ${String(id).slice(0, 100)}: ${String(e)}`);
      }
      return null;
    }
  }

  async list(): Promise<RideListItem[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const items: RideListItem[] = [];
    for (const file of names) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      const id = file.slice(0, -'.json'.length);
      try {
        if (rideFileId(id) !== id) continue;
        const { ride, finished } = await this.load(id);
        const summary = rideSummary(ride);
        items.push({
          id,
          name: ride.name,
          startedAt: Number.isFinite(ride.startedAt) ? ride.startedAt : summary.startTime,
          durationS: summary.durationS,
          distanceM: summary.distanceM,
          avgPowerW: summary.avgPowerW,
          ...(summary.caloriesKcal > 0 ? { kcal: Math.round(summary.caloriesKcal) } : {}),
          finished,
        });
      } catch (e) {
        this.log(`skipping unreadable ride ${file}: ${String(e)}`);
      }
    }
    items.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
    return items;
  }

  /** Writes `<id>.fit` next to the JSON, then copies it to the path the user chooses. */
  async exportFit(id: string, choose: ChooseExportPath): Promise<string | null> {
    const { ride } = await this.load(id);
    const fitPath = this.pathFor(id, '.fit');
    await writeFileAtomic(fitPath, encodeFit(ride));
    const target = await choose(exportFileName(ride));
    if (!target) return null;
    const resolved = path.resolve(target.endsWith('.fit') ? target : `${target}.fit`);
    if (resolved !== fitPath) await fsp.copyFile(fitPath, resolved);
    return resolved;
  }

  async delete(id: string): Promise<void> {
    await fsp.rm(this.pathFor(id, '.json'), { force: true });
    await fsp.rm(this.pathFor(id, '.fit'), { force: true });
  }

  async ensureDir(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
  }
}
