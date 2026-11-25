import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { App } from '../../appStore';
import type { LiveState } from '../../../../shared/contract';
import { isEditableTarget, useApp } from '../hooks';
import { buildPalette } from './palette';
import { PowerUpSceneState, cardsKey, powerUpAttributes } from './powerUpScene';
import { ProfileRenderer, SceneRenderer, type SceneFrame } from './sceneRender';
import {
  crankRate,
  describeScene,
  easeToward,
  integrateAngle,
  type LateralState,
  placeRiders,
  type PlacedRider,
  ProfileHistory,
  standingTarget,
  steeringInput,
  stepLateral,
  tuckTarget,
  wheelRate,
} from './sceneMath';

/** Keys held for steering without paddles. ←/→ move between tabs when the tab bar has focus. */
export const STEER_LEFT_KEYS: readonly string[] = ['a', 'A'];
export const STEER_RIGHT_KEYS: readonly string[] = ['d', 'D'];

/** Easing time constants, seconds. */
const TAU = { speed: 0.45, cadence: 0.35, grade: 0.9, standing: 0.55, tuck: 0.8 } as const;
/** Attribute and label refresh intervals, ms. */
const ATTR_MS = 200;
const LABEL_MS = 2000;

const EMPTY_RIDERS: readonly PlacedRider[] = [];

function ariaFor(live: LiveState | null): string {
  if (!live) return 'Ride scene';
  const r = live.ride;
  return describeScene(r.state, r.gradePercent, r.speedMps, r.cadenceRpm);
}

export function readPalette(el: HTMLElement, scratch: CanvasRenderingContext2D) {
  const cs = getComputedStyle(el);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  const normalise = (c: string): string => {
    scratch.fillStyle = '#000';
    scratch.fillStyle = c;
    return String(scratch.fillStyle);
  };
  const palette = buildPalette(
    {
      surface: v('--surface'),
      text: v('--text'),
      text2: v('--text-2'),
      text3: v('--text-3'),
      accent: v('--accent'),
      attack: v('--card-attack'),
      guard: v('--card-guard'),
    },
    normalise,
  );
  return { palette, font: v('--font-display') || v('--font') };
}

/**
 * Side-on illustration of the ride: a rider whose wheels and cranks follow
 * speed and cadence, a road tilted by the gradient, parallax scenery, other
 * group riders, steering, and an elevation profile of the recent past.
 *
 * React renders the container once; the 60 fps animation draws imperatively
 * into two canvases from a requestAnimationFrame loop that interpolates
 * between the 4 Hz live samples. Test hooks: data-grade, data-lateral,
 * data-distance (scene odometer), data-frames, data-frame-ms, and for power-ups data-effect
 * (the active effect's kind, or ''), data-effect-phase and data-gate-ahead (m to the next
 * pick-up gate, or '').
 */
export function SideScene({
  toolbar,
  profile = true,
}: { toolbar?: ReactNode; profile?: boolean } = {}) {
  const app = useApp();
  const rootRef = useRef<HTMLElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const profileRef = useRef<HTMLCanvasElement>(null);
  const brakeRef = useRef<HTMLSpanElement>(null);
  // Initial attributes only; afterwards the loop owns them (React never re-sets them).
  const [initial] = useState(() => {
    const live = app.store.getState().live;
    return {
      label: ariaFor(live),
      grade: (live?.ride.gradePercent ?? 0).toFixed(1),
      state: live?.ride.state ?? 'idle',
    };
  });

  useEffect(() => {
    const root = rootRef.current;
    const view = viewRef.current;
    const profile = profileRef.current;
    if (!root || !view || !profile) return;
    const stopBrake = startBrakeCue(app, root, brakeRef.current);
    const stopScene = startScene(app, root, view, profile);
    return () => {
      stopBrake();
      stopScene();
    };
  }, [app]);

  return (
    <section
      ref={rootRef}
      className="scene card"
      data-testid="ride-scene"
      role="img"
      aria-label={initial.label}
      data-grade={initial.grade}
      data-lateral="0.00"
      data-distance="0.0"
      data-frames="0"
      data-state={initial.state}
      data-braking="0"
      data-view="side"
      data-effect=""
      data-gate-ahead=""
    >
      <div className="scene-view">
        <canvas ref={viewRef} className="scene-canvas" aria-hidden="true" />
        {toolbar}
        <span ref={brakeRef} className="scene-brake" data-testid="scene-brake" hidden>
          <span className="scene-brake-dot" />
          <span className="scene-brake-text">Brake</span>
        </span>
      </div>
      <div className="scene-profile" hidden={!profile}>
        <canvas
          ref={profileRef}
          className="scene-canvas"
          data-testid="ride-profile"
          aria-hidden="true"
        />
      </div>
    </section>
  );
}

