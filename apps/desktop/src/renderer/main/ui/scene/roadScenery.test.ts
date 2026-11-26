/**
 * Scenery in the road view: culling, level of detail and the per-frame budget (roadScenery.ts),
 * and the draw cost of a dense town measured through RoadRenderer on a recording stub canvas
 * (the geometry and path building; rasterising is the browser's, measured in the e2e test).
 */
import { emptyScenery, type SceneryBuilding, type SceneryModel } from '@freilauf/routes';
import { describe, expect, it } from 'vitest';
import { buildPalette } from './palette';
import { anchorCamera, cameraFor, RoadStrip, riderLateralM, viewportFor } from './roadMath';
import { RoadRenderer, type RoadFrame } from './roadRender';
import { SCENERY_LIMITS, SceneryFrame, stretchBand } from './roadScenery';
import { gradeSigns } from './routeSample';
import { syntheticTrack } from './testTrack';

const track = syntheticTrack([
  { lengthM: 800 },
  { lengthM: 400, turnDeg: 70, gradePercent: 3 },
  { lengthM: 2000, turnDeg: -30 },
]);

const house = (alongM: number, offsetM: number, over: Partial<SceneryBuilding> = {}) => ({
  alongM,
  offsetM,
  lengthM: 10,
  depthM: 8,
  heightM: 6,
  kind: 'house' as const,
  ...over,
});

/** A town: 2000 buildings in rows on both sides over 2.5 km. */
function denseTown(): SceneryModel {
  const buildings: SceneryBuilding[] = [];
  for (let i = 0; i < 2000; i++) {
    const row = i % 4;
    const side = row % 2 ? 1 : -1;
    buildings.push(
      house(200 + Math.floor(i / 4) * 5, side * (12 + Math.floor(row / 2) * 30), {
        kind: i % 37 === 0 ? 'church' : i % 11 === 0 ? 'apartments' : 'house',
        heightM: i % 11 === 0 ? 15 : 6,
      }),
    );
  }
  return {
    ...emptyScenery(track.id, track.totalDistanceM, false),
    buildings,
    ground: [
      { kind: 'residential', side: -1, fromM: 150, toM: 2150, nearM: 6, farM: 150 },
      { kind: 'forest', side: 1, fromM: 2800, toM: 3150, nearM: 8, farM: 150 },
    ],
    water: [{ kind: 'river', side: 1, fromM: 150, toM: 2000, nearM: 70, farM: 90 }],
    places: [{ name: 'Großstadt', kind: 'town', alongM: 190 }],
    structures: [{ kind: 'bridge', fromM: 900, toM: 960 }],
  };
}

function frameAt(d: number, width = 1440, height = 620) {
  const vp = viewportFor(width, height);
  const cam = cameraFor(track, d, riderLateralM(0));
  anchorCamera(vp, cam, riderLateralM(0));
  const strip = new RoadStrip();
  strip.build(track, vp, cam);
  return { vp, cam, strip };
}

describe('SceneryFrame: culling and level of detail', () => {
  it('keeps what is ahead and on screen, far to near, with less detail far out', () => {
    const { vp, cam, strip } = frameAt(100);
    const m: SceneryModel = {
      ...emptyScenery(track.id, track.totalDistanceM, false),
      buildings: [
        house(50, 15), // behind the rider
        house(130, 15),
        house(130, -15),
        house(300, 20),
        house(500, -20),
        house(600, 20),
        house(1500, 20), // beyond the road drawn ahead
      ],
    };
    const sf = new SceneryFrame();
    sf.update(m, strip, vp, cam, 6);
    const along = sf.buildings.map((b) => b.b.alongM);
    expect(along).toEqual([600, 500, 300, 130, 130]);
    for (let i = 1; i < sf.buildings.length; i++)
      expect(sf.buildings[i]!.depth).toBeLessThanOrEqual(sf.buildings[i - 1]!.depth);
    const lod = (a: number) => sf.buildings.find((b) => b.b.alongM === a)!.lod;
    expect(lod(130)).toBe(0); // windows
    expect(lod(300)).toBe(1);
    expect(lod(600)).toBe(2); // silhouette
    // The near wall faces the road: inner wall nearer the centre than the outer one.
    for (const b of sf.buildings) expect(Math.abs(b.li)).toBeLessThan(Math.abs(b.lo));
  });

  it('cuts a building the rider is passing at the rider, and skips tiny or off-screen ones', () => {
    const { vp, cam, strip } = frameAt(100);
    const m: SceneryModel = {
      ...emptyScenery(track.id, track.totalDistanceM, false),
      buildings: [
        house(100, 14, { lengthM: 40 }), // alongside
        house(400, 140, { heightM: 2.5, depthM: 3, lengthM: 3 }), // far out, small: still > 1.5 px
        house(140, 400), // way off to the side: off screen
      ],
    };
    const sf = new SceneryFrame();
    sf.update(m, strip, vp, cam, 6);
    const passing = sf.buildings.find((b) => b.b.alongM === 100)!;
    expect(passing.a0).toBeCloseTo(101, 5);
    expect(sf.buildings.some((b) => b.b.offsetM === 400)).toBe(false);
  });

  it('stays within the per-frame budget in a dense town, nearest first', () => {
    const { vp, cam, strip } = frameAt(600);
    const sf = new SceneryFrame();
    const limits = { ...SCENERY_LIMITS, maxBuildings: 150 };
    sf.update(denseTown(), strip, vp, cam, 6, limits);
    expect(sf.candidates).toBeGreaterThan(150);
    expect(sf.buildings).toHaveLength(150);
    const kept = Math.max(...sf.buildings.map((b) => b.depth));
    expect(kept).toBeLessThan(400);
  });

  it('wraps a loop: buildings near the start appear ahead at the end of a lap', () => {
    const loop = syntheticTrack([{ lengthM: 1000, turnDeg: 360 }], { loop: true });
    const vp = viewportFor(1000, 500);
    const cam = cameraFor(loop, 950, riderLateralM(0));
    const strip = new RoadStrip();
    strip.build(loop, vp, cam);
    const m: SceneryModel = {
      ...emptyScenery(loop.id, loop.totalDistanceM, true),
      buildings: [house(40, 15)],
      ground: [{ kind: 'forest', side: -1, fromM: 0, toM: 100, nearM: 8, farM: 60 }],
    };
    const sf = new SceneryFrame();
    sf.update(m, strip, vp, cam, 6);
    expect(sf.buildings.map((b) => Math.round(b.a0))).toEqual([1035]);
    expect(sf.ground.map((g) => g.from)).toEqual([1000]);
    expect(sf.coverAt(1050, -1)).toBe('forest');
    expect(sf.coverAt(1050, 1)).toBeNull();
  });

  it('keeps land cover off the asphalt and verge', () => {
    expect(stretchBand({ kind: 'meadow', side: 1, fromM: 0, toM: 10, nearM: 0, farM: 40 })).toEqual(
      [4.5, 40],
    );
    expect(
      stretchBand({ kind: 'meadow', side: -1, fromM: 0, toM: 10, nearM: 10, farM: 40 }),
    ).toEqual([-40, -10]);
  });
});

