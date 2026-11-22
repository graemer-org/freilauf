/** IndexedDB implementation of RideRecordStore: `rides` (full records) + `summaries`. */
import type { RideListItem } from '../../desktop/src/shared/contract';
import type { RideRecordStore, StoredRide } from './rideRepository';

const DB_NAME = 'freilauf';
const DB_VERSION = 1;
const RIDES = 'rides';
const SUMMARIES = 'summaries';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export function openRideDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  const req = factory.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(RIDES)) db.createObjectStore(RIDES, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(SUMMARIES))
      db.createObjectStore(SUMMARIES, { keyPath: 'id' });
  };
  return request(req);
}

export class IndexedDbRideRecordStore implements RideRecordStore {
  readonly #db: Promise<IDBDatabase>;

  constructor(db: Promise<IDBDatabase> = openRideDatabase()) {
    this.#db = db;
  }

  async put(record: StoredRide, summary: RideListItem): Promise<void> {
    const tx = (await this.#db).transaction([RIDES, SUMMARIES], 'readwrite');
    tx.objectStore(RIDES).put(record);
    tx.objectStore(SUMMARIES).put(summary);
    await done(tx);
  }

  async get(id: string): Promise<StoredRide | undefined> {
    const tx = (await this.#db).transaction(RIDES, 'readonly');
    return (await request(tx.objectStore(RIDES).get(id))) as StoredRide | undefined;
  }

  async listSummaries(): Promise<RideListItem[]> {
    const tx = (await this.#db).transaction(SUMMARIES, 'readonly');
    return (await request(tx.objectStore(SUMMARIES).getAll())) as RideListItem[];
  }

  async delete(id: string): Promise<void> {
    const tx = (await this.#db).transaction([RIDES, SUMMARIES], 'readwrite');
    tx.objectStore(RIDES).delete(id);
    tx.objectStore(SUMMARIES).delete(id);
    await done(tx);
  }
}
