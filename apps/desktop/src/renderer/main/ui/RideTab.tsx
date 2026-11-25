import type { DeviceKind } from '@freilauf/devices';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { App, AppState } from '../appStore';
import type { StatId } from '../../../shared/contract';
import { statLabel, statUnit, statValue } from './format';
import { rangeFill } from './fields';
import { isEditableTarget, useApp, useAppState } from './hooks';
import { GroupCountdown, WorkoutBanner, WorkoutPanel } from './WorkoutPanel';
import { RideScene } from './scene/SceneView';
import { RideRoute } from './RideRoute';
import { routeTrackOf } from './routesApi';

export const GRADIENT_MIN = -10;
export const GRADIENT_MAX = 15;
export const GRADIENT_STEP = 0.5;

const clampGradient = (g: number): number =>
  Math.max(GRADIENT_MIN, Math.min(GRADIENT_MAX, Math.round(g / GRADIENT_STEP) * GRADIENT_STEP));

/** A route drives the gradient: the manual controls are locked. */
function onRouteOrLocked(s: AppState): boolean {
  return routeTrackOf(s) !== null || s.live?.routeControl?.gradientLocked === true;
}

function nudgeGradient(app: App, delta: number): void {
  // A route sets the gradient; the keys would only fight it.
  if (onRouteOrLocked(app.store.getState())) return;
  const current = app.store.getState().live?.ride.gradePercent ?? 0;
  app.setGradient(clampGradient(current + delta));
}

function toggleRide(app: App): void {
  const state = app.store.getState().live?.ride.state;
  if (state === 'riding') app.pauseRide();
  else app.startRide();
}

/** Ride keyboard shortcuts; mounted only while the ride view is shown. */
function useRideShortcuts(app: App): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      // A modal (device picker, FTP result) owns the keyboard while open.
      const { picker, ftpOutcome } = app.store.getState();
      if (picker || ftpOutcome) return;
      switch (e.key) {
        case 'ArrowUp':
        case '+':
        case '=':
          app.shift(1, 'keyboard');
          break;
        case 'ArrowDown':
        case '-':
          app.shift(-1, 'keyboard');
          break;
        case '[':
          nudgeGradient(app, -GRADIENT_STEP);
          break;
        case ']':
          nudgeGradient(app, GRADIENT_STEP);
          break;
        case 'p':
        case 'P':
          if (e.repeat) return;
          // In a Card Race: the left card (docs/card-race.md); otherwise the held power-up.
          app.usePowerUp('keyboard');
          break;
        case 'l':
        case 'L':
          // Card Race only: the right card.
          if (e.repeat || !app.store.getState().live?.powerUps?.cards) return;
          app.playCard(1, 'keyboard');
          break;
        case ' ': {
          // Let a focused button handle its own Space activation.
          const tag = (e.target as HTMLElement | null)?.tagName;
          if (tag === 'BUTTON' || tag === 'A' || e.repeat) return;
          toggleRide(app);
          break;
        }
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app]);
}

/** Held for braking (like the levers, it slows the virtual bike only). */
export const BRAKE_KEYS: readonly string[] = ['s', 'S'];

/** Hold S to brake; released on key up, when the window loses focus and when the tab closes. */
function useBrakeKey(app: App): void {
  useEffect(() => {
    let held = false;
    const set = (next: boolean): void => {
      if (next === held) return;
      held = next;
      app.setBrakeKey(next);
    };
    const onDown = (e: KeyboardEvent): void => {
      if (!BRAKE_KEYS.includes(e.key)) return;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const { picker, ftpOutcome } = app.store.getState();
      if (picker || ftpOutcome) return;
      e.preventDefault();
      set(true);
    };
    const onUp = (e: KeyboardEvent): void => {
      if (BRAKE_KEYS.includes(e.key)) set(false);
    };
    const release = (): void => set(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', release);
      release();
    };
  }, [app]);
}

type StatVariant = 'tile' | 'hero' | 'sub';

const STAT_CLASS: Record<StatVariant, string> = {
  tile: 'tile card',
  hero: 'tile',
  sub: 'sub',
};

function StatTile({ stat, variant = 'tile' }: { stat: StatId; variant?: StatVariant }) {
  const value = useAppState((s) =>
    s.live ? statValue(stat, s.live.ride, s.live.workout, s.live.route) : '–',
  );
  const unit = statUnit(stat);
  return (
    <div className={`${STAT_CLASS[variant]} tile-${stat}`} data-testid={`stat-${stat}`}>
      <span className="tile-label">{statLabel(stat)}</span>
      <span className="tile-value">
        <span className="tile-number">{value}</span>
        {unit && <span className="tile-unit">{unit}</span>}
      </span>
    </div>
  );
}