// ───────────── drawing on a stub canvas ─────────────

interface Recorder {
  ctx: CanvasRenderingContext2D;
  counts: Record<string, number>;
}

function recordingContext(): Recorder {
  const counts: Record<string, number> = {};
  const gradient = { addColorStop: () => undefined };
  const target: Record<string, unknown> = {
    measureText: (t: string) => ({ width: t.length * 7 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    getLineDash: () => [],
  };
  const ctx = new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key];
      return (..._args: unknown[]) => {
        counts[key] = (counts[key] ?? 0) + 1;
      };
    },
    set(t, key: string, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, counts };
}

function renderer(w = 1440, h = 620) {
  const rec = recordingContext();
  const canvas = { width: 0, height: 0, getContext: () => rec.ctx } as unknown as HTMLCanvasElement;
  const r = new RoadRenderer(canvas);
  r.resize(w, h, 2);
  r.setPalette(
    buildPalette({
      surface: '#16181c',
      text: '#eceef2',
      text2: '#a0a4ad',
      text3: '#6b6f78',
      accent: '#5b9cff',
    }),
    'system-ui',
  );
  return { r, rec };
}

function roadFrame(d: number, scenery: SceneryModel | null): RoadFrame {
  return {
    track,
    camera: cameraFor(track, d, riderLateralM(0)),
    state: 'riding',
    riderX: riderLateralM(0),
    lean: 0,
    crank: 1,
    standing: 0,
    tuck: 0,
    gradeLabel: 0,
    next: null,
    signs: gradeSigns(track),
    finishM: track.totalDistanceM,
    others: [],
    reducedMotion: false,
    scenery,
  };
}

describe('RoadRenderer with scenery', () => {
  it('draws buildings, woods, water and the town sign, and reports what it drew', () => {
    const { r, rec } = renderer();
    r.draw(roadFrame(150, denseTown()));
    expect(r.sceneryShown).toBe(true);
    expect(r.drawnBuildings).toBeGreaterThan(100);
    expect(r.drawnBuildings).toBeLessThanOrEqual(SCENERY_LIMITS.maxBuildings);
    expect(rec.counts.fillText).toBeGreaterThan(0); // the town's name, the grade label
    r.draw(roadFrame(2700, denseTown()));
    expect(r.drawnTrees).toBeGreaterThan(20); // the forest ahead
    r.draw(roadFrame(150, null));
    expect(r.sceneryShown).toBe(false);
    expect(r.drawnBuildings).toBe(0);
  });

  it('frame budget: a 2000-building town costs a few ms of script per frame', () => {
    const town = denseTown();
    const { r, rec } = renderer();
    const plain = renderer();
    // Warm up (JIT), then measure a ride through the town at 12 m/s, 60 fps.
    for (let i = 0; i < 30; i++) {
      r.draw(roadFrame(150 + i * 0.2, town));
      plain.r.draw(roadFrame(150 + i * 0.2, null));
    }
    const time = (
      rr: RoadRenderer,
      scenery: SceneryModel | null,
    ): { mean: number; p95: number } => {
      const ms: number[] = [];
      for (let i = 0; i < 400; i++) {
        const t0 = performance.now();
        rr.draw(roadFrame(160 + i * 0.2 * 10, scenery));
        ms.push(performance.now() - t0);
      }
      ms.sort((a, b) => a - b);
      return {
        mean: ms.reduce((a, b) => a + b, 0) / ms.length,
        p95: ms[Math.floor(ms.length * 0.95)]!,
      };
    };
    const withTown = time(r, town);
    const without = time(plain.r, null);
    console.info(
      `road view draw (script only): without scenery ${without.mean.toFixed(2)} ms mean / ${without.p95.toFixed(2)} ms p95; ` +
        `2000-building town ${withTown.mean.toFixed(2)} ms mean / ${withTown.p95.toFixed(2)} ms p95; ` +
        `${r.drawnBuildings} buildings in the last frame, ${rec.counts.fill ?? 0} fills over all frames`,
    );
    // Generous for slow CI machines; a frame at 60 fps has 16.7 ms.
    expect(withTown.mean).toBeLessThan(8);
    expect(withTown.p95).toBeLessThan(16);
  });
});
