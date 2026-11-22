import { describe, expect, it } from 'vitest';
import { BIKE, BODY, computePose, createPose, solveJoint } from './riderPose';
import { profileWindow, PROFILE_BACK_M, PROFILE_MIN_BACK_M } from './sceneRender';
import { buildPalette, parseColor } from './palette';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('solveJoint', () => {
  it('keeps both segment lengths when reachable and bends to the chosen side', () => {
    const a = { x: 0, y: 1 };
    const c = { x: 0, y: 0.2 };
    const out = { x: 0, y: 0 };
    solveJoint(a, c, 0.45, 0.44, 1, out);
    expect(dist(a, out)).toBeCloseTo(0.45, 6);
    expect(dist(out, c)).toBeCloseTo(0.44, 6);
    expect(out.x).toBeGreaterThan(0); // a→c points down: +1 bends forward (+x)
    solveJoint(a, c, 0.45, 0.44, -1, out);
    expect(out.x).toBeLessThan(0);
  });

  it('straightens towards an unreachable target without NaN', () => {
    const out = { x: 0, y: 0 };
    solveJoint({ x: 0, y: 0 }, { x: 5, y: 0 }, 1, 1, 1, out);
    expect(out.x).toBeCloseTo(1, 3);
    expect(Math.abs(out.y)).toBeLessThan(0.01);
    solveJoint({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 1, 1, out);
    expect(Number.isFinite(out.x) && Number.isFinite(out.y)).toBe(true);
  });
});

describe('computePose', () => {
  it('keeps the legs attached and the knees in front, all the way round', () => {
    const p = createPose();
    for (const [standing, tuck] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
        computePose(p, a, standing, tuck);
        for (const i of [0, 1] as const) {
          expect(dist(p.pedal[i], BIKE.bb)).toBeCloseTo(BIKE.crankLength, 9);
          expect(dist(p.hip, p.knee[i])).toBeCloseTo(BODY.thigh, 2);
          // Knee ahead of the hip→ankle line (the leg never bends backwards).
          const ax = p.ankle[i].x - p.hip.x;
          const ay = p.ankle[i].y - p.hip.y;
          const kx = p.knee[i].x - p.hip.x;
          const ky = p.knee[i].y - p.hip.y;
          expect(ax * ky - ay * kx).toBeGreaterThanOrEqual(-1e-9);
        }
        // Hands on the bar, elbows reach.
        expect(dist(p.shoulder, p.elbow)).toBeCloseTo(BODY.upperArm, 2);
        expect(p.head.y).toBeGreaterThan(p.shoulder.y);
      }
    }
  });

  it('pedals stay opposite each other', () => {
    const p = createPose();
    computePose(p, 1.2, 0, 0);
    expect(p.pedal[0].x + p.pedal[1].x).toBeCloseTo(2 * BIKE.bb.x, 9);
    expect(p.pedal[0].y + p.pedal[1].y).toBeCloseTo(2 * BIKE.bb.y, 9);
  });

  it('sits on the saddle, rises standing, lowers the torso tucked', () => {
    const p = createPose();
    computePose(p, 0, 0, 0);
    const seated = { hipY: p.hip.y, torso: p.torsoAngle };
    expect(Math.abs(p.hip.x - BIKE.saddle.x)).toBeLessThan(0.05);
    computePose(p, 0, 1, 0);
    expect(p.hip.y).toBeGreaterThan(seated.hipY);
    expect(p.hip.x).toBeGreaterThan(BIKE.saddle.x + 0.1);
    computePose(p, 0, 0, 1);
    expect(p.torsoAngle).toBeLessThan(seated.torso);
    expect(p.hand.y).toBeCloseTo(BIKE.drops.y, 9);
  });

  it('leans into climbs', () => {
    const p = createPose();
    computePose(p, 0, 0, 0, 0);
    const flat = p.torsoAngle;
    computePose(p, 0, 0, 0, 0.25);
    expect(p.torsoAngle).toBeLessThan(flat);
  });
});

describe('profile window', () => {
  it('grows with the ride up to the maximum', () => {
    expect(profileWindow(0)).toBe(PROFILE_MIN_BACK_M);
    expect(profileWindow(730)).toBe(800);
    expect(profileWindow(50_000)).toBe(PROFILE_BACK_M);
  });
});

describe('palette', () => {
  it('parses the colour forms a canvas returns', () => {
    expect(parseColor('#0b63d1')).toEqual({ r: 11, g: 99, b: 209, a: 1 });
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor('rgb(118 118 128 / 12%)')?.a).toBeCloseTo(0.12, 9);
    expect(parseColor('nonsense')).toBeNull();
  });

  it('derives light and dark tones from the tokens', () => {
    const light = buildPalette({
      surface: '#ffffff',
      text: '#1b1b1f',
      text2: '#63636b',
      text3: '#a3a3aa',
      accent: '#0b63d1',
    });
    const dark = buildPalette({
      surface: '#1a1a1d',
      text: '#f4f4f6',
      text2: '#a2a2aa',
      text3: '#5c5c63',
      accent: '#4c9dff',
    });
    expect(light.dark).toBe(false);
    expect(dark.dark).toBe(true);
    expect(light.jersey).toBe('rgba(11, 99, 209, 1)');
    expect(light.skyTop).toBe('rgba(255, 255, 255, 1)');
    // Unknown token values fall back instead of producing broken colours.
    expect(buildPalette({ surface: '', text: '', text2: '', text3: '', accent: '' }).ink).toBe(
      'rgba(27, 27, 31, 1)',
    );
  });
});