/** Below this the brake cue stays hidden (rounding noise, the end of a release). */
const BRAKE_CUE_MIN = 0.03;

/**
 * Shows "Brake 70 %" on the scene while the brake acts (levers or the brake
 * key) and mirrors the value in data-braking. Follows the 4 Hz live state;
 * works without a canvas, so the cue is there even in a headless DOM.
 */
export function startBrakeCue(app: App, root: HTMLElement, badge: HTMLElement | null): () => void {
  const text = badge?.querySelector<HTMLElement>('.scene-brake-text') ?? null;
  let shown = '';
  const update = (live: LiveState | null): void => {
    const braking = live?.ride.state === 'riding' ? (live.braking ?? 0) : 0;
    const label = braking >= BRAKE_CUE_MIN ? `Brake ${Math.round(braking * 100)} %` : '';
    if (label === shown) return;
    shown = label;
    root.dataset.braking = braking.toFixed(2);
    if (!badge) return;
    badge.hidden = label === '';
    if (text && label) text.textContent = label;
  };
  update(app.store.getState().live);
  return app.store.subscribe((s) => update(s.live));
}

/** Held steering keys (A/D), ignored while typing or while a modal is open. */
export interface SteerKeys {
  readonly left: boolean;
  readonly right: boolean;
  stop(): void;
}

