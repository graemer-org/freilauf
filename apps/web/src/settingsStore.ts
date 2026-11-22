/**
 * Browser settings persistence: one JSON value in localStorage, validated
 * with the desktop's pure merge/validate logic, and broadcast to other tabs
 * (and the Picture-in-Picture window) through a BroadcastChannel.
 *
 * Storage and channel are injected so this runs under Vitest in Node.
 */
import type { DeviceKind } from '@freilauf/devices';
import {
  applySettingsPatch,
  deepMerge,
  forgetDevice,
  sanitizeSettings,
} from '../../desktop/src/main/settings';
import type { DeepPartial, Settings } from '../../desktop/src/shared/contract';
import { DEFAULT_SETTINGS } from '../../desktop/src/shared/contract';
import { defaultSignallingUrl } from './signallingUrl';

export const SETTINGS_KEY = 'freilauf.settings.v1';
export const SETTINGS_CHANNEL = 'freilauf.settings';

/** The subset of the Web Storage API we use. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The subset of BroadcastChannel we use. */
export interface MessageChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** Desktop defaults, with the signalling server on the page's own origin. */
export function webDefaultSettings(location: { protocol: string; host: string }): Settings {
  return deepMerge(DEFAULT_SETTINGS, {
    group: { signallingUrl: defaultSignallingUrl(location) },
  });
}

export interface BrowserSettingsStoreOptions {
  storage: KeyValueStorage | null;
  channel?: MessageChannelLike | null;
  defaults?: Settings;
  log?: (message: string) => void;
}

export class BrowserSettingsStore {
  readonly #storage: KeyValueStorage | null;
  readonly #channel: MessageChannelLike | null;
  readonly #log: (message: string) => void;
  readonly #listeners = new Set<(settings: Settings) => void>();
  #current: Settings;

  constructor(options: BrowserSettingsStoreOptions) {
    this.#storage = options.storage;
    this.#channel = options.channel ?? null;
    this.#log = options.log ?? ((m) => console.warn(`[settings] ${m}`));
    this.#current = this.#load(options.defaults ?? DEFAULT_SETTINGS);
    this.#channel?.addEventListener('message', (event) => {
      // Another tab (or the PiP window's document) saved: adopt, don't re-broadcast.
      const problems: string[] = [];
      this.#current = sanitizeSettings(event.data, this.#current, problems);
      if (problems.length)
        this.#log(`ignored invalid fields from another tab: ${problems.join('; ')}`);
      this.#emit();
    });
  }

  get(): Settings {
    return structuredClone(this.#current);
  }

  update(patch: DeepPartial<Settings>): Settings {
    const problems: string[] = [];
    const next = applySettingsPatch(this.#current, patch, problems);
    if (problems.length) this.#log(`rejected: ${problems.join('; ')}`);
    return this.#commit(next);
  }

  forgetDevice(kind: DeviceKind): Settings {
    return this.#commit(forgetDevice(this.#current, kind));
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #load(defaults: Settings): Settings {
    let text: string | null = null;
    try {
      text = this.#storage?.getItem(SETTINGS_KEY) ?? null;
    } catch (err) {
      this.#log(`could not read stored settings: ${String(err)}`);
    }
    if (text === null) return structuredClone(defaults);
    try {
      const problems: string[] = [];
      const settings = sanitizeSettings(JSON.parse(text) as unknown, defaults, problems);
      if (problems.length) this.#log(`stored settings partly invalid: ${problems.join('; ')}`);
      return settings;
    } catch {
      this.#log('stored settings are not valid JSON; using defaults');
      return structuredClone(defaults);
    }
  }

  #commit(next: Settings): Settings {
    // Persist first: if storage is full or blocked the caller gets the error
    // and the in-memory value stays consistent with what is stored.
    this.#storage?.setItem(SETTINGS_KEY, JSON.stringify(next));
    this.#current = next;
    this.#channel?.postMessage(next);
    this.#emit();
    return structuredClone(next);
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener(structuredClone(this.#current));
      } catch (err) {
        this.#log(`settings listener failed: ${String(err)}`);
      }
    }
  }
}
