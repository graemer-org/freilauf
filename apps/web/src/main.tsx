import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../desktop/src/renderer/main/appStore';
import { webRtcGroupConnector } from '../../desktop/src/renderer/main/groupConnector';
import { bluetoothAvailability, type BluetoothEnvironment } from './bluetoothAvailability';
import { createBrowserApi, downloadFile, queryFlag } from './browserApi';
import {
  BrowserBluetoothTransport,
  UnavailableBluetoothTransport,
} from './browserBluetoothTransport';
import { IndexedDbRideRecordStore } from './idbRideStore';
import { IndexedDbSceneryStore, MemorySceneryStore, type SceneryRecordStore } from './sceneryStore';
import { StatsPipWindow } from './pip';
import { MemoryRideRecordStore, RideRepository, type RideRecordStore } from './rideRepository';
import {
  BrowserSettingsStore,
  SETTINGS_CHANNEL,
  webDefaultSettings,
  type KeyValueStorage,
} from './settingsStore';
import { WebShell } from './WebShell';

function localStorageOrNull(): KeyValueStorage | null {
  try {
    const storage = window.localStorage;
    storage.getItem('freilauf.probe');
    return storage;
  } catch {
    console.warn('localStorage is unavailable; settings will not be kept after a reload.');
    return null;
  }
}

function rideRecordStore(): RideRecordStore {
  if (typeof indexedDB === 'undefined') {
    console.warn('IndexedDB is unavailable; rides are kept in memory only.');
    return new MemoryRideRecordStore();
  }
  return new IndexedDbRideRecordStore();
}

function sceneryRecordStore(): SceneryRecordStore {
  if (typeof indexedDB === 'undefined') return new MemorySceneryStore();
  return new IndexedDbSceneryStore();
}

const simMode = queryFlag(location.search, 'sim');
const bleLogEnabled = queryFlag(location.search, 'blelog');

const bluetoothEnv: BluetoothEnvironment = {
  hasBluetoothApi: 'bluetooth' in navigator && navigator.bluetooth !== undefined,
  isSecureContext: window.isSecureContext,
  protocol: location.protocol,
  host: location.host,
  userAgent: navigator.userAgent,
  isBrave: 'brave' in navigator,
};
const availability = bluetoothAvailability(bluetoothEnv);

const settings = new BrowserSettingsStore({
  storage: localStorageOrNull(),
  channel: typeof BroadcastChannel === 'function' ? new BroadcastChannel(SETTINGS_CHANNEL) : null,
  defaults: webDefaultSettings(location),
});
const rides = new RideRepository(rideRecordStore(), downloadFile);
const pip = new StatsPipWindow();
const api = createBrowserApi({
  settings,
  rides,
  simMode,
  bleLogEnabled,
  overlayWindow: pip,
  scenery: sceneryRecordStore(),
  sessionFacts: {
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    screen: {
      width: screen.width,
      height: screen.height,
      devicePixelRatio: window.devicePixelRatio,
    },
    bluetooth: {
      hasBluetoothApi: bluetoothEnv.hasBluetoothApi,
      secureContext: bluetoothEnv.isSecureContext,
      available: availability.available,
    },
  },
});
window.addEventListener('error', (e) =>
  api.diagnostics.log('error', 'renderer', `uncaught error: ${e.message}`, {
    file: e.filename,
    line: e.lineno,
    column: e.colno,
    stack: (e.error as { stack?: unknown } | null)?.stack,
  }),
);
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: unknown; stack?: unknown } | null;
  api.diagnostics.log(
    'error',
    'renderer',
    `unhandled promise rejection: ${String(r?.message ?? r)}`,
    {
      stack: r?.stack,
    },
  );
});
(window as { freilaufDiagnostics?: () => readonly string[] }).freilaufDiagnostics = () =>
  api.diagnosticLines();

const app = new App(api, webRtcGroupConnector, {
  createTransport: () =>
    bluetoothEnv.hasBluetoothApi && bluetoothEnv.isSecureContext
      ? new BrowserBluetoothTransport(navigator.bluetooth, {
          log: (line) => api.diagnostics.log('info', 'ble', `transport: ${line}`),
          gattLog: {
            debug: (m, c) => api.diagnostics.log('debug', 'ble', m, c),
            info: (m, c) => api.diagnostics.log('info', 'ble', m, c),
            warn: (m, c) => api.diagnostics.log('warn', 'ble', m, c),
            error: (m, c) => api.diagnostics.log('error', 'ble', m, c),
          },
        })
      : new UnavailableBluetoothTransport(
          availability.available ? 'Web Bluetooth is unavailable.' : `${availability.title}.`,
        ),
});
api.setNotifier((kind, message) => app.notify(kind, message));
pip.attach(app);
window.addEventListener('pagehide', () => {
  pip.close();
  app.dispose();
});

function render(current = availability): void {
  root.render(
    <StrictMode>
      <WebShell app={app} pip={pip} availability={current} simMode={simMode} />
    </StrictMode>,
  );
}

const root = createRoot(document.getElementById('root')!);
render();

// An adapter that is missing or switched off only shows up asynchronously.
if (availability.available && !simMode) {
  navigator.bluetooth
    .getAvailability()
    .then((adapterAvailable) => {
      if (!adapterAvailable) render(bluetoothAvailability({ ...bluetoothEnv, adapterAvailable }));
    })
    .catch(() => undefined);
}

// Ask the browser not to evict our IndexedDB (rides) under storage pressure.
// Chromium decides silently; no prompt is shown.
navigator.storage?.persist?.().catch(() => undefined);

app.init().catch((err: unknown) => {
  console.error('Startup failed', err);
  app.notify('error', `Startup failed: ${err instanceof Error ? err.message : String(err)}`);
});
