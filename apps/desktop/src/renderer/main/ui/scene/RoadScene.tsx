import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RouteTrack } from '@freilauf/routes';
import type { App } from '../../appStore';
import type { LiveState } from '../../../../shared/contract';
import { useApp } from '../hooks';
import { readPalette, startBrakeCue, steerKeyboard } from './RideScene';
import { PowerUpSceneState, powerUpAttributes, riderFx, rumbleKey } from './powerUpScene';
import { gapsHidden } from '../../../../shared/powerUps';
import { cameraFor, curveLean, riderLateralM } from './roadMath';
import { RoadRenderer, type RoadFrame, type RoadRider } from './roadRender';
import {
  curvatureAt,
  gradeAt,
  gradeSigns,
  headingAt,
  nextSign,
  routeDistance,
  turnAhead,
} from './routeSample';
import {
  crankRate,
  describeScene,
  easeToward,
  integrateAngle,
  type LateralState,
  leanFor,
  standingTarget,
  steeringInput,
  stepLateral,
  tuckTarget,
} from './sceneMath';

/** Easing time constants, seconds. */
const TAU = {
  speed: 0.45,
  cadence: 0.35,
  standing: 0.55,
  tuck: 0.8,
  lean: 0.5,
  catchUp: 0.35,
} as const;
const ATTR_MS = 200;
const LABEL_MS = 2000;
/** Further than this from the reported position, the scene jumps instead of catching up. */
const SNAP_M = 30;
/** After a jump along the route: a short fade-in at the new place (none with reduced motion). */
const CUT_MS = 400;

const EMPTY: readonly RoadRider[] = [];
const deg = (rad: number): number => (rad * 180) / Math.PI;

/** Route distance as one continuous number across laps (so the road never jumps back). */
export function unwrappedDistance(track: RouteTrack, route: LiveState['route']): number | null {
  if (!route || route.routeId !== track.id) return null;
  const total = (track.count - 1) * track.stepM;
  const lap = Math.max(1, Math.floor(route.lap || 1));
  return track.loop ? (lap - 1) * total + route.distanceM : route.distanceM;
}

/** What the scene says to assistive tech: route progress, slope, speed, the bend ahead. */
export function describeRoad(live: LiveState | null, track: RouteTrack, distanceM: number): string {
  const r = live?.ride;
  const base = describeScene(
    r?.state ?? 'idle',
    r?.gradePercent ?? 0,
    r?.speedMps ?? 0,
    r?.cadenceRpm ?? 0,
  );
  const d = routeDistance(track, distanceM);
  const km = (m: number): string => (m / 1000).toFixed(1);
  const turn = deg(turnAhead(track, distanceM, 150));
  const bend =
    Math.abs(turn) < 25
      ? ''
      : ` ${Math.abs(turn) > 120 ? 'Hairpin' : 'Bend'} to the ${turn > 0 ? 'right' : 'left'} ahead.`;
  return `Route ${track.name}, ${km(d)} of ${km(track.totalDistanceM)} km. ${base}${bend}`;
}

/**
 * The ride seen from behind and above the rider, on the route's road: it
 * bends with the route and rises and falls with its elevation ahead. Same
 * loop discipline as the side-on scene (one rAF loop outside React, 4 Hz
 * samples interpolated, HiDPI, paused when hidden, reduced motion).
 *
 * Test hooks: data-view="road", data-distance (route distance, continuous
 * across laps), data-heading (degrees, 0 = north), data-curve (degrees of
 * turn over the next 100 m, + right), data-grade (what the trainer is told),
 * data-route-grade (from the track), data-lateral, data-frames, data-frame-ms, data-jumps
 * (jumps along the route seen; each one cuts to the new place, see CUT_MS), and for power-ups
 * data-effect (active effect's kind or ''), data-effect-phase and data-gate-ahead (m or '').
 */
