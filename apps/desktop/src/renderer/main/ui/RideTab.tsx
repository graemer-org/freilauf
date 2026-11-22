import type { DeviceKind } from '@freilauf/devices';
import { useEffect, useState } from 'react';
import type { App } from '../appStore';
import type { StatId } from '../../../shared/contract';
import { statLabel, statUnit, statValue } from './format';
import { isEditableTarget, useApp, useAppState } from './hooks';

export const GRADIENT_MIN = -10;
export const GRADIENT_MAX = 15;
export const GRADIENT_STEP = 0.5;

const clampGradient = (g: number): number =>
  Math.max(GRADIENT_MIN, Math.min(GRADIENT_MAX, Math.round(g / GRADIENT_STEP) * GRADIENT_STEP));

function nudgeGradient(app: App, delta: number): void {
  const current = app.store.getState().live?.ride.gradePercent ?? 0;
  app.setGradient(clampGradient(current + delta));
}

function toggleRide(app: App): void {
  const state = app.store.getState().live?.ride.state;
  if (state === 'riding') app.pauseRide();
  else app.startRide();
}

/** Ride tab keyboard shortcuts; mounted only while the tab is shown. */
function useRideShortcuts(app: App): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      // A modal (device picker) owns the keyboard while open.
      if (app.store.getState().picker) return;
      switch (e.key) {
        case 'ArrowUp':
        case '+':
        case '=':
          app.shift(1);
          break;
        case 'ArrowDown':
        case '-':
          app.shift(-1);
          break;
        case '[':
          nudgeGradient(app, -GRADIENT_STEP);
          break;
        case ']':
          nudgeGradient(app, GRADIENT_STEP);
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

function StatTile({ stat, size = 'm' }: { stat: StatId; size?: 's' | 'm' | 'l' }) {
  const value = useAppState((s) => (s.live ? statValue(stat, s.live.ride) : '–'));
  const unit = statUnit(stat);
  return (
    <div className={`tile tile-${size}`} data-testid={`stat-${stat}`}>
      <span className="tile-label">{statLabel(stat)}</span>
      <span className="tile-value">
        <span className="tile-number">{value}</span>
        {unit && <span className="tile-unit">{unit}</span>}
      </span>
    </div>
  );
}

function GearTile() {
  const gear = useAppState((s) => s.live?.ride.gear ?? 0);
  const count = useAppState((s) => s.live?.ride.gearCount ?? 0);
  const fraction = count > 1 ? (gear - 1) / (count - 1) : 0;
  return (
    <div className="tile tile-m tile-gear" data-testid="stat-gear">
      <span className="tile-label">Gear</span>
      <span className="tile-value">
        <span className="tile-number">{count > 0 ? `${gear} / ${count}` : '–'}</span>
      </span>
      <span
        className="gear-bar"
        role="meter"
        aria-label="Gear"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, count)}
        aria-valuenow={gear}
      >
        <span className="gear-bar-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </span>
    </div>
  );
}

function TrainerHint() {
  const connected = useAppState((s) => s.live?.devices.trainer?.state === 'connected');
  if (connected) return null;
  return (
    <p className="hint hint-warn" data-testid="trainer-missing">
      Trainer not connected — power reads 0.
    </p>
  );
}

function RideButtons() {
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
          className="btn btn-primary"
          data-testid="ride-finish-confirm"
          onClick={() => {
            setConfirming(false);
            void app.finishRide();
          }}
        >
          Finish &amp; save
        </button>
        <button type="button" className="btn" onClick={() => setConfirming(false)}>
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
      <span className="ride-state" data-testid="ride-state">
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
      <div className="control-row">
        <button
          type="button"
          className="btn btn-square"
          data-testid="gear-down"
          aria-label="Shift down (easier)"
          onClick={() => app.shift(-1)}
        >
          −
        </button>
        <button
          type="button"
          className="btn btn-square"
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

function GradientControls() {
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
    <div className="control control-gradient" role="group" aria-label="Gradient">
      <label className="control-label" htmlFor="gradient-slider">
        Gradient <output data-testid="gradient-value">{shown}</output>
      </label>
      <div className="control-row">
        <button
          type="button"
          className="btn btn-square"
          data-testid="gradient-down"
          aria-label="Gradient down 0.5 %"
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
          onChange={(e) => set(Number(e.currentTarget.value))}
        />
        <button
          type="button"
          className="btn btn-square"
          data-testid="gradient-up"
          aria-label="Gradient up 0.5 %"
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

function SimulationPanel() {
  const app = useApp();
  const simMode = useAppState((s) => s.simMode);
  const effort = useAppState((s) => s.simEffortW);
  if (!simMode) return null;
  return (
    <section className="panel panel-sim" aria-labelledby="sim-title" data-testid="sim-panel">
      <h2 id="sim-title" className="panel-title">
        Simulation
      </h2>
      <p className="hint">Simulated devices are in use. Nothing is sent to real hardware.</p>
      <label className="field-inline" htmlFor="sim-effort">
        <span>
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
          onChange={(e) => app.setSimEffort(Number(e.currentTarget.value))}
        />
      </label>
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

export function RideTab() {
  const app = useApp();
  useRideShortcuts(app);
  return (
    <div className="ride">
      <div className="tiles">
        <StatTile stat="power" size="l" />
        <StatTile stat="power3s" />
        <StatTile stat="wattsPerKg" />
        <StatTile stat="cadence" />
        <StatTile stat="speed" />
        <StatTile stat="heartRate" />
        <GearTile />
        <StatTile stat="time" />
        <StatTile stat="distance" />
      </div>
      <TrainerHint />
      <section className="panel controls" aria-label="Ride controls">
        <RideButtons />
        <GearControls />
        <GradientControls />
      </section>
      <p className="hint shortcuts">
        Keys: <kbd>↑</kbd>/<kbd>↓</kbd> or <kbd>+</kbd>/<kbd>−</kbd> shift · <kbd>[</kbd>/
        <kbd>]</kbd> gradient ∓0.5 % · <kbd>Space</kbd> start/pause
      </p>
      <SimulationPanel />
    </div>
  );
}
