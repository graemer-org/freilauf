import type { ControllerButton } from '@freilauf/devices';
import { useEffect, useId, useState } from 'react';
import type { ControllerAction, Settings } from '../../../shared/contract';
import { CONTROLLER_ACTION_LABELS } from '../../../shared/contract';
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
        Handlebar controller support is experimental and not every button is decoded yet. If a
        button does the wrong thing, change it here; keyboard shifting always works.
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
          Connect the controller, then press each button once, slowly and in order: left grip lower
          and upper shift button, D-pad up, right, down, left, power-up button; then right grip
          lower and upper shift button, A, B, Y, Z, power-up button. Leave out the on/off buttons.
          Then export the log and attach it to a GitHub issue together with the order you used.
        </p>
      </div>
    </div>
  );
}
