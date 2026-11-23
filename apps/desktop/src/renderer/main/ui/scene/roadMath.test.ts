import { describe, expect, it } from 'vitest';
import {
  anchorCamera,
  CAMERA,
  cameraFor,
  createScreenPoint,
  curveLean,
  fogLevel,
  horizonLine,
  otherLateralM,
  project,
  ROAD,
  ROAD_FAR_M,
  RoadStrip,
  riderLateralM,
  viewportFor,
} from './roadMath';
import { syntheticTrack } from './testTrack';

const vp = viewportFor(1000, 500);

function stripFor(track: ReturnType<typeof syntheticTrack>, d: number, lateral = 0) {
  const cam = cameraFor(track, d, lateral);
  const strip = new RoadStrip();
  strip.build(track, vp, cam);
  return { cam, strip };
}

describe('project', () => {
  it('puts a level point at infinity on the horizon, centred', () => {
    const cam = { distanceM: 0, yaw: 0, pitch: 0, x: 0, elevationM: 0, offsetY: 0 };
    const p = project(vp, cam, 0, CAMERA.heightM, 1e9, createScreenPoint());
    expect(p.x).toBeCloseTo(vp.cx, 3);
    expect(p.y).toBeCloseTo(vp.horizonY, 3);
    expect(horizonLine(vp, cam)).toBe(vp.horizonY);
  });

  it('moves the horizon down when the camera pitches up', () => {
    const cam = { distanceM: 0, yaw: 0, pitch: 0.1, x: 0, elevationM: 0, offsetY: 0 };
    expect(horizonLine(vp, cam)).toBeGreaterThan(vp.horizonY);
  });
});

describe('anchorCamera', () => {
  it('keeps the rider at the same screen height on a climb and on the flat', () => {
    const up = syntheticTrack([{ lengthM: 1000, gradePercent: 9 }]);
    const flat = syntheticTrack([{ lengthM: 1000 }]);
    for (const t of [up, flat]) {
      const cam = cameraFor(t, 500, 1.3);
      anchorCamera(vp, cam, 1.3);
      const p = project(vp, cam, 1.3, 0, 0, createScreenPoint());
      expect(p.y).toBeCloseTo(vp.riderY, 6);
    }
    // Climbing, the road ahead rises well above the horizon.
    const a = cameraFor(up, 500, 0);
    anchorCamera(vp, a, 0);
    const strip = new RoadStrip();
    strip.build(up, vp, a);
    expect(strip.sy[strip.count - 1]!).toBeLessThan(horizonLine(vp, a) - vp.height * 0.1);
  });
});

describe('RoadStrip on a straight flat road', () => {
  const track = syntheticTrack([{ lengthM: 2000 }]);
  const { cam, strip } = stripFor(track, 500);
  const l = createScreenPoint();
  const r = createScreenPoint();

  it('is a symmetric trapezoid that converges at the horizon', () => {
    let prevWidth = Number.POSITIVE_INFINITY;
    let prevY = Number.POSITIVE_INFINITY;
    for (let k = 0; k < strip.count; k++) {
      strip.edge(vp, cam, k, -ROAD.halfWidthM, l);
      strip.edge(vp, cam, k, ROAD.halfWidthM, r);
      expect((l.x + r.x) / 2).toBeCloseTo(vp.cx, 6);
      expect(l.y).toBeCloseTo(r.y, 6);
      const width = r.x - l.x;
      expect(width).toBeLessThan(prevWidth);
      expect(l.y).toBeLessThan(prevY);
      expect(l.y).toBeGreaterThan(vp.horizonY);
      prevWidth = width;
      prevY = l.y;
    }
    // At the far end the road is a sliver just under the horizon.
    expect(prevWidth).toBeLessThan(vp.width * 0.05);
    expect(prevY - vp.horizonY).toBeLessThan(vp.height * 0.02);
  });

  it('is fully visible and reaches the far distance', () => {
    for (let k = 1; k < strip.count; k++) expect(strip.visible[k]).toBe(1);
    expect(strip.s[strip.count - 1]! - 500).toBeGreaterThanOrEqual(ROAD_FAR_M - 20);
    // Fills the bottom of the screen near the rider.
    strip.edge(vp, cam, 0, 0, l);
    expect(l.y).toBeGreaterThan(vp.height);
  });

  it('interpolates points over the whole strip, including its first boundary', () => {
    const p = createScreenPoint();
    expect(strip.pointAt(vp, cam, strip.s[0]!, 0, 0, p)).toBe(1);
    expect(p.y).toBeGreaterThan(vp.height);
    expect(strip.pointAt(vp, cam, strip.s[0]! - 1, 0, 0, p)).toBe(0);
    expect(strip.pointAt(vp, cam, strip.s[strip.count - 1]! + 1, 0, 0, p)).toBe(0);
    expect(strip.pointAt(vp, cam, 510, 0, 0, p)).toBeGreaterThan(1);
  });

  it('keeps segment boundaries on a fixed grid of route distance', () => {
    const a = stripFor(track, 500).strip;
    const b = stripFor(track, 501.3).strip;
    const grid = (st: RoadStrip) => Array.from(st.s.subarray(1, 10));
    expect(grid(a).every((s) => Math.abs(s / 4 - Math.round(s / 4)) < 1e-9)).toBe(true);
    // Boundaries common to both strips are the same numbers.
    const common = grid(b).filter((s) => grid(a).includes(s));
    expect(common.length).toBeGreaterThan(5);
  });
});

