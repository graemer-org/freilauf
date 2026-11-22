/**
 * FreilaufApi for a plain browser tab (the Docker / web build). The desktop
 * renderer talks to its host only through this interface, so the whole UI
 * and App run unchanged on top of it.
 *
 *  - settings: localStorage (BrowserSettingsStore), synced across tabs;
 *  - rides: IndexedDB (RideRepository), `.fit` export is a download;
 *  - live: in-page (the PiP window renders from the same JS realm);
 *  - overlay: mapped to the Picture-in-Picture stats window where it makes sense;
 *  - bluetooth: the browser shows its own chooser, so these are no-ops;
 *  - diagnostics: the same log lines as the desktop log file, kept in an
 *    in-memory ring buffer (warn and error also go to the console); "export"
 *    downloads them as a text file.
 */
import type {
  Bounds,
  FreilaufApi,
  LiveState,
  LogContext,
  LogLevel,
} from '../../desktop/src/shared/contract';
import {
  formatLogLine,
  randomSessionId,
  redactEntry,
  sessionHeaderEntries,
  tailText,
} from '../../desktop/src/renderer/core/logFormat';
import type { RideRepository } from './rideRepository';
import type { BrowserSettingsStore } from './settingsStore';

/** What the overlay part of the API needs from the Picture-in-Picture window. */
export interface OverlayWindowHost {
  /** Current bounds of the open window, or null when it is closed. */
  bounds(): Bounds | null;
  resize(bounds: Bounds): void;
}

export type Notifier = (kind: 'info' | 'error', message: string) => void;

export interface BrowserApiDeps {
  settings: BrowserSettingsStore;
  rides: RideRepository;
  simMode: boolean;
  bleLogEnabled: boolean;
  overlayWindow?: OverlayWindowHost | null;
  /** Max diagnostics lines kept in memory. Default 5000. */
  diagnosticsLimit?: number;
  /** Saves the exported log; default: a browser download. */
  saveLogFile?: (fileName: string, text: string) => void;
  /** Facts for the session header (user agent, screen, …). */
  sessionFacts?: Record<string, unknown>;
  /** Write a session header when created. Default true. */
  sessionHeader?: boolean;
}

export interface BrowserApi extends FreilaufApi {
  /** Wire user-facing messages (e.g. to App.notify) once the App exists. */
  setNotifier(notifier: Notifier): void;
  /** The in-memory diagnostics log (also reachable from the console as `freilaufDiagnostics()`). */
  diagnosticLines(): readonly string[];
}