export function RoadScene({ track, toolbar }: { track: RouteTrack; toolbar?: ReactNode }) {
  const app = useApp();
  const rootRef = useRef<HTMLElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const brakeRef = useRef<HTMLSpanElement>(null);
  const [initial] = useState(() => {
    const live = app.store.getState().live;
    const d = unwrappedDistance(track, live?.route) ?? 0;
    return {
      label: describeRoad(live, track, d),
      grade: (live?.ride.gradePercent ?? 0).toFixed(1),
      state: live?.ride.state ?? 'idle',
      distance: d.toFixed(1),
      heading: deg(headingAt(track, d)).toFixed(1),
      curve: deg(turnAhead(track, d, 100)).toFixed(1),
    };
  });

  useEffect(() => {
    const root = rootRef.current;
    const view = viewRef.current;
    if (!root || !view) return;
    const stopBrake = startBrakeCue(app, root, brakeRef.current);
    const stopScene = startRoadScene(app, root, view, track);
    return () => {
      stopBrake();
      stopScene();
    };
  }, [app, track]);

  return (
    <section
      ref={rootRef}
      className="scene scene-road card"
      data-testid="ride-scene"
      role="img"
      aria-label={initial.label}
      data-view="road"
      data-route-id={track.id}
      data-grade={initial.grade}
      data-route-grade="0.0"
      data-lateral="0.00"
      data-distance={initial.distance}
      data-heading={initial.heading}
      data-curve={initial.curve}
      data-frames="0"
      data-state={initial.state}
      data-braking="0"
      data-effect=""
      data-gate-ahead=""
    >
      <div className="scene-view">
        <canvas ref={viewRef} className="scene-canvas" aria-hidden="true" />
        <span ref={brakeRef} className="scene-brake" data-testid="scene-brake" hidden>
          <span className="scene-brake-dot" />
          <span className="scene-brake-text">Brake</span>
        </span>
        {toolbar}
      </div>
    </section>
  );
}