describe('RoadStrip in bends', () => {
  it('bends right, monotonically, on a constant right curve', () => {
    const track = syntheticTrack([
      { lengthM: 300 },
      { lengthM: 400, turnDeg: 90 },
      { lengthM: 800 },
    ]);
    const { cam, strip } = stripFor(track, 300);
    const p = createScreenPoint();
    let prev = Number.NEGATIVE_INFINITY;
    let last = 0;
    for (let k = 1; k < strip.count; k++) {
      if (strip.s[k]! < 310 || strip.s[k]! > 600) continue;
      strip.edge(vp, cam, k, 0, p);
      expect(p.x).toBeGreaterThan(prev);
      prev = p.x;
      last = p.x;
    }
    expect(last).toBeGreaterThan(vp.cx + vp.width * 0.1);
  });

  it('bends left on a left curve (mirror image)', () => {
    const right = syntheticTrack([
      { lengthM: 300 },
      { lengthM: 300, turnDeg: 60 },
      { lengthM: 800 },
    ]);
    const left = syntheticTrack([
      { lengthM: 300 },
      { lengthM: 300, turnDeg: -60 },
      { lengthM: 800 },
    ]);
    const a = stripFor(right, 320);
    const b = stripFor(left, 320);
    const pa = createScreenPoint();
    const pb = createScreenPoint();
    for (let k = 0; k < a.strip.count; k++) {
      a.strip.edge(vp, a.cam, k, 0, pa);
      b.strip.edge(vp, b.cam, k, 0, pb);
      expect(pa.x - vp.cx).toBeCloseTo(vp.cx - pb.x, 6);
      expect(pa.y).toBeCloseTo(pb.y, 6);
    }
  });

  it('keeps depth growing through a hairpin', () => {
    const track = syntheticTrack([
      { lengthM: 100 },
      { lengthM: 60, turnDeg: 180 },
      { lengthM: 600 },
    ]);
    const { strip } = stripFor(track, 90);
    for (let k = 1; k < strip.count; k++) expect(strip.Z[k]!).toBeGreaterThan(strip.Z[k - 1]!);
    // The road sweeps off to the right and keeps going that way.
    for (let k = 2; k < strip.count; k++) {
      if (strip.s[k - 1]! >= 104) expect(strip.X[k]!).toBeGreaterThanOrEqual(strip.X[k - 1]!);
    }
    expect(strip.X[strip.count - 1]!).toBeGreaterThan(100);
  });

  it('turns the camera into a bend before the rider reaches it', () => {
    const track = syntheticTrack([
      { lengthM: 300 },
      { lengthM: 200, turnDeg: 90 },
      { lengthM: 500 },
    ]);
    expect(cameraFor(track, 280, 0).yaw).toBeGreaterThan(0);
    expect(cameraFor(track, 200, 0).yaw).toBe(0);
  });
});

