import type { ControllerButton } from '@freilauf/devices';
import { useEffect, useId, useState } from 'react';
import type {
  ControllerAction,
  LeverFunction,
  LeverSettings,
  Settings,
} from '../../../shared/contract';
import {
  CONTROLLER_ACTION_LABELS,
  DEFAULT_LEVERS,
  LEVER_FUNCTION_LABELS,
} from '../../../shared/contract';
import type { LeverSide } from '../../core/levers';
import {
  describeGrip,
  formatLeverPercent,
  gripOutput,
  isDefaultLevers,
  swapGrip,
} from '../../core/levers';
import type { Grip } from './buttonMap';
import {
  ACTION_OPTIONS,
  GRIP_LABEL,
  actionOf,
  buttonLabel,
  buttonsOnGrip,
  defaultButtonsPatch,
  isDefaultMapping,
} from './buttonMap';
import { RangeField } from './fields';
import { useApp, useAppState } from './hooks';

/** How long a row stays lit after its button was pressed. */
export const PRESSED_MS = 1200;

// ───────────── controller buttons ─────────────

function ButtonMapRow({
  button,
  name,
  action,
  pressed,
  onChange,
}: {
  button: ControllerButton;
  name: string;
  action: ControllerAction;
  pressed: boolean;
  onChange: (button: ControllerButton, action: ControllerAction) => void;
}) {
  const id = useId();
  return (
    <li
      className={`map-row${pressed ? ' is-pressed' : ''}`}
      data-testid={`button-row-${button}`}
      data-pressed={pressed || undefined}
    >
      <span className="map-name">
        <label htmlFor={id}>{name}</label>
        <span className="map-pressed" aria-hidden={!pressed}>
          {pressed ? 'pressed' : ''}
        </span>
      </span>
      <select
        id={id}
        data-testid={`button-map-${button}`}
        value={action}
        onChange={(e) => onChange(button, e.currentTarget.value as ControllerAction)}
      >
        {ACTION_OPTIONS.map((a) => (
          <option key={a} value={a}>
            {CONTROLLER_ACTION_LABELS[a]}
          </option>
        ))}
      </select>
    </li>
  );
}

function GripGroup({
  grip,
  buttons,
  lit,
  onChange,
}: {
  grip: Grip;
  buttons: Settings['shifting']['buttons'];
  lit: ControllerButton | null;
  onChange: (button: ControllerButton, action: ControllerAction) => void;
}) {
  const headId = useId();
  return (
    <div className="map-grip" role="group" aria-labelledby={headId}>
      <h4 id={headId} className="map-grip-title">
        {GRIP_LABEL[grip]}
      </h4>
      <ul className="list map-list">
        {buttonsOnGrip(grip).map(({ button, name }) => (
          <ButtonMapRow
            key={button}
            button={button}
            name={name}
            action={actionOf(buttons, button)}
            pressed={lit === button}
            onChange={onChange}
          />
        ))}
      </ul>
    </div>
  );
}

/** The button that was pressed within the last PRESSED_MS, for the row highlight. */
function useLitButton(): { lit: ControllerButton | null; last: ControllerButton | null } {
  const last = useAppState((s) => s.lastButton);
  const [lit, setLit] = useState<ControllerButton | null>(() =>
    last && Date.now() - last.at < PRESSED_MS ? last.button : null,
  );
  useEffect(() => {
    if (!last) return;
    const left = PRESSED_MS - (Date.now() - last.at);
    if (left <= 0) return;
    setLit(last.button);
    const t = setTimeout(() => setLit(null), left);
    return () => clearTimeout(t);
  }, [last]);
  return { lit, last: last?.button ?? null };
}

export function ButtonMapping({ buttons }: { buttons: Settings['shifting']['buttons'] }) {
  const app = useApp();
  const connected = useAppState((s) => s.live?.devices.controller?.state === 'connected');
  const { lit, last } = useLitButton();
  const onChange = (button: ControllerButton, action: ControllerAction): void => {
    void app.updateSettings({ shifting: { buttons: { [button]: action } } });
  };
  const isDefault = isDefaultMapping(buttons);
  return (
    <>
      <div className="subhead subhead-row">
        <h3 className="subhead-title">Controller buttons</h3>
        <button
          type="button"
          className="btn btn-small btn-quiet"
          data-testid="button-map-reset"
          disabled={isDefault}
          onClick={() => void app.updateSettings({ shifting: { buttons: defaultButtonsPatch() } })}
        >
          Reset to defaults
        </button>
      </div>
      <div className="card" data-testid="button-mapping">
        <p className="map-live" role="status" data-testid="button-last">
          <span className={`map-live-dot${lit ? ' is-on' : ''}`} aria-hidden="true" />
          {last ? (
            <>
              Last button: <strong>{buttonLabel(last)}</strong>
            </>
          ) : connected ? (
            'Press a button on the controller: its row lights up here.'
          ) : (
            'Connect the controller to see which button you press.'
          )}
        </p>
        <div className="map-grips">
          <GripGroup grip="left" buttons={buttons} lit={lit} onChange={onChange} />
          <GripGroup grip="right" buttons={buttons} lit={lit} onChange={onChange} />
        </div>
      </div>
      <p className="hint section-foot">
        All sixteen buttons are decoded. If a button does the wrong thing, change it here; keyboard
        shifting always works.
      </p>
    </>
  );
}