function startRoadScene(
  app: App,
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  track: RouteTrack,
): () => void {
  let view: RoadRenderer;
  try {
    view = new RoadRenderer(canvas);
  } catch {
    return () => undefined; // no 2D canvas (headless test DOM)
  }
  const scratch = document.createElement('canvas').getContext('2d');
  const signs = gradeSigns(track);
  const total = (track.count - 1) * track.stepM;

  // ── live input (4 Hz) ──
  let live: LiveState | null = null;
  let target: number | null = null;
  let targetAt = 0;
  let others: RoadRider[] = [];
  // A jump along the route: cut straight to the new place (no catching up across the gap).
  let jumps: number | null = null;
  let cut = false;
  let cutTimer: ReturnType<typeof setTimeout> | null = null;
  const boost = new PowerUpSceneState();
  const onLive = (next: LiveState | null): void => {
    if (next === live) return;
    live = next;
    if (!next) return;
    const seen = next.routeControl?.jumps ?? 0;
    if (jumps !== null && seen !== jumps && seen > 0) {
      cut = true;
      root.classList.remove('is-cut');
      void root.offsetWidth; // restart the fade on back-to-back jumps
      root.classList.add('is-cut');
      if (cutTimer) clearTimeout(cutTimer);
      cutTimer = setTimeout(() => root.classList.remove('is-cut'), CUT_MS);
    }
    jumps = seen;
    target = unwrappedDistance(track, next.route);
    targetAt = performance.now();
    // Gates are reported relative to the rider's route position at this sample.
    boost.setLive(next.powerUps, target ?? 0, targetAt);
    const riders = next.group?.riders ?? [];
    const prev = new Map(others.map((o) => [o.id, o.crank]));
    others = riders
      .filter((r) => Number.isFinite(r.gapM) && r.gapM > 0)
      .map((r) => ({
        id: r.peerId,
        name: r.name,
        gapM: r.gapM,
        stale: r.stale,
        crank: prev.get(r.peerId) ?? (r.peerId.length * 1.7) % 6.28,
        ...(riderFx(r.items) ? { fx: riderFx(r.items) } : {}),
      }))
      .sort((a, b) => a.gapM - b.gapM);
    cadences = new Map(riders.map((r) => [r.peerId, r.cadenceRpm]));
    // The ghost rider (docs/ghost.md): on the road while racing, translucent.
    const g = next.ghost;
    if (
      g &&
      (g.status === 'racing' || g.status === 'finished') &&
      g.aheadM !== null &&
      g.aheadM > 0
    ) {
      others = [
        ...others,
        {
          id: 'ghost',
          name: 'Ghost',
          gapM: g.aheadM,
          stale: false,
          crank: prev.get('ghost') ?? 1.1,
          ghost: true,
        },
      ].sort((a, b) => a.gapM - b.gapM);
      cadences.set('ghost', g.speedMps > 0.5 ? 86 : 0);
    }
  };
  let cadences = new Map<string, number>();
  onLive(app.store.getState().live);
  const unsubscribe = app.store.subscribe((s) => onLive(s.live));

  const keys = steerKeyboard(app, () => wake());

  // ── theme, motion, size ──
  const darkMq = window.matchMedia?.('(prefers-color-scheme: dark)');
  const motionMq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion = motionMq?.matches ?? false;
  let dirty = true;
  const applyPalette = (): void => {
    if (!scratch) return;
    const { palette, font } = readPalette(root, scratch);
    view.setPalette(palette, font);
    dirty = true;
  };
  const onTheme = (): void => {
    requestAnimationFrame(applyPalette);
  };
  const onMotion = (): void => {
    reducedMotion = motionMq?.matches ?? false;
    dirty = true;
  };
  darkMq?.addEventListener?.('change', onTheme);
  motionMq?.addEventListener?.('change', onMotion);
  applyPalette();

  let dpr = window.devicePixelRatio || 1;
  const sizeAll = (): void => {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    view.resize(r.width, r.height, dpr);
    dirty = true;
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sizeAll) : null;
  ro?.observe(canvas);
  sizeAll();

  // ── animation state ──
  const lat: LateralState = { pos: 0, vel: 0 };
  let distance = target ?? 0;
  let speed = 0;
  let cadence = 0;
  let crank = 2.2;
  let standing = 0;
  let tuck = 0;
  let lean = 0;
  let frames = 0;
  let frameMs = 0;
  let lastT = 0;
  let lastAttr = 0;
  let lastLabel = 0;
  let label = root.getAttribute('aria-label') ?? '';
  let drawn = { d: Number.NaN, lat: Number.NaN, state: '', boost: '' };
  const frame: RoadFrame = {
    track,
    camera: cameraFor(track, distance, 0),
    state: 'idle',
    riderX: riderLateralM(0),
    lean: 0,
    crank,
    standing: 0,
    tuck: 0,
    gradeLabel: 0,
    next: null,
    signs,
    finishM: Number.NaN,
    others: EMPTY,
    reducedMotion,
  };

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
    const finished = live?.route?.finished === true;

    if (reducedMotion) {
      speed = targetSpeed;
      cadence = targetCad;
      standing = 0;
      tuck = 0;
      // The road follows the 4 Hz samples; nothing is extrapolated in between.
      cut = false;
      if (target !== null) distance = target;
      else if (riding) distance += speed * dt;
    } else {
      speed = easeToward(speed, targetSpeed, dt, TAU.speed);
      cadence = easeToward(cadence, targetCad, dt, TAU.cadence);
      standing = easeToward(standing, standingTarget(grade, targetCad, riding), dt, TAU.standing);
      tuck = easeToward(tuck, tuckTarget(speed, grade, cadence), dt, TAU.tuck);
      crank = integrateAngle(crank, -crankRate(cadence), dt);
      if (cut && target !== null) {
        distance = target;
        cut = false;
      } else if (target !== null) {
        const ahead = riding && !finished ? targetSpeed * Math.min(1, (t - targetAt) / 1000) : 0;
        const goal = target + ahead;
        if (Math.abs(goal - distance) > SNAP_M || frames === 0) distance = goal;
        else {
          if (riding && !finished) distance += speed * dt;
          distance += (goal - distance) * (1 - Math.exp(-dt / TAU.catchUp));
        }
      } else if (riding) {
        // No route position from the ride yet: keep the scene's own odometer.
        distance += speed * dt;
      }
      for (const o of others) {
        o.crank = integrateAngle(o.crank, -crankRate(cadences.get(o.id) ?? 0), dt);
      }
    }
    if (!track.loop && distance > total) distance = total;

    stepLateral(
      lat,
      steeringInput(live?.steering, keys.left, keys.right),
      dt,
      speed,
      reducedMotion,
    );
    const curve = curvatureAt(track, distance, 24);
    const leanGoal = reducedMotion ? 0 : curveLean(speed, curve) + leanFor(lat.vel);
    lean = reducedMotion ? 0 : easeToward(lean, leanGoal, dt, TAU.lean);

    frame.state = state;
    frame.riderX = riderLateralM(lat.pos);
    frame.camera = cameraFor(track, distance, frame.riderX);
    frame.lean = lean;
    frame.crank = crank;
    frame.standing = standing;
    frame.tuck = tuck;
    frame.gradeLabel = grade;
    frame.next = nextSign(track, signs, distance, 420);
    frame.finishM = track.loop
      ? total > 0
        ? Math.ceil((distance - 4) / total) * total
        : Number.NaN
      : total;
    frame.others = others;
    frame.hideGaps = gapsHidden(live?.powerUps);
    frame.reducedMotion = reducedMotion;
    frame.powerUps = boost.update(distance, t);
    const pu = frame.powerUps;
    const boostKey = `${pu.gates.map((g) => Math.round(g)).join(',')}|${pu.effect}|${pu.phase}|${pu.flash >= 0}|${rumbleKey(pu.rumble)}|${others.map((o) => (o.fx ? `${o.fx.hit}${o.fx.cape}${o.fx.protected}${o.fx.repair}` : '')).join(',')}`;

    const changed =
      !reducedMotion ||
      drawn.boost !== boostKey ||
      dirty ||
      drawn.d !== distance ||
      drawn.lat !== lat.pos ||
      drawn.state !== state;
    if (changed) {
      const t0 = performance.now();
      view.draw(frame);
      const cost = performance.now() - t0;
      frameMs = frames === 0 ? cost : frameMs * 0.95 + cost * 0.05;
      frames++;
      dirty = false;
      drawn = { d: distance, lat: lat.pos, state, boost: boostKey };
    }

    if (t - lastAttr >= ATTR_MS) {
      lastAttr = t;
      const ds = root.dataset;
      ds.grade = grade.toFixed(1);
      ds.routeGrade = gradeAt(track, distance, 10).toFixed(1);
      ds.lateral = lat.pos.toFixed(2);
      ds.distance = distance.toFixed(1);
      ds.heading = deg(headingAt(track, distance)).toFixed(1);
      ds.curve = deg(turnAhead(track, distance, 100)).toFixed(1);
      ds.frames = String(frames);
      ds.frameMs = frameMs.toFixed(3);
      ds.state = state;
      ds.motion = reducedMotion ? 'reduced' : 'full';
      ds.jumps = String(jumps ?? 0);
      const pa = powerUpAttributes(pu);
      ds.effect = pa.effect;
      ds.effectPhase = pa.effectPhase;
      ds.gateAhead = pa.gateAhead;
      ds.rumble = pa.rumble;
      ds.puddleAhead = pa.puddleAhead;
      ds.tacksAhead = pa.tacksAhead;
      ds.roughAhead = pa.roughAhead;
      ds.supply = pa.supply;
      ds.flying = pa.flying;
      ds.nextSign = frame.next
        ? `${frame.next.gradePercent.toFixed(1)}@${Math.round(frame.next.inM)}`
        : '';
    }
    if (t - lastLabel >= LABEL_MS) {
      lastLabel = t;
      const next = describeRoad(live, track, distance);
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
  wake();

  return () => {
    sleep();
    if (cutTimer) clearTimeout(cutTimer);
    unsubscribe();
    keys.stop();
    document.removeEventListener('visibilitychange', onVisibility);
    darkMq?.removeEventListener?.('change', onTheme);
    motionMq?.removeEventListener?.('change', onMotion);
    ro?.disconnect();
    io?.disconnect();
  };
}
