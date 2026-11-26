import { OVERPASS_USER_AGENT } from '@freilauf/routes';
import { describe, expect, it } from 'vitest';
import { type FetchLike, OverpassClient, retryAfterSeconds } from './overpassClient';

function fakeFetch(
  answer: (
    url: string,
    init: Parameters<FetchLike>[1],
  ) => Promise<{ status: number; body: string; retryAfter?: string }>,
) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const a = await answer(url, init);
    return {
      status: a.status,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'retry-after' ? (a.retryAfter ?? null) : null),
      },
      text: async () => a.body,
    };
  };
  return { fetch, calls };
}

describe('OverpassClient (main process)', () => {
  it('POSTs the form-encoded query to the configured endpoint with a generic User-Agent', async () => {
    const { fetch, calls } = fakeFetch(async () => ({ status: 200, body: '{"elements":[]}' }));
    const c = new OverpassClient({
      fetch,
      endpoint: () => 'https://overpass.example.org/api/interpreter',
    });
    const r = await c.query('r1', '[out:json];node(1);out;');
    expect(r).toEqual({ status: 200, text: '{"elements":[]}', retryAfterS: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://overpass.example.org/api/interpreter');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers['User-Agent']).toBe(OVERPASS_USER_AGENT);
    expect(OVERPASS_USER_AGENT).not.toMatch(/@|https?:/); // nothing personal, no contact
    expect(calls[0]!.init.body).toBe(`data=${encodeURIComponent('[out:json];node(1);out;')}`);
    expect(c.inFlight).toBe(0);
  });

  it('passes the status and Retry-After on', async () => {
    const { fetch } = fakeFetch(async () => ({ status: 429, body: 'slow down', retryAfter: '30' }));
    const c = new OverpassClient({ fetch, endpoint: () => 'https://o.example/api' });
    expect(await c.query('r', 'q')).toEqual({ status: 429, text: 'slow down', retryAfterS: 30 });
    expect(
      retryAfterSeconds(
        'Wed, 21 Oct 2015 07:28:30 GMT',
        Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'),
      ),
    ).toBe(30);
    expect(retryAfterSeconds('soon')).toBeNull();
  });

  it('refuses an endpoint that is not https (or this computer) and odd queries', async () => {
    const { fetch, calls } = fakeFetch(async () => ({ status: 200, body: '' }));
    const c = new OverpassClient({ fetch, endpoint: () => 'http://overpass.example.org/api' });
    await expect(c.query('r', 'q')).rejects.toThrow(/map server/);
    const ok = new OverpassClient({ fetch, endpoint: () => 'https://o.example/api' });
    await expect(ok.query('r', '')).rejects.toThrow(/invalid query/);
    await expect(ok.query('r', 'x'.repeat(30_000))).rejects.toThrow(/invalid query/);
    expect(calls).toHaveLength(0);
  });

  it('cancels a request and times out a hanging one', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const c = new OverpassClient({ fetch: hang, endpoint: () => 'https://o.example/api' });
    const p = c.query('r1', 'q');
    expect(c.inFlight).toBe(1);
    c.cancel('r1');
    await expect(p).rejects.toThrow(/cancelled/);
    expect(c.inFlight).toBe(0);
    const slow = new OverpassClient({
      fetch: hang,
      endpoint: () => 'https://o.example/api',
      timeoutMs: 20,
    });
    await expect(slow.query('r2', 'q')).rejects.toThrow(/timed out/);
  });
});
