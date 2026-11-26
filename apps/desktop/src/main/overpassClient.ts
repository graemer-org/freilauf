/**
 * The app's one outgoing HTTP request (docs/adr/0011-osm-scenery.md): an Overpass query for a
 * route's scenery, sent from the main process so the renderer's CSP stays closed and the
 * request carries a generic User-Agent naming the app (nothing about the rider). Only POSTs to
 * the endpoint in the settings; one request at a time is the renderer's job (sceneryFetch).
 * The fetch implementation is injected (Electron's net.fetch in the app; a fake in tests).
 */
import { OVERPASS_USER_AGENT, overpassBody } from '@freilauf/routes';
import type { OverpassReply } from '../shared/contract';
import { isOverpassUrl } from './settings';

/** The subset of fetch used here. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

/** Longest answer accepted (bytes); a corridor query is far below that. */
export const MAX_OVERPASS_BYTES = 64 * 1024 * 1024;
/** Client-side limit per request: the server's own limit (90 s) plus transfer time. */
export const OVERPASS_CLIENT_TIMEOUT_MS = 150_000;
/** Longest query text accepted from the renderer. */
export const MAX_QUERY_CHARS = 20_000;

/** Retry-After in seconds (a number or an HTTP date), or null. */
export function retryAfterSeconds(v: string | null, now = Date.now()): number | null {
  if (!v) return null;
  const n = Number(v.trim());
  if (Number.isFinite(n) && n >= 0) return Math.min(3600, n);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.min(3600, (t - now) / 1000)) : null;
}

async function readLimited(res: Awaited<ReturnType<FetchLike>>, limit: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (text.length > limit) throw new Error('answer too large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('answer too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export class OverpassClient {
  readonly #fetch: FetchLike;
  readonly #endpoint: () => string;
  readonly #log: (m: string) => void;
  readonly #timeoutMs: number;
  readonly #inFlight = new Map<string, AbortController>();

  constructor(options: {
    fetch: FetchLike;
    endpoint: () => string;
    log?: (m: string) => void;
    timeoutMs?: number;
  }) {
    this.#fetch = options.fetch;
    this.#endpoint = options.endpoint;
    this.#log = options.log ?? (() => undefined);
    this.#timeoutMs = options.timeoutMs ?? OVERPASS_CLIENT_TIMEOUT_MS;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  async query(requestId: string, query: string): Promise<OverpassReply> {
    const url = this.#endpoint();
    if (!isOverpassUrl(url)) throw new Error('No valid map server address is set.');
    if (typeof query !== 'string' || query.length === 0 || query.length > MAX_QUERY_CHARS)
      throw new Error('invalid query');
    this.#inFlight.get(requestId)?.abort();
    const ctl = new AbortController();
    this.#inFlight.set(requestId, ctl);
    const timer = setTimeout(() => ctl.abort(new Error('timed out')), this.#timeoutMs);
    const started = Date.now();
    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': OVERPASS_USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
        },
        body: overpassBody(query),
        signal: ctl.signal,
      });
      const text = await readLimited(res, MAX_OVERPASS_BYTES);
      this.#log(
        `overpass ${res.status} in ${Date.now() - started} ms, ${Math.round(text.length / 1024)} KB`,
      );
      return {
        status: res.status,
        text,
        retryAfterS: retryAfterSeconds(res.headers.get('retry-after')),
      };
    } catch (e) {
      const reason = ctl.signal.aborted
        ? ctl.signal.reason instanceof Error
          ? ctl.signal.reason.message
          : 'cancelled'
        : e instanceof Error
          ? e.message
          : String(e);
      this.#log(`overpass request failed: ${reason}`);
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
      if (this.#inFlight.get(requestId) === ctl) this.#inFlight.delete(requestId);
    }
  }

  cancel(requestId: string): void {
    const ctl = this.#inFlight.get(requestId);
    if (!ctl) return;
    ctl.abort(new Error('cancelled'));
    this.#inFlight.delete(requestId);
  }

  cancelAll(): void {
    for (const id of [...this.#inFlight.keys()]) this.cancel(id);
  }
}
