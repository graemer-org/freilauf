import { useEffect, useState, useSyncExternalStore } from 'react';
import type { App } from '../../desktop/src/renderer/main/appStore';
import { MainApp } from '../../desktop/src/renderer/main/ui';
import type { BluetoothAvailability } from './bluetoothAvailability';
import type { StatsPipWindow } from './pip';
import './web.css';

const DISMISS_KEY = 'freilauf.bluetoothNoticeDismissed';

function readDismissed(reason: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === reason;
  } catch {
    return false;
  }
}

function BluetoothNotice({
  availability,
  simMode,
}: {
  availability: BluetoothAvailability;
  simMode: boolean;
}) {
  const reason = availability.available ? '' : availability.reason;
  const [dismissed, setDismissed] = useState(() => readDismissed(reason));
  useEffect(() => setDismissed(readDismissed(reason)), [reason]);
  if (availability.available || dismissed) return null;
  const dismiss = (): void => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, availability.reason);
    } catch {
      // private mode etc.: dismissed for this page view only
    }
  };
  return (
    <div
      className="web-notice"
      role="alert"
      data-testid="web-bluetooth-notice"
      data-reason={availability.reason}
    >
      <div className="web-notice-text">
        <strong>{availability.title}.</strong> {availability.message}
        {simMode ? ' Simulation mode is on, so the simulated devices work regardless.' : null}
      </div>
      <button
        type="button"
        className="web-notice-dismiss"
        data-testid="web-bluetooth-notice-dismiss"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}

function PipButton({ app, pip }: { app: App; pip: StatsPipWindow }) {
  const open = useSyncExternalStore(pip.subscribe, () => pip.isOpen);
  if (!pip.supported) return null;
  return (
    <button
      type="button"
      className="btn btn-small btn-quiet web-pip-button"
      data-testid="pip-toggle"
      aria-pressed={open}
      title="Small always-on-top window with your stats (not click-through)"
      onClick={() => {
        if (open) pip.close();
        else
          pip
            .open()
            .catch((err: unknown) =>
              app.notify(
                'error',
                `Could not open the stats window: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
      }}
    >
      {open ? 'Close stats window' : 'Pop-out stats'}
    </button>
  );
}

/** Web-only chrome around the unchanged desktop main window UI. */
export function WebShell({
  app,
  pip,
  availability,
  simMode,
}: {
  app: App;
  pip: StatsPipWindow;
  availability: BluetoothAvailability;
  simMode: boolean;
}) {
  return (
    <>
      <BluetoothNotice availability={availability} simMode={simMode} />
      <MainApp app={app} extras={<PipButton app={app} pip={pip} />} />
    </>
  );
}
