import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyScenery, encodeScenery } from '@freilauf/routes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_OVERPASS_URL as ROUTES_DEFAULT } from '@freilauf/routes';
import { DEFAULT_OVERPASS_URL, DEFAULT_SETTINGS } from '../shared/contract';
import { SceneryStore, isRouteId } from './sceneryStore';
import { isOverpassUrl, sanitizeSettings } from './settings';

const text = (routeId: string, houses = 2): string =>
  encodeScenery({
    ...emptyScenery(routeId, 5000, false),
    fetchedAt: 1,
    buildings: Array.from({ length: houses }, (_, i) => ({
      alongM: 100 + i * 20,
      offsetM: 15,
      lengthM: 10,
      depthM: 8,
      heightM: 6,
      kind: 'house' as const,
    })),
  });

describe('SceneryStore', () => {
  let dir: string;
  let warnings: string[];
  let store: SceneryStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-scenery-'));
    warnings = [];
    store = new SceneryStore(path.join(dir, 'scenery'), (m) => warnings.push(m));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips a route’s scenery and lists it', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.load('route-abc')).toBeNull();
    const t = text('route-abc');
    await store.save('route-abc', t);
    expect(await store.load('route-abc')).toBe(t);
    expect(await store.list()).toEqual([{ routeId: 'route-abc', bytes: Buffer.byteLength(t) }]);
    await store.save('route-abc', text('route-abc', 5)); // replaced
    expect(await store.load('route-abc')).toBe(text('route-abc', 5));
    await store.remove('route-abc');
    expect(await store.load('route-abc')).toBeNull();
    await store.remove('route-abc'); // twice is fine
  });

  it('refuses invalid text, another route’s scenery and unsafe ids', async () => {
    await expect(store.save('route-abc', '{"nope":1}')).rejects.toThrow(/invalid scenery/);
    await expect(store.save('route-abc', text('route-xyz'))).rejects.toThrow(/another route/);
    await expect(store.save('../evil', text('route-abc'))).rejects.toThrow();
    expect(isRouteId('../evil')).toBe(false);
    expect(isRouteId('Route')).toBe(false);
    expect(isRouteId('route-1ee9pdbr2kyun')).toBe(true);
  });

  it('ignores a corrupt file instead of failing', async () => {
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'route-abc.json'), 'garbage');
    expect(await store.load('route-abc')).toBeNull();
    expect(warnings.join(' ')).toMatch(/unreadable/);
  });
});

describe('scenery settings', () => {
  it('defaults to on with the public server, the same address as the client', () => {
    expect(DEFAULT_SETTINGS.scenery).toEqual({ enabled: true, overpassUrl: DEFAULT_OVERPASS_URL });
    expect(DEFAULT_OVERPASS_URL).toBe(ROUTES_DEFAULT);
    expect(sanitizeSettings({}).scenery).toEqual(DEFAULT_SETTINGS.scenery);
  });

  it('accepts https and a server on this computer only', () => {
    expect(isOverpassUrl('https://overpass.example.org/api/interpreter')).toBe(true);
    expect(isOverpassUrl('http://localhost:12345/api/interpreter')).toBe(true);
    expect(isOverpassUrl('http://127.0.0.1/api')).toBe(true);
    expect(isOverpassUrl('http://overpass.example.org/api')).toBe(false);
    expect(isOverpassUrl('https://user:pw@overpass.example.org/')).toBe(false);
    expect(isOverpassUrl('ftp://x')).toBe(false);
    expect(isOverpassUrl('javascript:alert(1)')).toBe(false);
    const problems: string[] = [];
    const s = sanitizeSettings(
      { scenery: { enabled: false, overpassUrl: 'http://evil.example' } },
      DEFAULT_SETTINGS,
      problems,
    );
    expect(s.scenery).toEqual({ enabled: false, overpassUrl: DEFAULT_OVERPASS_URL });
    expect(problems.join(' ')).toMatch(/scenery.overpassUrl/);
    expect(sanitizeSettings({ scenery: { overpassUrl: '' } }).scenery.overpassUrl).toBe(
      DEFAULT_OVERPASS_URL,
    );
  });
});
