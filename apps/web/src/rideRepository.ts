/**
 * Ride persistence for the web build. Same semantics as the desktop
 * RideStore (apps/desktop/src/main/rideStore.ts) but on an injected record
 * store (IndexedDB in the browser, an in-memory fake in tests), and `.fit`
 * export is a file download instead of a "Save as…" dialog.
 */
import type { RecordedRide } from '@freilauf/session';
import { encodeFit, rideRouteInfo, rideSummary } from '@freilauf/session';
import { isRecordedRide } from '../../desktop/src/main/validate';
import type { RideListItem } from '../../desktop/src/shared/contract';

export const RIDE_FORMAT_VERSION = 1;

export interface StoredRide {
  id: string;
  formatVersion: number;
  finished: boolean;
  savedAt: number;
  ride: RecordedRide;
}

/**
 * Where rides live. Summaries are kept apart from the (large) sample arrays
 * so listing the history does not load every ride.
 */
export interface RideRecordStore {
  put(record: StoredRide, summary: RideListItem): Promise<void>;
  get(id: string): Promise<StoredRide | undefined>;
  listSummaries(): Promise<RideListItem[]>;
  delete(id: string): Promise<void>;
}

/** Hands the encoded file to the user (a Blob download in the browser). */
export type DownloadFile = (fileName: string, bytes: Uint8Array, mimeType: string) => void;

/** Same file name scheme as the desktop's "Save as…" default. */
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

export function summarize(ride: RecordedRide, finished: boolean): RideListItem {
  const summary = rideSummary(ride);
  return {
    id: ride.id,
    name: ride.name,
    startedAt: Number.isFinite(ride.startedAt) ? ride.startedAt : summary.startTime,
    durationS: summary.durationS,
    distanceM: summary.distanceM,
    avgPowerW: summary.avgPowerW,
    ...(summary.caloriesKcal > 0 ? { kcal: Math.round(summary.caloriesKcal) } : {}),
    finished,
    ...routeOf(ride),
  };
}

export class RideRepository {
  readonly #store: RideRecordStore;
  readonly #download: DownloadFile;
  readonly #now: () => number;

  constructor(store: RideRecordStore, download: DownloadFile, now: () => number = Date.now) {
    this.#store = store;
    this.#download = download;
    this.#now = now;
  }

  async list(): Promise<RideListItem[]> {
    const items = await this.#store.listSummaries();
    return [...items].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
  }

  async save(ride: RecordedRide, finished: boolean): Promise<void> {
    if (!isRecordedRide(ride)) throw new Error('invalid ride');
    const fin = finished === true;
    await this.#store.put(
      {
        id: ride.id,
        formatVersion: RIDE_FORMAT_VERSION,
        finished: fin,
        savedAt: this.#now(),
        ride,
      },
      summarize(ride, fin),
    );
  }

  /** The recorded ride, or null when there is none (or it does not validate). */
  async load(id: string): Promise<RecordedRide | null> {
    const record = await this.#store.get(id);
    return record && isRecordedRide(record.ride) ? record.ride : null;
  }

  /** Encodes the ride and starts a download. Returns the downloaded file name. */
  async exportFit(id: string): Promise<string | null> {
    const record = await this.#store.get(id);
    if (!record || !isRecordedRide(record.ride)) throw new Error(`ride ${id} not found`);
    const fileName = exportFileName(record.ride);
    this.#download(fileName, encodeFit(record.ride), 'application/vnd.ant.fit');
    return fileName;
  }

  async delete(id: string): Promise<void> {
    await this.#store.delete(id);
  }
}

/** In-memory RideRecordStore (tests, and the fallback when IndexedDB is unavailable). */
export class MemoryRideRecordStore implements RideRecordStore {
  readonly #records = new Map<string, { record: StoredRide; summary: RideListItem }>();

  async put(record: StoredRide, summary: RideListItem): Promise<void> {
    this.#records.set(record.id, structuredClone({ record, summary }));
  }

  async get(id: string): Promise<StoredRide | undefined> {
    const entry = this.#records.get(id);
    return entry ? structuredClone(entry.record) : undefined;
  }

  async listSummaries(): Promise<RideListItem[]> {
    return [...this.#records.values()].map((e) => ({ ...e.summary }));
  }

  async delete(id: string): Promise<void> {
    this.#records.delete(id);
  }
}

/** The route a ride followed and what it offers as a ghost (docs/ghost.md); {} without one. */
function routeOf(ride: RecordedRide): Pick<RideListItem, 'route'> {
  const route = rideRouteInfo(ride);
  return route ? { route } : {};
}