/** Power dominates; 3 s power and W/kg sit underneath as its context. */
function PowerHero() {
  return (
    <section className="hero card" aria-label="Power">
      <StatTile stat="power" variant="hero" />
      <div className="hero-subs">
        <StatTile stat="power3s" variant="sub" />
        <StatTile stat="wattsPerKg" variant="sub" />
      </div>
    </section>
  );
}

function GearTile() {
  const gear = useAppState((s) => s.live?.ride.gear ?? 0);
  const count = useAppState((s) => s.live?.ride.gearCount ?? 0);
  return (
    <div className="tile card tile-gear" data-testid="stat-gear">
      <span className="tile-label">Gear</span>
      <span className="tile-value">
        <span className="tile-number">{count > 0 ? gear : '–'}</span>
        {count > 0 && <span className="gear-of">{`/ ${count}`}</span>}
      </span>
      <span
        className="gear-meter"
        role="meter"
        aria-label="Gear"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, count)}
        aria-valuenow={gear}
      >
        {/* One tick per gear, rising like a cassette towards the hardest gear. */}
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            className={`gear-tick${i + 1 === gear ? ' current' : i + 1 < gear ? ' on' : ''}`}
            style={{ height: `${Math.round(35 + (65 * i) / Math.max(1, count - 1))}%` }}
          />
        ))}
      </span>
    </div>
  );
}

function TrainerHint() {
  const connected = useAppState((s) => s.live?.devices.trainer?.state === 'connected');
  if (connected) return null;
  return (
    <p className="callout-warn" data-testid="trainer-missing">
      Trainer not connected — power reads 0.
    </p>
  );
}

function RideButtons({ onFinished }: { onFinished: (() => void) | undefined }) {
  const app = useApp();
  const state = useAppState((s) => s.live?.ride.state ?? 'idle');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (state === 'idle') setConfirming(false);
  }, [state]);

  if (confirming) {
    return (
      <div className="ride-buttons confirm" role="group" aria-label="Finish ride?">
        <span className="confirm-text">Finish and save this ride?</span>
        <button
          type="button"
          className="btn btn-primary btn-big"
          data-testid="ride-finish-confirm"
          onClick={() => {
            setConfirming(false);
            void app.finishRide().then(() => onFinished?.());
          }}
        >
          Finish &amp; save
        </button>
        <button type="button" className="btn btn-big" onClick={() => setConfirming(false)}>
          Keep riding
        </button>
      </div>
    );
  }

  return (
    <div className="ride-buttons" role="group" aria-label="Ride">
      {state === 'idle' && (
        <button
          type="button"
          className="btn btn-primary btn-big"
          data-testid="ride-start"
          onClick={() => app.startRide()}
        >
          Start
        </button>
      )}
      {state === 'riding' && (
        <button
          type="button"
          className="btn btn-big"
          data-testid="ride-pause"
          onClick={() => app.pauseRide()}
        >
          Pause
        </button>
      )}
      {state === 'paused' && (
        <button
          type="button"
          className="btn btn-primary btn-big"
          data-testid="ride-start"
          onClick={() => app.startRide()}
        >
          Resume
        </button>
      )}
      {state !== 'idle' && (
        <button
          type="button"
          className="btn btn-big"
          data-testid="ride-finish"
          onClick={() => setConfirming(true)}
        >
          Finish
        </button>
      )}
      <span className="ride-state" data-state={state} data-testid="ride-state">
        {state === 'idle' ? 'Ready' : state === 'riding' ? 'Recording' : 'Paused'}
      </span>
    </div>
  );
}

