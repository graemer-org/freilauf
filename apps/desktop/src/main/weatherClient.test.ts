import { OVERPASS_USER_AGENT, weatherQuery } from '@freilauf/routes';
import { describe, expect, it } from 'vitest';
import { type GetLike, WeatherClient, isWeatherQuery } from './weatherClient';

function fakeFetch(answer: () => Promise<{ status: number; body: string; retryAfter?: string }>) {
  const calls: { url: string; init: Parameters<GetLike>[1] }[] = [];
  const fetch: GetLike = async (url, init) => {
    calls.push({ url, init });
    const a = await answer();
    return {
      status: a.status,
      headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? (a.retryAfter ?? null) : null) },
      text: async () => a.body,
    };
  };
  return { fetch, calls };
}

const QUERY = weatherQuery([{ lat: 47.5, lon: 11.4 }], '2025-06-13', '2025-06-15');

describe('WeatherClient (main process)', () => {
  it('GETs the configured archive with the query and the generic User-Agent only', async () => {
    const { fetch, calls } = fakeFetch(async () => ({ status: 200, body: '{}', retryAfter: '3' }));
    const c = new WeatherClient({
      fetch,
      endpoint: () => 'https://archive.example.org/v1/archive',
    });
    const r = await c.query('r1', QUERY);
    expect(r).toEqual({ status: 200, text: '{}', retryAfterS: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://archive.example.org/v1/archive?${QUERY}`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers).toEqual({
      'User-Agent': OVERPASS_USER_AGENT,
      Accept: 'application/json',
    });
    expect(c.inFlight).toBe(0);
  });

  it('refuses another endpoint scheme and queries that are not the archive’s parameters', async () => {
    const { fetch, calls } = fakeFetch(async () => ({ status: 200, body: '{}' }));
    const bad = new WeatherClient({ fetch, endpoint: () => 'http://evil.example.org/' });
    await expect(bad.query('r', QUERY)).rejects.toThrow(/weather server address/);
    const c = new WeatherClient({
      fetch,
      endpoint: () => 'https://archive.example.org/v1/archive',
    });
    await expect(c.query('r', 'apikey=secret')).rejects.toThrow(/invalid query/);
    await expect(c.query('r', `${QUERY}&x=1`)).rejects.toThrow(/invalid query/);
    await expect(c.query('r', 'latitude=1#frag')).rejects.toThrow(/invalid query/);
    expect(calls).toHaveLength(0);
    expect(isWeatherQuery(QUERY)).toBe(true);
  });

  it('cancels and times out', async () => {
    const never: GetLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const c = new WeatherClient({
      fetch: never,
      endpoint: () => 'https://archive.example.org/v1/archive',
      timeoutMs: 20,
    });
    const pending = c.query('a', QUERY);
    c.cancel('a');
    await expect(pending).rejects.toThrow('cancelled');
    await expect(c.query('b', QUERY)).rejects.toThrow('timed out');
  });
});
