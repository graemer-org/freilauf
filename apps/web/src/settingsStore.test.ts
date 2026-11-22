import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../desktop/src/shared/contract';
import {
  BrowserSettingsStore,
  SETTINGS_KEY,
  webDefaultSettings,
  type KeyValueStorage,
  type MessageChannelLike,
} from './settingsStore';

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
}

/** Two "tabs" on one in-memory BroadcastChannel (which never delivers to the sender). */
function channelPair(): [MessageChannelLike, MessageChannelLike] {
  const listeners: [Array<(e: { data: unknown }) => void>, Array<(e: { data: unknown }) => void>] =
    [[], []];
  const make = (self: 0 | 1): MessageChannelLike => ({
    postMessage: (data) => {
      for (const l of listeners[self === 0 ? 1 : 0]) l({ data: structuredClone(data) });
    },
    addEventListener: (_type, listener) => listeners[self].push(listener),
  });
  return [make(0), make(1)];
}

const quiet = { log: () => {} };
const web = webDefaultSettings({ protocol: 'https:', host: 'nas.example:8443' });

describe('BrowserSettingsStore', () => {
  it('starts from web defaults with the same-origin signalling URL', () => {
    const store = new BrowserSettingsStore({
      storage: new MemoryStorage(),
      defaults: web,
      ...quiet,
    });
    expect(store.get().group.signallingUrl).toBe('wss://nas.example:8443/signal');
    expect(store.get().rider).toEqual(DEFAULT_SETTINGS.rider);
  });

  it('persists deep-merged updates and reloads them', () => {
    const storage = new MemoryStorage();
    const a = new BrowserSettingsStore({ storage, defaults: web, ...quiet });
    const next = a.update({
      rider: { massKg: 82 },
      devices: { trainer: { id: 'X1', name: 'Kickr' } },
    });
    expect(next.rider).toEqual({ ...DEFAULT_SETTINGS.rider, massKg: 82 });
    const b = new BrowserSettingsStore({ storage, defaults: web, ...quiet });
    expect(b.get().rider.massKg).toBe(82);
    expect(b.get().devices.trainer).toEqual({ id: 'X1', name: 'Kickr' });
  });

  it('rejects invalid patch fields and keeps the rest', () => {
    const store = new BrowserSettingsStore({
      storage: new MemoryStorage(),
      defaults: web,
      ...quiet,
    });
    const next = store.update({
      rider: { massKg: -5, name: 'Ana' },
      group: { signallingUrl: 'http://not-a-websocket' },
    } as never);
    expect(next.rider.massKg).toBe(DEFAULT_SETTINGS.rider.massKg);
    expect(next.rider.name).toBe('Ana');
    expect(next.group.signallingUrl).toBe('wss://nas.example:8443/signal');
  });

  it('recovers from corrupt or partly invalid stored data', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_KEY, '{not json');
    expect(new BrowserSettingsStore({ storage, defaults: web, ...quiet }).get()).toEqual(web);
    storage.setItem(SETTINGS_KEY, JSON.stringify({ rider: { massKg: 'heavy', name: 'Bo' } }));
    const s = new BrowserSettingsStore({ storage, defaults: web, ...quiet }).get();
    expect(s.rider).toEqual({ ...DEFAULT_SETTINGS.rider, name: 'Bo' });
    expect(s.group.signallingUrl).toBe(web.group.signallingUrl);
  });

  it('forgets a device', () => {
    const store = new BrowserSettingsStore({
      storage: new MemoryStorage(),
      defaults: web,
      ...quiet,
    });
    store.update({ devices: { heartRate: { id: 'H', name: 'Strap' } } });
    expect(store.forgetDevice('heartRate').devices).toEqual({});
  });

  it('notifies listeners and returns copies', () => {
    const store = new BrowserSettingsStore({
      storage: new MemoryStorage(),
      defaults: web,
      ...quiet,
    });
    const seen: Settings[] = [];
    const off = store.onChange((s) => seen.push(s));
    store.update({ rider: { name: 'C' } });
    off();
    store.update({ rider: { name: 'D' } });
    expect(seen.map((s) => s.rider.name)).toEqual(['C']);
    store.get().rider.name = 'mutated';
    expect(store.get().rider.name).toBe('D');
  });

  it('syncs another tab through the channel without echoing', () => {
    const storage = new MemoryStorage();
    const [ca, cb] = channelPair();
    const a = new BrowserSettingsStore({ storage, channel: ca, defaults: web, ...quiet });
    const b = new BrowserSettingsStore({ storage, channel: cb, defaults: web, ...quiet });
    const seenA: string[] = [];
    const seenB: string[] = [];
    a.onChange((s) => seenA.push(s.rider.name));
    b.onChange((s) => seenB.push(s.rider.name));
    a.update({ rider: { name: 'Synced' } });
    expect(b.get().rider.name).toBe('Synced');
    expect(seenA).toEqual(['Synced']);
    expect(seenB).toEqual(['Synced']);
  });

  it('validates what arrives over the channel', () => {
    const [ca, cb] = channelPair();
    const b = new BrowserSettingsStore({ storage: null, channel: cb, defaults: web, ...quiet });
    ca.postMessage({ rider: { massKg: 1e9, name: 'Evil' }, __proto__: { polluted: true } });
    expect(b.get().rider.massKg).toBe(DEFAULT_SETTINGS.rider.massKg);
    expect(b.get().rider.name).toBe('Evil');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('surfaces storage write failures and keeps the previous value', () => {
    const storage = new MemoryStorage();
    const store = new BrowserSettingsStore({ storage, defaults: web, ...quiet });
    storage.failWrites = true;
    expect(() => store.update({ rider: { name: 'Lost' } })).toThrow(/Quota/);
    expect(store.get().rider.name).toBe(DEFAULT_SETTINGS.rider.name);
  });

  it('works without storage (in memory only)', () => {
    const store = new BrowserSettingsStore({ storage: null, defaults: web, ...quiet });
    expect(store.update({ rider: { name: 'Mem' } }).rider.name).toBe('Mem');
  });
});