describe('RoadStrip over hills', () => {
  it('hides the road behind a crest', () => {
    // Climb 200 m at 8 %, then descend 8 %: from the foot, the far side is hidden.
    const track = syntheticTrack([
      { lengthM: 200 },
      { lengthM: 200, gradePercent: 8 },
      { lengthM: 300, gradePercent: -8 },
      { lengthM: 600 },
    ]);
    const { strip } = stripFor(track, 250);
    let hidden = 0;
    let beforeCrestVisible = true;
    for (let k = 1; k < strip.count; k++) {
      const s = strip.s[k]!;
      if (s < 395) beforeCrestVisible &&= strip.visible[k] === 1;
      else if (s > 420 && s < 600 && strip.visible[k] === 0) hidden++;
    }
    expect(beforeCrestVisible).toBe(true);
    expect(hidden).toBeGreaterThan(3);
  });

  it('shows a climb ahead rising above the horizon', () => {
    const track = syntheticTrack([{ lengthM: 300 }, { lengthM: 800, gradePercent: 7 }]);
    const { strip } = stripFor(track, 200);
    const far = strip.sy[strip.count - 1]!;
    expect(far).toBeLessThan(vp.horizonY);
  });

  it('shows a descent ahead falling below the horizon, all of it, from on the slope', () => {
    const track = syntheticTrack([{ lengthM: 300 }, { lengthM: 800, gradePercent: -6 }]);
    const { cam, strip } = stripFor(track, 340);
    expect(strip.sy[strip.count - 1]!).toBeGreaterThan(horizonLine(vp, cam));
    for (let k = 1; k < strip.count; k++) expect(strip.visible[k]).toBe(1);
  });

  it('pitches the camera up on a climb and down on a descent', () => {
    const up = syntheticTrack([{ lengthM: 1000, gradePercent: 8 }]);
    const down = syntheticTrack([{ lengthM: 1000, gradePercent: -8 }]);
    expect(cameraFor(up, 500, 0).pitch).toBeGreaterThan(0.01);
    expect(cameraFor(down, 500, 0).pitch).toBeLessThan(-0.01);
  });
});

describe('determinism', () => {
  it('gives identical strips for identical inputs', () => {
    const track = syntheticTrack([
      { lengthM: 200 },
      { lengthM: 300, turnDeg: -70, gradePercent: 4 },
      { lengthM: 900, turnDeg: 30, gradePercent: -3 },
    ]);
    const a = stripFor(track, 333.3, 0.4);
    const b = stripFor(track, 333.3, 0.4);
    expect(Array.from(a.strip.sy.subarray(0, a.strip.count))).toEqual(
      Array.from(b.strip.sy.subarray(0, b.strip.count)),
    );
    expect(a.cam).toEqual(b.cam);
  });

  it('moves smoothly: a small step forward changes the near road a little', () => {
    const track = syntheticTrack([
      { lengthM: 200 },
      { lengthM: 300, turnDeg: 80, gradePercent: 5 },
      { lengthM: 900 },
    ]);
    const p = createScreenPoint();
    const q = createScreenPoint();
    const a = stripFor(track, 250);
    const b = stripFor(track, 250.2);
    a.strip.pointAt(vp, a.cam, 300, 0, 0, p);
    b.strip.pointAt(vp, b.cam, 300, 0, 0, q);
    expect(Math.abs(p.x - q.x)).toBeLessThan(3);
    expect(Math.abs(p.y - q.y)).toBeLessThan(3);
  });
});

describe('helpers', () => {
  it('quantises fog from near to far', () => {
    expect(fogLevel(0, 6)).toBe(0);
    expect(fogLevel(ROAD_FAR_M, 6)).toBe(5);
    expect(fogLevel(200, 6)).toBeGreaterThan(fogLevel(60, 6));
  });

  it('leans into bends with speed, within limits', () => {
    expect(curveLean(10, 1 / 50)).toBeGreaterThan(0.1);
    expect(curveLean(10, -1 / 50)).toBeLessThan(-0.1);
    expect(curveLean(0, 1 / 50)).toBe(0);
    expect(curveLean(30, 1 / 5)).toBe(0.35);
  });

  it('keeps the rider in the lane and spreads other riders deterministically', () => {
    expect(riderLateralM(-1)).toBeGreaterThanOrEqual(0);
    expect(riderLateralM(1)).toBeLessThan(ROAD.halfWidthM - ROAD.edgeInsetM);
    expect(riderLateralM(5)).toBe(riderLateralM(1));
    expect(otherLateralM('abc')).toBe(otherLateralM('abc'));
    expect(Math.abs(otherLateralM('abc') - ROAD.riderBaseM)).toBeLessThanOrEqual(0.7);
  });
});