// ───────────── analog levers ─────────────

const LEVER_FUNCTIONS: readonly LeverFunction[] = ['steerLeft', 'steerRight', 'brake', 'none'];
const SIDE_LABEL: Record<LeverSide, string> = { left: 'Left lever', right: 'Right lever' };

/** The bar's fill colour follows what the current direction does. */
const FILL_CLASS: Record<LeverFunction, string> = {
  steerLeft: 'is-steer',
  steerRight: 'is-steer',
  brake: 'is-brake',
  none: 'is-none',
};

function LeverDirection({
  side,
  direction,
  value,
  onChange,
}: {
  side: LeverSide;
  direction: 'positive' | 'negative';
  value: LeverFunction;
  onChange: (side: LeverSide, direction: 'positive' | 'negative', fn: LeverFunction) => void;
}) {
  const id = useId();
  return (
    <div className={`lever-dir lever-dir-${direction}`}>
      <label htmlFor={id}>
        {direction === 'negative' ? 'When the bar moves left (−)' : 'When the bar moves right (+)'}
      </label>
      <select
        id={id}
        data-testid={`lever-${side}-${direction}`}
        value={value}
        onChange={(e) => onChange(side, direction, e.currentTarget.value as LeverFunction)}
      >
        {LEVER_FUNCTIONS.map((fn) => (
          <option key={fn} value={fn}>
            {LEVER_FUNCTION_LABELS[fn]}
          </option>
        ))}
      </select>
    </div>
  );
}

function LeverGrip({
  side,
  levers,
  connected,
  onChange,
  onSwap,
}: {
  side: LeverSide;
  levers: LeverSettings;
  connected: boolean;
  onChange: (side: LeverSide, direction: 'positive' | 'negative', fn: LeverFunction) => void;
  onSwap: (side: LeverSide) => void;
}) {
  const headId = useId();
  // A primitive: only this grip re-renders, and only when its lever moves (≤ 20 Hz).
  const value = useAppState((s) => s.levers?.[side] ?? 0);
  const out = gripOutput(side, value, levers);
  const pct = Math.round(value * 100);
  const dz = levers.deadzone * 100;
  const assignment = levers[side];
  const fill = out.direction ? FILL_CLASS[out.fn] : 'is-rest';
  return (
    <div
      className="lever-grip"
      role="group"
      aria-labelledby={headId}
      data-testid={`lever-${side}`}
      data-value={pct}
    >
      <div className="lever-head">
        <h4 id={headId} className="map-grip-title lever-title">
          {SIDE_LABEL[side]}
        </h4>
        <output className="lever-value" data-testid={`lever-${side}-value`}>
          {formatLeverPercent(value)}
        </output>
      </div>
      <div
        className="lever-bar"
        role="meter"
        aria-label={`${SIDE_LABEL[side]} position`}
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={formatLeverPercent(value)}
      >
        <span
          className="lever-dead"
          style={{ left: `${50 - dz / 2}%`, width: `${dz}%` }}
          title={`Dead zone ±${Math.round(dz)} %`}
        />
        <span
          className={`lever-fill ${fill}`}
          style={
            pct >= 0
              ? { left: '50%', width: `${pct / 2}%` }
              : { left: `${50 + pct / 2}%`, width: `${-pct / 2}%` }
          }
        />
        <span className="lever-zero" />
      </div>
      <div className="lever-scale" aria-hidden="true">
        <span>−100</span>
        <span>0</span>
        <span>+100</span>
      </div>
      <div className="lever-dirs">
        <LeverDirection
          side={side}
          direction="negative"
          value={assignment.negative}
          onChange={onChange}
        />
        <LeverDirection
          side={side}
          direction="positive"
          value={assignment.positive}
          onChange={onChange}
        />
      </div>
      <div className="lever-foot">
        <p className={`lever-result ${fill}`} data-testid={`lever-${side}-result`}>
          {connected ? describeGrip(out) : 'Not connected'}
        </p>
        <button
          type="button"
          className="btn btn-small btn-quiet"
          data-testid={`lever-${side}-swap`}
          disabled={assignment.positive === assignment.negative}
          onClick={() => onSwap(side)}
        >
          Swap brake and steer on this lever
        </button>
      </div>
    </div>
  );
}