/** Flags in the page's query string: `?sim=1`, `?blelog=1`. */
export function queryFlag(search: string, name: string): boolean {
  const value = new URLSearchParams(search).get(name);
  return value !== null && ['', '1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export const DEFAULT_PIP_BOUNDS: Bounds = { x: 0, y: 0, width: 420, height: 240 };

export const OPEN_FOLDER_MESSAGE =
  'In the browser, rides are stored in this browser’s own storage (IndexedDB) for this address. ' +
  'Use “Export .fit” to save a ride as a file.';

export const LOG_FOLDER_MESSAGE =
  'In the browser, the diagnostic log is kept in memory for this tab only. ' +
  'Use “Export log” to download it as a file (it is lost when the tab is closed or reloaded).';

export const LOG_LOCATION = 'browser memory (this tab)';

export const EDIT_MODE_MESSAGE =
  'The web version has no free-floating overlay. Use “Pop-out stats” for a small always-on-top ' +
  'window and resize it by dragging its edges.';

export function createBrowserApi(deps: BrowserApiDeps): BrowserApi {
  let notify: Notifier = (kind, message) =>
    kind === 'error' ? console.error(message) : console.info(message);
  const liveListeners = new Set<(state: LiveState) => void>();
  const diagnostics: string[] = [];
  const limit = deps.diagnosticsLimit ?? 5000;
  const sessionId = randomSessionId();
  const saveLogFile =
    deps.saveLogFile ??
    ((fileName: string, text: string) =>
      downloadFile(fileName, new TextEncoder().encode(text), 'text/plain;charset=utf-8'));

  const write = (level: LogLevel, source: string, message: string, context?: LogContext) => {
    try {
      let riderName: string | undefined;
      try {
        riderName = deps.settings.get().rider.name;
      } catch {
        riderName = undefined;
      }
      const entry = redactEntry(
        { time: Date.now(), level, source, message, context },
        { riderName },
      );
      const line = formatLogLine(entry);
      diagnostics.push(line);
      if (diagnostics.length > limit) diagnostics.splice(0, diagnostics.length - limit);
      // console.warn for errors too: real exceptions already show up as console
      // errors on their own; a logged (handled) failure should not look like one.
      if (level === 'error' || level === 'warn') console.warn(`[freilauf] ${line}`);
    } catch {
      // never throw into the app
    }
  };
  const allText = () => (diagnostics.length ? `${diagnostics.join('\n')}\n` : '');

  if (deps.sessionHeader !== false) {
    for (const e of sessionHeaderEntries(
      {
        sessionId,
        app: 'Freilauf (web)',
        version: 'web',
        facts: {
          app: { simMode: deps.simMode, rawBleFrames: deps.bleLogEnabled },
          ...deps.sessionFacts,
        },
      },
      Date.now(),
    )) {
      write(e.level, e.source, e.message, e.context);
    }
  }

  const api: BrowserApi = {
    simMode: deps.simMode,
    bleLogEnabled: deps.bleLogEnabled,
    window: 'main',

    setNotifier(notifier) {
      notify = notifier;
    },
    diagnosticLines: () => diagnostics,

    settings: {
      get: async () => deps.settings.get(),
      // Synchronous work inside: errors (e.g. storage full) reject the promise.
      update: async (patch) => deps.settings.update(patch),
      forgetDevice: async (kind) => deps.settings.forgetDevice(kind),
      onChange: (listener) => deps.settings.onChange(listener),
    },

    live: {
      publish(state) {
        for (const listener of liveListeners) {
          try {
            listener(state);
          } catch (err) {
            console.error('live listener failed', err);
          }
        }
      },
      onState(listener) {
        liveListeners.add(listener);
        return () => liveListeners.delete(listener);
      },
    },

    overlay: {
      setEditMode(edit) {
        if (edit) notify('info', EDIT_MODE_MESSAGE);
      },
      onEditMode(listener) {
        listener(false);
        return () => {};
      },
      setBounds(bounds) {
        deps.overlayWindow?.resize(bounds);
      },
      getBounds: async () =>
        deps.overlayWindow?.bounds() ?? deps.settings.get().overlay.bounds ?? DEFAULT_PIP_BOUNDS,
    },

    bluetooth: {
      // The browser shows its own chooser and needs a real click for it.
      grantUserGesture: async () => {},
      prepareChooser: async () => {},
      onPickerDevices: () => () => {},
      pick: () => {},
      cancelPicker: () => {},
    },

    rides: {
      list: () => deps.rides.list(),
      load: (id) => deps.rides.load(id),
      save: (ride, finished) => deps.rides.save(ride, finished),
      exportFit: (id) => deps.rides.exportFit(id),
      delete: (id) => deps.rides.delete(id),
      openFolder: async () => notify('info', OPEN_FOLDER_MESSAGE),
    },

    diagnostics: {
      bleLog(line) {
        if (!deps.bleLogEnabled) return;
        write('debug', 'ble', String(line));
        console.debug(`[ble] ${line}`);
      },
      logFilePath: async () => `${LOG_LOCATION}; run freilaufDiagnostics() in the console`,
      log: (level, source, message, context) => write(level, source, message, context),
      getLogInfo: async () => ({
        directory: LOG_LOCATION,
        files: [{ name: 'freilauf.log', bytes: new TextEncoder().encode(allText()).length }],
      }),
      openLogFolder: async () => notify('info', LOG_FOLDER_MESSAGE),
      exportLog: async () => {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
        const fileName = `freilauf-log-${stamp}.txt`;
        const header = `Freilauf diagnostic log (web), exported ${new Date().toISOString()} (session ${sessionId}). See docs/diagnostics.md.\n`;
        saveLogFile(fileName, header + allText());
        return fileName;
      },
      readRecent: async (maxBytes) =>
        tailText(allText(), Math.max(0, Math.min(1024 * 1024, Math.floor(maxBytes)))),
    },
  };
  return api;
}

/** Triggers a browser download of `bytes`. */
export function downloadFile(fileName: string, bytes: Uint8Array, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
