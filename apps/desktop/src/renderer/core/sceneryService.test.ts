import { buildRoute, unproject } from '@freilauf/routes';
import { describe, expect, it } from 'vitest';
import type { FreilaufApi, OverpassReply } from '../../shared/contract';
import { SceneryService, type SceneryStatus } from './sceneryService';

const road = (lon0: number) =>
  buildRoute({
    name: `Road ${lon0}`,
    points: Array.from({ length: 101 }, (_, i) => ({
      ...unproject({ lat0: 47, lon0 }, 0, i * 10),
      ele: 0,
    })),
    hasElevation: true,
  });

function fakeApi(reply: (q: string) => Promise<OverpassReply>) {
  const files = new Map<string, string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const cancelled: string[] = [];
  const api: FreilaufApi['scenery'] = {
    overpass: async (_id, q) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await reply(q);
      } finally {
        inFlight--;
      }
    },
    cancelOverpass: (id) => void cancelled.push(id),
    load: async (id) => files.get(id) ?? null,
    save: async (id, t) => void files.set(id, t),
    remove: async (id) => void files.delete(id),
    list: async () => [...files].map(([routeId, t]) => ({ routeId, bytes: t.length })),
  };
  return { api, files, cancelled, max: () => maxInFlight };
}

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('SceneryService', () => {
  it('runs one fetch at a time across routes and stores each', async () => {
    const f = fakeApi(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { status: 200, text: '{"elements":[]}', retryAfterS: null };
    });
    const seen: Record<string, SceneryStatus>[] = [];
    const s = new SceneryService({
      api: f.api,
      log,
      onStatus: (st) => seen.push(st),
      onNotice: () => undefined,
      fetchOptions: { pauseMs: 0 },
    });
    const a = road(9);
    const b = road(10);
    s.load(a);
    s.load(b);
    s.load(a); // already queued: ignored
    expect(s.status(b.id).state).toBe('queued');
    await settle();
    expect(f.max()).toBe(1);
    expect([...f.files.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(s.status(a.id)).toMatchObject({ state: 'ready' });
    expect(seen.some((x) => x[a.id]?.state === 'loading')).toBe(true);
    expect((await s.model(a.id))?.routeId).toBe(a.id);
  });

  it('reports a refused query as an error, keeps what was stored on cancel', async () => {
    const notices: string[] = [];
    const f = fakeApi(async () => ({ status: 400, text: 'bad', retryAfterS: null }));
    const s = new SceneryService({
      api: f.api,
      log,
      onStatus: () => undefined,
      onNotice: (_k, m) => void notices.push(m),
      fetchOptions: { pauseMs: 0 },
    });
    const a = road(11);
    s.load(a);
    await settle();
    expect(s.status(a.id)).toMatchObject({ state: 'error' });
    expect(notices[0]).toMatch(/not loaded: The map server did not accept the query/);

    const hang = fakeApi(() => new Promise(() => undefined));
    const s2 = new SceneryService({
      api: hang.api,
      log,
      onStatus: () => undefined,
      onNotice: () => undefined,
    });
    s2.load(a);
    await settle();
    expect(s2.status(a.id).state).toBe('loading');
    s2.cancel(a.id);
    await settle();
    expect(hang.cancelled).toHaveLength(1); // the request in flight is aborted
    expect(s2.status(a.id).state).toBe('none');
  });
});