/**
 * Live display and assignment of the two analog levers. Each lever moves both
 * ways; each direction gets a function. The default assignment is a guess
 * from one hardware capture, so the display shows exactly what arrives.
 */
export function LeverMapping({ levers }: { levers: LeverSettings }) {
  const app = useApp();
  const connected = useAppState((s) => s.live?.devices.controller?.state === 'connected');
  const onChange = (side: LeverSide, direction: 'positive' | 'negative', fn: LeverFunction) => {
    void app.updateSettings({ shifting: { levers: { [side]: { [direction]: fn } } } });
  };
  const onSwap = (side: LeverSide) => {
    void app.updateSettings({ shifting: { levers: { [side]: swapGrip(levers, side)[side] } } });
  };
  return (
    <>
      <div className="subhead subhead-row">
        <h3 className="subhead-title">Brake and steering levers</h3>
        <button
          type="button"
          className="btn btn-small btn-quiet"
          data-testid="lever-reset"
          disabled={isDefaultLevers(levers)}
          onClick={() =>
            void app.updateSettings({ shifting: { levers: structuredClone(DEFAULT_LEVERS) } })
          }
        >
          Reset to defaults
        </button>
      </div>
      <div className="card" data-testid="lever-mapping">
        <p className="map-live lever-intro">
          {connected
            ? 'Move a lever: its bar follows. Each lever moves both ways, and each way can steer or brake.'
            : 'Connect the controller to see the levers move here.'}
        </p>
        <div className="map-grips">
          <LeverGrip
            side="left"
            levers={levers}
            connected={connected}
            onChange={onChange}
            onSwap={onSwap}
          />
          <LeverGrip
            side="right"
            levers={levers}
            connected={connected}
            onChange={onChange}
            onSwap={onSwap}
          />
        </div>
        <div className="lever-deadzone">
          <RangeField
            label="Dead zone around rest"
            value={levers.deadzone}
            min={0}
            max={0.2}
            step={0.01}
            testId="lever-deadzone"
            format={(v) => `±${Math.round(v * 100)} %`}
            onCommit={(deadzone) => void app.updateSettings({ shifting: { levers: { deadzone } } })}
          />
        </div>
      </div>
      <p className="hint section-foot" data-testid="lever-hint">
        The default assignment was confirmed on the real controllers. If pulling the brake steers on
        yours (or the other way round), press “Swap brake and steer on this lever” or pick the right
        function for each direction.
      </p>
    </>
  );
}

// ───────────── diagnostics ─────────────

export function DiagnosticsCard() {
  const app = useApp();
  const [busy, setBusy] = useState<'export' | 'copy' | null>(null);
  const run = (kind: 'export' | 'copy', task: () => Promise<unknown>): void => {
    setBusy(kind);
    void task().finally(() => setBusy(null));
  };
  return (
    <div className="card diag" data-testid="settings-diagnostics">
      <div className="diag-text">
        <p>
          Freilauf keeps a plain-text log of what the app and your devices do, so a problem on real
          hardware can be traced. It contains device names and protocol details, but not your name,
          body data, FTP, ride samples or full room codes.
        </p>
        <p className="hint">
          What exactly is in it: “Diagnostic log” in the project documentation
          (docs/diagnostics.md).
        </p>
      </div>
      <div className="button-row diag-actions">
        <button
          type="button"
          className="btn"
          data-testid="log-export"
          disabled={busy !== null}
          onClick={() => run('export', () => app.exportLog())}
        >
          {busy === 'export' ? 'Exporting…' : 'Export log…'}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="log-copy"
          disabled={busy !== null}
          onClick={() => run('copy', () => app.copyRecentLog())}
        >
          {busy === 'copy' ? 'Copying…' : 'Copy recent log'}
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          data-testid="log-open-folder"
          onClick={() => void app.openLogFolder()}
        >
          Open log folder
        </button>
      </div>
      <div className="diag-help">
        <h4 className="diag-help-title">Help decode the controllers</h4>
        <p className="hint">
          All buttons are decoded; the levers are what is still being worked out. Connect the
          controller, open “Brake and steering levers” above, and on each grip, slowly: pull the
          brake all the way and let go, then push the lever sideways all the way and let go. Note
          which way the bar moved each time, then export the log and attach it to a GitHub issue
          together with your notes.
        </p>
      </div>
    </div>
  );
}
