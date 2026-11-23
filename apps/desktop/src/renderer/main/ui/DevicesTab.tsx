import type { DeviceKind } from '@freilauf/devices';
import { useEffect, useRef } from 'react';
import { DEVICE_KINDS, describeDevice } from './deviceStatus';
import { useApp, useAppState } from './hooks';
import { ButtonMapping, LeverMapping } from './SettingsExtras';

const ROW_LABEL: Record<DeviceKind, string> = {
  trainer: 'Trainer',
  heartRate: 'Heart rate',
  controller: 'Controllers',
};

const ROW_HINT: Record<DeviceKind, string> = {
  trainer: 'A smart trainer with standard fitness machine control.',
  heartRate: 'Any standard Bluetooth heart rate strap or watch broadcasting HR.',
  controller:
    'Smart frame controllers (shift buttons). Their protocol support is experimental — keyboard shifting always works.',
};

function DeviceRow({ kind }: { kind: DeviceKind }) {
  const app = useApp();
  const simMode = useAppState((s) => s.simMode);
  const remembered = useAppState((s) => s.settings?.devices[kind]?.name ?? null);
  const liveName = useAppState((s) => s.live?.devices[kind]?.name ?? null);
  const state = useAppState((s) => s.live?.devices[kind]?.state ?? null);
  const busy = useAppState((s) => s.busy[kind]);
  const pickerOpen = useAppState((s) => s.picker !== null);
  const { text, tone } = describeDevice(state, remembered !== null, busy);
  const name = liveName ?? remembered;

  return (
    <li className="device-row" data-testid={`device-${kind}`}>
      <div className="device-info">
        <h2 className="device-kind">{ROW_LABEL[kind]}</h2>
        <p className={name ? 'device-name' : 'device-name none'}>{name ?? 'No device paired'}</p>
        <p className="hint">{ROW_HINT[kind]}</p>
      </div>
      <span className={`chip chip-${tone}`}>
        <span className="status-mark" aria-hidden="true" />
        <span className="chip-text">{text}</span>
      </span>
      {simMode ? (
        <p className="hint device-actions">Simulated device</p>
      ) : (
        <div className="device-actions button-row">
          {busy ? (
            <span className="busy-text">{busy === 'pairing' ? 'Pairing…' : 'Searching…'}</span>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                data-testid={`pair-${kind}`}
                disabled={pickerOpen}
                onClick={() => void app.pairDevice(kind)}
              >
                {remembered ? 'Pair another' : 'Pair'}
              </button>
              {remembered !== null && state === null && (
                <button
                  type="button"
                  className="btn"
                  data-testid={`retry-${kind}`}
                  onClick={() => void app.retryDevice(kind)}
                >
                  Retry
                </button>
              )}
            </>
          )}
          {(remembered !== null || state !== null) && (
            <button
              type="button"
              className="btn btn-danger"
              data-testid={`forget-${kind}`}
              onClick={() => void app.forgetDevice(kind)}
            >
              Forget
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Button mapping and the live lever display (they used to live in Settings → Shifting). */
function Controllers() {
  const shifting = useAppState((s) => s.settings?.shifting ?? null);
  if (!shifting) return null;
  return (
    <section
      className="settings-section"
      aria-labelledby="dev-controllers"
      data-testid="devices-controllers"
    >
      <h2 id="dev-controllers" className="section-title section-head">
        Controllers
      </h2>
      <ButtonMapping buttons={shifting.buttons} />
      <LeverMapping levers={shifting.levers} />
    </section>
  );
}

export function DevicesTab() {
  const simMode = useAppState((s) => s.simMode);
  return (
    <div className="page devices">
      {simMode && (
        <p className="banner banner-info" data-testid="devices-sim-note">
          Simulation mode: simulated trainer, heart rate and controller are in use. The Simulation
          panel under the ride view changes the effort or drops a device.
        </p>
      )}
      <ul className="list card device-list">
        {DEVICE_KINDS.map((kind) => (
          <DeviceRow key={kind} kind={kind} />
        ))}
      </ul>
      <p className="hint section-foot">
        Remembered devices reconnect automatically on start. Make sure a device is awake and not
        connected to another app.
      </p>
      <Controllers />
    </div>
  );
}

const PICKER_TITLE: Record<DeviceKind, string> = {
  trainer: 'Choose a trainer',
  heartRate: 'Choose a heart rate sensor',
  controller: 'Choose a controller',
};

/** In-app Bluetooth chooser, driven by `state.picker`. */
export function DevicePicker() {
  const app = useApp();
  const picker = useAppState((s) => s.picker);
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = picker !== null;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        app.cancelPicker();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, app]);

  if (!picker) return null;
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        tabIndex={-1}
        ref={dialogRef}
        data-testid="device-picker"
      >
        <h2 id="picker-title" className="modal-title">
          {PICKER_TITLE[picker.kind]}
        </h2>
        {picker.devices.length === 0 ? (
          <p className="picker-empty">
            <span className="spinner" aria-hidden="true" /> Searching… make sure the device is awake
            and not connected to another app.
          </p>
        ) : (
          <ul className="list picker-list">
            {picker.devices.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="picker-item"
                  data-testid="picker-device"
                  onClick={() => app.pickDevice(d.id)}
                >
                  <span className="picker-name">{d.name || 'Unnamed device'}</span>
                  <span className="picker-id">{d.id}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="button-row end">
          <button
            type="button"
            className="btn"
            data-testid="picker-cancel"
            onClick={() => app.cancelPicker()}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