export function steerKeyboard(app: App, onPress: () => void): SteerKeys {
  const state = { left: false, right: false };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
    const { picker, ftpOutcome } = app.store.getState();
    if (picker || ftpOutcome) return;
    if (STEER_LEFT_KEYS.includes(e.key)) state.left = true;
    else if (STEER_RIGHT_KEYS.includes(e.key)) state.right = true;
    else return;
    e.preventDefault();
    onPress();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (STEER_LEFT_KEYS.includes(e.key)) state.left = false;
    else if (STEER_RIGHT_KEYS.includes(e.key)) state.right = false;
  };
  const onBlur = (): void => {
    state.left = false;
    state.right = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return {
    get left() {
      return state.left;
    },
    get right() {
      return state.right;
    },
    stop() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}

/** Wires the loop, input and observers; returns the teardown. */
function startScene(
  app: App,
  root: HTMLElement,
  viewCanvas: HTMLCanvasElement,
  profileCanvas: HTMLCanvasElement,
): () => void {
  let view: SceneRenderer;
  let profile: ProfileRenderer;
  try {
    view = new SceneRenderer(viewCanvas);
    profile = new ProfileRenderer(profileCanvas);
  } catch {
    return () => undefined; // no 2D canvas (e.g. a headless test DOM): numbers remain
  }
  const scratch = document.createElement('canvas').getContext('2d');

  // ── live input (4 Hz) ──
  let live: LiveState | null = null;
  const history = new ProfileHistory(400, 5);
  let placed: readonly PlacedRider[] = EMPTY_RIDERS;
  let profileDirty = true;
  const boost = new PowerUpSceneState();
  // The frame (and its odometer) is set up below; gates are placed relative to it.
  let odometer: { distanceM: number } = { distanceM: 0 };
  const onLive = (next: LiveState | null): void => {
    if (next === live) return;
    const prevGroup = live?.group?.riders;
    live = next;
    if (!next) return;
    boost.setLive(next.powerUps, odometer.distanceM, performance.now());
    history.add(next.ride.distanceM, next.ride.gradePercent);
    const riders = next.group?.riders;
    if (riders !== prevGroup)
      placed = riders && riders.length > 0 ? placeRiders(riders) : EMPTY_RIDERS;
    profileDirty = true;
  };
  onLive(app.store.getState().live);
  const unsubscribe = app.store.subscribe((s) => onLive(s.live));

  // ── keyboard steering ──
  const keys = steerKeyboard(app, () => wake());

  // ── theme, motion preference, size ──
  const darkMq = window.matchMedia?.('(prefers-color-scheme: dark)');
  const motionMq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion = motionMq?.matches ?? false;
  let viewDirty = true;
  const applyPalette = (): void => {
    if (!scratch) return;
    const { palette, font } = readPalette(root, scratch);
    view.setPalette(palette, font);
    profile.setPalette(palette, font);
    viewDirty = true;
    profileDirty = true;
  };
  const onTheme = (): void => {
    // Let the stylesheet's media query apply before reading the tokens.
    requestAnimationFrame(applyPalette);
  };
  const onMotion = (): void => {
    reducedMotion = motionMq?.matches ?? false;
    viewDirty = true;
  };
  darkMq?.addEventListener?.('change', onTheme);
  motionMq?.addEventListener?.('change', onMotion);
  applyPalette();

  let dpr = window.devicePixelRatio || 1;
  const sizeAll = (): void => {
    dpr = window.devicePixelRatio || 1;
    const v = viewCanvas.getBoundingClientRect();
    const p = profileCanvas.getBoundingClientRect();
    view.resize(v.width, v.height, dpr);
    profile.resize(p.width, p.height, dpr);
    viewDirty = true;
    profileDirty = true;
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sizeAll) : null;
  ro?.observe(viewCanvas);
  ro?.observe(profileCanvas);
  sizeAll();

  // ── animation state ──
  const lat: LateralState = { pos: 0, vel: 0 };
  const otherAngles = new Map<string, { wheel: number; crank: number }>();
  const frame: SceneFrame = {
    state: 'idle',
    distanceM: 0,
    grade: app.store.getState().live?.ride.gradePercent ?? 0,
    gradeLabel: 0,
    wheel: 0,
    crank: 2.2,
    lateral: 0,
    lateralVel: 0,
    standing: 0,
    tuck: 0,
    reducedMotion,
    others: EMPTY_RIDERS,
    otherAngles,
  };
  odometer = frame;
  let speed = 0;
  let cadence = 0;
  let frames = 0;
  let frameMs = 0;
  let lastT = 0;
  let lastAttr = 0;
  let lastLabel = 0;
  let label = root.getAttribute('aria-label') ?? '';
  let lastDrawn = { grade: NaN, lat: NaN, state: '', boost: '' };

  const tick = (t: number): void => {
    raf = 0;
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const dt = lastT === 0 ? 0 : Math.min(0.1, (t - lastT) / 1000);
    lastT = t;
    if (window.devicePixelRatio !== dpr) sizeAll();

    const r = live?.ride;
    const state = r?.state ?? 'idle';
    const riding = state === 'riding';
    const targetSpeed = riding ? (r?.speedMps ?? 0) : 0;
    const targetCad = riding ? (r?.cadenceRpm ?? 0) : 0;
    const grade = r?.gradePercent ?? 0;

    frame.state = state;
    frame.gradeLabel = grade;
    frame.reducedMotion = reducedMotion;
    frame.others = placed;
    if (reducedMotion) {
      speed = targetSpeed;
      cadence = targetCad;
      frame.grade = grade;
      frame.standing = standingTarget(grade, targetCad, riding);
      frame.tuck = tuckTarget(targetSpeed, grade, targetCad);
    } else {
      speed = easeToward(speed, targetSpeed, dt, TAU.speed);
      cadence = easeToward(cadence, targetCad, dt, TAU.cadence);
      frame.grade = easeToward(frame.grade, grade, dt, TAU.grade);
      frame.standing = easeToward(
        frame.standing,
        standingTarget(grade, targetCad, riding),
        dt,
        TAU.standing,
      );
      frame.tuck = easeToward(frame.tuck, tuckTarget(speed, grade, cadence), dt, TAU.tuck);
      frame.distanceM += speed * dt;
      frame.wheel = integrateAngle(frame.wheel, wheelRate(speed), dt);
      frame.crank = integrateAngle(frame.crank, -crankRate(cadence), dt);
      for (const o of placed) {
        let a = otherAngles.get(o.id);
        if (!a) {
          a = { wheel: 0, crank: (o.id.length * 1.7) % 6.28 };
          otherAngles.set(o.id, a);
        }
        a.wheel = integrateAngle(a.wheel, wheelRate(o.speedMps), dt);
        a.crank = integrateAngle(a.crank, -crankRate(o.cadenceRpm), dt);
      }
    }
    stepLateral(
      lat,
      steeringInput(live?.steering, keys.left, keys.right),
      dt,
      speed,
      reducedMotion,
    );
    frame.lateral = lat.pos;
    frame.lateralVel = lat.vel;
    frame.powerUps = boost.update(frame.distanceM, t);
    const boostKey = `${frame.powerUps.gates.map((g) => Math.round(g)).join(',')}|${frame.powerUps.effect}|${frame.powerUps.phase}|${frame.powerUps.flash >= 0}|${cardsKey(frame.powerUps.cards)}`;

    // Reduced motion: draw only when something visible changed.
    const changed =
      !reducedMotion ||
      lastDrawn.boost !== boostKey ||
      viewDirty ||
      profileDirty ||
      lastDrawn.grade !== frame.grade ||
      lastDrawn.lat !== frame.lateral ||
      lastDrawn.state !== state;
    if (changed) {
      const t0 = performance.now();
      view.draw(frame);
      if (profileDirty) {
        profile.draw({
          length: history.length,
          distAt: (i) => history.distAt(i),
          elevAt: (i) => history.elevAt(i),
          currentDistanceM: history.currentDistanceM,
          currentElevationM: history.currentElevationM,
          gradePercent: grade,
          others: placed,
          climbedM: history.climbedM(),
        });
        profileDirty = false;
      }
      const cost = performance.now() - t0;
      frameMs = frames === 0 ? cost : frameMs * 0.95 + cost * 0.05;
      frames++;
      viewDirty = false;
      lastDrawn.grade = frame.grade;
      lastDrawn.lat = frame.lateral;
      lastDrawn.state = state;
      lastDrawn.boost = boostKey;
    }

    if (t - lastAttr >= ATTR_MS) {
      lastAttr = t;
      root.dataset.grade = grade.toFixed(1);
      root.dataset.lateral = lat.pos.toFixed(2);
      root.dataset.distance = frame.distanceM.toFixed(1);
      root.dataset.frames = String(frames);
      root.dataset.frameMs = frameMs.toFixed(3);
      root.dataset.state = state;
      root.dataset.motion = reducedMotion ? 'reduced' : 'full';
      const pa = powerUpAttributes(frame.powerUps);
      root.dataset.effect = pa.effect;
      root.dataset.effectPhase = pa.effectPhase;
      root.dataset.gateAhead = pa.gateAhead;
      root.dataset.cards = pa.cards;
    }
    if (t - lastLabel >= LABEL_MS) {
      lastLabel = t;
      const next = ariaFor(live);
      if (next !== label) {
        label = next;
        root.setAttribute('aria-label', next);
      }
    }
  };

  // ── run only while visible ──
  let raf = 0;
  let running = false;
  let onScreen = true;
  const shouldRun = (): boolean => onScreen && document.visibilityState !== 'hidden';
  function wake(): void {
    if (running || !shouldRun()) return;
    running = true;
    lastT = 0;
    raf = requestAnimationFrame(tick);
  }
  const sleep = (): void => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = (): void => (shouldRun() ? wake() : sleep());
  document.addEventListener('visibilitychange', onVisibility);
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          for (const e of entries) onScreen = e.isIntersecting;
          onVisibility();
        })
      : null;
  io?.observe(root);
  lastDrawn = { grade: NaN, lat: NaN, state: '', boost: '' };
  wake();

  return () => {
    sleep();
    unsubscribe();
    keys.stop();
    document.removeEventListener('visibilitychange', onVisibility);
    darkMq?.removeEventListener?.('change', onTheme);
    motionMq?.removeEventListener?.('change', onMotion);
    ro?.disconnect();
    io?.disconnect();
  };
}