function GearControls() {
  const app = useApp();
  return (
    <div className="control" role="group" aria-label="Gear">
      <span className="control-label">Gear</span>
      <div className="stepper">
        <button
          type="button"
          className="btn btn-icon"
          data-testid="gear-down"
          aria-label="Shift down (easier)"
          onClick={() => app.shift(-1)}
        >
          −
        </button>
        <button
          type="button"
          className="btn btn-icon"
          data-testid="gear-up"
          aria-label="Shift up (harder)"
          onClick={() => app.shift(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function GradientControls({ byRoute = false }: { byRoute?: boolean }) {
  const app = useApp();
  const live = useAppState((s) => s.live?.ride.gradePercent ?? 0);
  // Local draft so the slider does not jump back between 4 Hz updates.
  const [draft, setDraft] = useState(live);
  useEffect(() => setDraft(live), [live]);
  const set = (g: number): void => {
    const next = clampGradient(g);
    setDraft(next);
    app.setGradient(next);
  };
  const shown = `${draft > 0 ? '+' : draft < 0 ? '−' : ''}${Math.abs(draft).toFixed(1)} %`;
  return (
    <div
      className={`control control-gradient${byRoute ? ' is-route' : ''}`}
      role="group"
      aria-label="Gradient"
      aria-describedby={byRoute ? 'gradient-route-note' : undefined}
    >
      <label className="control-label" htmlFor="gradient-slider">
        Gradient <output data-testid="gradient-value">{shown}</output>
      </label>
      {byRoute && (
        <span
          className="hint gradient-route-note"
          id="gradient-route-note"
          data-testid="gradient-route-note"
        >
          The route sets the gradient
        </span>
      )}
      <div className="control-row">
        <button
          type="button"
          className="btn btn-icon"
          data-testid="gradient-down"
          aria-label="Gradient down 0.5 %"
          disabled={byRoute}
          onClick={() => set(draft - GRADIENT_STEP)}
        >
          −
        </button>
        <input
          id="gradient-slider"
          type="range"
          min={GRADIENT_MIN}
          max={GRADIENT_MAX}
          step={GRADIENT_STEP}
          value={draft}
          disabled={byRoute}
          style={rangeFill(draft, GRADIENT_MIN, GRADIENT_MAX)}
          onChange={(e) => set(Number(e.currentTarget.value))}
        />
        <button
          type="button"
          className="btn btn-icon"
          data-testid="gradient-up"
          aria-label="Gradient up 0.5 %"
          disabled={byRoute}
          onClick={() => set(draft + GRADIENT_STEP)}
        >
          +
        </button>
      </div>
    </div>
  );
}

const DROP_LABEL: Record<DeviceKind, string> = {
  trainer: 'Drop trainer',
  heartRate: 'Drop HR',
  controller: 'Drop controller',
};

/** Sim mode: one simulated lever, held where the slider is left (−100 … +100). */
function SimLever({ side }: { side: 'left' | 'right' }) {
  const app = useApp();
  const live = useAppState((s) => s.levers?.[side] ?? 0);
  const [draft, setDraft] = useState(() => Math.round(live * 100));
  // Follow the controller (e.g. a drop returns the lever to rest) unless the slider differs only by rounding.
  useEffect(() => setDraft(Math.round(live * 100)), [live]);
  const id = `sim-lever-${side}`;
  const set = (pct: number): void => {
    setDraft(pct);
    app.setSimLever(side, pct / 100);
  };
  return (
    <label className="sim-lever" htmlFor={id}>
      <span className="control-label">
        {side === 'left' ? 'Left lever' : 'Right lever'}{' '}
        <output>{`${draft > 0 ? '+' : draft < 0 ? '−' : ''}${Math.abs(draft)} %`}</output>
      </span>
      <input
        id={id}
        data-testid={id}
        type="range"
        min={-100}
        max={100}
        step={1}
        value={draft}
        style={rangeFill(draft, -100, 100)}
        onChange={(e) => set(Number(e.currentTarget.value))}
        onDoubleClick={() => set(0)}
      />
    </label>
  );
}

function SimulationPanel() {
  const app = useApp();
  const simMode = useAppState((s) => s.simMode);
  const effort = useAppState((s) => s.simEffortW);
  if (!simMode) return null;
  return (
    <section className="panel-sim card" aria-labelledby="sim-title" data-testid="sim-panel">
      <div className="panel-sim-head">
        <h2 id="sim-title" className="section-title">
          Simulation
        </h2>
        <span className="hint">
          Simulated devices are in use. Nothing is sent to real hardware.
        </span>
      </div>
      <label className="sim-effort" htmlFor="sim-effort">
        <span className="control-label">
          Rider effort <output>{effort} W</output>
        </span>
        <input
          id="sim-effort"
          data-testid="sim-effort"
          type="range"
          min={0}
          max={600}
          step={10}
          value={effort}
          style={rangeFill(effort, 0, 600)}
          onChange={(e) => app.setSimEffort(Number(e.currentTarget.value))}
        />
      </label>
      <div className="sim-levers" role="group" aria-label="Simulated levers">
        <SimLever side="left" />
        <SimLever side="right" />
        <button
          type="button"
          className="btn btn-small"
          data-testid="sim-levers-release"
          onClick={() => {
            app.setSimLever('left', 0);
            app.setSimLever('right', 0);
          }}
        >
          Release levers
        </button>
      </div>
      <div className="button-row">
        {(['trainer', 'heartRate', 'controller'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className="btn btn-small"
            data-testid={`sim-drop-${kind}`}
            onClick={() => app.simulateDrop(kind)}
          >
            {DROP_LABEL[kind]}
          </button>
        ))}
      </div>
    </section>
  );
}

/** 'none' | 'pending' (selected, not started) | 'erg' | 'free' | 'finished' — a primitive for cheap subscriptions. */
function useWorkoutPhase(): 'none' | 'pending' | 'erg' | 'free' | 'finished' {
  return useAppState((s) => {
    const w = s.live?.workout;
    if (!w) return 'none';
    if (!w.started) return 'pending';
    return w.finished ? 'finished' : w.mode;
  });
}

function FreeRideHint({ onOpenWorkouts }: { onOpenWorkouts: (() => void) | undefined }) {
  const idle = useAppState((s) => s.live?.ride.state === 'idle');
  if (!idle || !onOpenWorkouts) return null;
  return (
    <p className="hint wo-free-hint" data-testid="ride-free-hint">
      Free ride ·{' '}
      <button type="button" className="link" onClick={onOpenWorkouts}>
        Choose a workout
      </button>
    </p>
  );
}

export interface RideTabProps {
  onOpenWorkouts?: () => void;
  /** After Finish: the ride is saved (or found too short); show the summary. */
  onFinished?: () => void;
  /** The ride view's quiet toolbar, on top of the stage. */
  toolbar?: ReactNode;
}

export function RideTab({ onOpenWorkouts, onFinished, toolbar }: RideTabProps = {}) {
  const app = useApp();
  useRideShortcuts(app);
  useBrakeKey(app);
  const phase = useWorkoutPhase();
  const erg = phase === 'erg';
  const onRoute = useAppState((s) => routeTrackOf(s) !== null);
  const gradientLocked = useAppState((s) => onRouteOrLocked(s));
  const powerUpsOn = useAppState((s) => s.settings?.powerUps?.enabled !== false);
  const cardRace = useAppState((s) => s.live?.group?.mode === 'cardRace');
  return (
    <>
      <div
        className={`ride-stage${phase === 'erg' || phase === 'free' || phase === 'finished' ? ' has-workout' : ''}`}
      >
        {toolbar}
        <TrainerHint />
        <GroupCountdown />
        {phase === 'pending' && <WorkoutBanner />}
        {phase === 'none' && <FreeRideHint onOpenWorkouts={onOpenWorkouts} />}
        {phase !== 'none' && phase !== 'pending' && <WorkoutPanel />}
        {/*
          The scene is the centre; power anchors the left, the live rhythm
          (cadence, speed, heart rate) the right, and the ride totals sit
          under the scene. Placement is pure CSS grid (see .ride-grid).
        */}
        <div className="ride-stats">
          <div className={`ride-grid${onRoute ? ' has-route' : ''}`}>
            <PowerHero />
            <RideScene />
            {onRoute && <RideRoute />}
            <StatTile stat="cadence" />
            <StatTile stat="speed" />
            <StatTile stat="heartRate" />
            <GearTile />
            <StatTile stat="time" />
            <StatTile stat="distance" />
          </div>
        </div>
        <section className="controls card" aria-label="Ride controls">
          <RideButtons onFinished={onFinished} />
          <div className={`adjust${erg ? ' is-muted' : ''}`}>
            {erg && (
              <p className="hint adjust-note" data-testid="erg-note">
                The trainer holds the target power, so gear and gradient have no effect in this
                step.
              </p>
            )}
            <GearControls />
            <GradientControls byRoute={gradientLocked} />
          </div>
        </section>
        <p className="hint shortcuts">
          <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>+</kbd> <kbd>−</kbd> shift ·{' '}
          {!gradientLocked && (
            <>
              <kbd>[</kbd> <kbd>]</kbd> gradient ∓0.5 % ·{' '}
            </>
          )}
          <kbd>A</kbd> <kbd>D</kbd> steer · <kbd>S</kbd> brake (hold) · <kbd>Space</kbd> start /
          pause
          {powerUpsOn &&
            (cardRace ? (
              <>
                {' '}
                · <kbd>P</kbd> <kbd>L</kbd> play left / right card
              </>
            ) : (
              <>
                {' '}
                · <kbd>P</kbd> use power-up
              </>
            ))}
        </p>
      </div>
      <SimulationPanel />
    </>
  );
}
