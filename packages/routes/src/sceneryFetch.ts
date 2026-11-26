/**
 * Fetching the scenery of a route once, chunk by chunk, from an Overpass server, politely:
 * one request at a time, a pause between requests, retries with exponential backoff when
 * the server is busy (429, 502–504, timeouts; Retry-After is honoured), cancellable at any
 * point, with progress. The HTTP request itself is the host's (`OverpassTransport`): the
 * desktop app sends it from the main process, the browser build with fetch.
 */
import type { RouteTrack } from './types';
import { overpassQuery, parseOverpassJson, sceneryChunks, type ChunkOptions } from './overpass';
import { summarizeScenery, type SceneryModel, type ScenerySummary } from './scenery';
import { SceneryBuilder } from './sceneryBuild';
import { utf8ByteLength } from './geo';

/** What a cancellable operation listens to. */
export interface CancelSignal {
  readonly cancelled: boolean;
  /** Calls `fn` once on cancel (right away if already cancelled); returns an unsubscribe. */
  onCancel(fn: () => void): () => void;
}

export class CancelSource {
  #cancelled = false;
  readonly #listeners = new Set<() => void>();
  readonly signal: CancelSignal;

  constructor() {
    const isCancelled = (): boolean => this.#cancelled;
    const listeners = this.#listeners;
    this.signal = {
      get cancelled() {
        return isCancelled();
      },
      onCancel(fn) {
        if (isCancelled()) {
          fn();
          return () => undefined;
        }
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    for (const fn of [...this.#listeners]) {
      try {
        fn();
      } catch {
        // a listener's trouble is not the caller's
      }
    }
    this.#listeners.clear();
  }
}

export interface OverpassResponse {
  status: number;
  text: string;
  /** Seconds from a Retry-After header, if any. */
  retryAfterS?: number | null;
}

/** Sends one query; rejects on a network failure or timeout (and on cancel). */
export type OverpassTransport = (query: string, signal: CancelSignal) => Promise<OverpassResponse>;

export interface SceneryProgress {
  /** Chunks done and in all. */
  done: number;
  total: number;
  /** 'waiting' while backing off after a busy answer. */
  phase: 'fetching' | 'waiting' | 'building';
  /** Seconds until the next try while waiting. */
  waitS?: number;
}

export interface FetchSceneryOptions extends ChunkOptions {
  transport: OverpassTransport;
  signal?: CancelSignal;
  onProgress?: (p: SceneryProgress) => void;
  /** Cancellable sleep; default setTimeout. */
  sleep?: (ms: number, signal: CancelSignal) => Promise<void>;
  now?: () => number;
  /** Tries per chunk after the first one (default 4). */
  retries?: number;
  /** First backoff (ms, default 5000), doubled per try, at most maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Pause between two requests (ms, default 1000). */
  pauseMs?: number;
}

export type FetchSceneryResult =
  | { ok: true; model: SceneryModel; text: string; summary: ScenerySummary; requests: number }
  | { ok: false; cancelled: boolean; error: string; requests: number };

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/** Timers without depending on DOM or Node typings (this package has neither). */
const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const NEVER: CancelSignal = { cancelled: false, onCancel: () => () => undefined };

export function cancellableSleep(ms: number, signal: CancelSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.cancelled) {
      reject(new CancelledError());
      return;
    }
    const timer = timers.setTimeout(() => {
      off();
      resolve();
    }, ms);
    const off = signal.onCancel(() => {
      timers.clearTimeout(timer);
      reject(new CancelledError());
    });
  });
}

/** Settles with `p`, or rejects as soon as the signal is cancelled (whatever `p` does). */
function untilCancelled<T>(p: Promise<T>, signal: CancelSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const off = signal.onCancel(() => reject(new CancelledError()));
    p.then(
      (v) => {
        off();
        resolve(v);
      },
      (e: unknown) => {
        off();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Whether a status is worth trying again later. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 408;
}

function statusMessage(status: number): string {
  if (status === 429)
    return 'The map server is busy (too many requests). Try again in a few minutes.';
  if (status >= 500)
    return `The map server is not available right now (HTTP ${status}). Try again later.`;
  if (status === 400) return 'The map server did not accept the query (HTTP 400).';
  return `The map server answered HTTP ${status}.`;
}

/** Fetches, builds and bounds the scenery of a route. Never throws. */
export async function fetchScenery(
  track: RouteTrack,
  options: FetchSceneryOptions,
): Promise<FetchSceneryResult> {
  const signal = options.signal ?? NEVER;
  const sleep = options.sleep ?? cancellableSleep;
  const now = options.now ?? Date.now;
  const retries = options.retries ?? 4;
  const backoff = options.backoffMs ?? 5_000;
  const maxBackoff = options.maxBackoffMs ?? 120_000;
  const pause = options.pauseMs ?? 1_000;
  const chunks = sceneryChunks(track, options);
  const builder = new SceneryBuilder(
    track,
    options.corridorM ? { corridorM: options.corridorM } : {},
  );
  const progress = (p: SceneryProgress): void => {
    try {
      options.onProgress?.(p);
    } catch {
      // the UI's trouble does not stop the fetch
    }
  };
  let requests = 0;
  const cancelled = (): FetchSceneryResult => ({
    ok: false,
    cancelled: true,
    error: 'Cancelled.',
    requests,
  });
  try {
    for (let c = 0; c < chunks.length; c++) {
      progress({ done: c, total: chunks.length, phase: 'fetching' });
      if (c > 0 && pause > 0) await sleep(pause, signal);
      const query = overpassQuery(chunks[c]!);
      let lastError = '';
      let done = false;
      for (let attempt = 0; attempt <= retries && !done; attempt++) {
        if (signal.cancelled) return cancelled();
        if (attempt > 0) {
          progress({ done: c, total: chunks.length, phase: 'fetching' });
        }
        let waitS: number | null = null;
        try {
          requests++;
          const res = await untilCancelled(options.transport(query, signal), signal);
          if (signal.cancelled) return cancelled();
          if (res.status === 200) {
            const parsed = parseOverpassJson(res.text);
            if (parsed.ok) {
              builder.add(parsed.elements);
              done = true;
              break;
            }
            lastError = parsed.error;
            if (!parsed.retry) return { ok: false, cancelled: false, error: lastError, requests };
          } else {
            lastError = statusMessage(res.status);
            if (!isRetryableStatus(res.status))
              return { ok: false, cancelled: false, error: lastError, requests };
            if (typeof res.retryAfterS === 'number' && Number.isFinite(res.retryAfterS))
              waitS = Math.max(0, res.retryAfterS);
          }
        } catch (err) {
          if (signal.cancelled || err instanceof CancelledError) return cancelled();
          lastError = `The map server could not be reached (${err instanceof Error ? err.message : String(err)}).`;
        }
        if (attempt === retries) break;
        const ms = Math.min(maxBackoff, waitS !== null ? waitS * 1000 : backoff * 2 ** attempt);
        progress({ done: c, total: chunks.length, phase: 'waiting', waitS: Math.ceil(ms / 1000) });
        await sleep(ms, signal);
      }
      if (!done)
        return {
          ok: false,
          cancelled: false,
          error: `${lastError} (gave up after ${retries + 1} tries)`,
          requests,
        };
    }
    if (signal.cancelled) return cancelled();
    progress({ done: chunks.length, total: chunks.length, phase: 'building' });
    const { model, text } = builder.finish(now());
    return {
      ok: true,
      model,
      text,
      summary: summarizeScenery(model, utf8ByteLength(text)),
      requests,
    };
  } catch (err) {
    if (signal.cancelled || err instanceof CancelledError) return cancelled();
    return {
      ok: false,
      cancelled: false,
      error: `Building the scenery failed (${err instanceof Error ? err.message : String(err)}).`,
      requests,
    };
  }
}
