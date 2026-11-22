/**
 * Preload for both windows. Runs sandboxed (contextIsolation + sandbox), so it
 * may only `require('electron')`: everything else here is type-only or local.
 * Built as CommonJS (`out/preload/index.cjs`) because sandboxed preloads cannot
 * be ES modules.
 *
 * Which window this is, sim mode and BLE logging come from command-line
 * switches that main passes via `webPreferences.additionalArguments`.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  Bounds,
  DeepPartial,
  FreilaufApi,
  LiveState,
  LogContext,
  LogInfo,
  LogLevel,
  PickerDevice,
  RideListItem,
  Settings,
} from '../shared/contract';
import { ARG, IPC } from '../shared/ipc';

function arg(prefix: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

const windowName: 'main' | 'overlay' = arg(ARG.window) === 'overlay' ? 'overlay' : 'main';

type Listener<T> = (value: T) => void;

function listenerSet<T>(channel: string, onMessage?: (value: T) => void) {
  const listeners = new Set<Listener<T>>();
  const deliver = (value: T, only?: Listener<T>) => {
    for (const l of only ? [only] : [...listeners]) {
      try {
        l(value);
      } catch (e) {
        console.error(`[freilauf] ${channel} listener threw`, e);
      }
    }
  };
  ipcRenderer.on(channel, (_event, value: T) => {
    onMessage?.(value);
    deliver(value);
  });
  return {
    deliver,
    subscribe(listener: Listener<T>): () => void {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Latest live state and edit mode are cached here so a subscriber gets the
// current value immediately (also after an overlay reload: the cache is
// primed from main on load).
let lastLive: LiveState | undefined;
let editMode: boolean | undefined;

const live = listenerSet<LiveState>(IPC.liveState, (s) => {
  lastLive = s;
});
const edit = listenerSet<boolean>(IPC.overlayEditMode, (v) => {
  editMode = v;
});
const settingsChanged = listenerSet<Settings>(IPC.settingsChanged);
const pickerDevices = listenerSet<PickerDevice[]>(IPC.btPickerDevices);

if (windowName === 'overlay') {
  void ipcRenderer.invoke(IPC.liveGet).then((s: LiveState | null) => {
    if (s && lastLive === undefined) {
      lastLive = s;
      live.deliver(s);
    }
  });
}
void ipcRenderer.invoke(IPC.overlayGetEditMode).then((v: boolean) => {
  if (editMode === undefined) {
    editMode = v;
    edit.deliver(v);
  }
});

// ───────────── diagnostic log: batched to main ─────────────
// Entries are stamped here (so ordering and timing are exact) and sent in
// batches, so a burst of log calls costs one IPC message.

interface QueuedEntry {
  time: number;
  level: LogLevel;
  source: string;
  message: string;
  context?: LogContext;
}

const LOG_FLUSH_MS = 200;
const LOG_BATCH = 200;
const LOG_QUEUE_MAX = 5000;
let logQueue: QueuedEntry[] = [];
let logDropped = 0;
let logTimer: ReturnType<typeof setTimeout> | null = null;

function flushLog(): void {
  if (logTimer) clearTimeout(logTimer);
  logTimer = null;
  if (logDropped > 0) {
    logQueue.push({
      time: Date.now(),
      level: 'warn',
      source: 'renderer',
      message: `${logDropped} log entries dropped (renderer queue full)`,
    });
    logDropped = 0;
  }
  while (logQueue.length > 0) {
    const batch = logQueue.slice(0, LOG_BATCH);
    logQueue = logQueue.slice(LOG_BATCH);
    try {
      ipcRenderer.send(IPC.diagLog, batch);
    } catch {
      // Not cloneable (should not happen: contexts are made JSON-safe first) — retry as text.
      try {
        ipcRenderer.send(
          IPC.diagLog,
          batch.map((e) => ({
            ...e,
            context: e.context ? { text: safeJson(e.context).slice(0, 4000) } : undefined,
          })),
        );
      } catch {
        // give up on this batch
      }
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x: unknown) =>
      x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : x,
    );
  } catch {
    return '"[unserialisable]"';
  }
}

/** A structured-cloneable copy of the context (JSON round trip, size-capped). */
function cloneContext(context: LogContext): LogContext {
  const json = safeJson(context);
  if (json.length > 16_000) return { truncated: json.slice(0, 16_000) };
  const parsed = JSON.parse(json) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as LogContext)
    : { value: parsed };
}

function queueLog(level: LogLevel, source: string, message: string, context?: LogContext): void {
  try {
    if (logQueue.length >= LOG_QUEUE_MAX) {
      logDropped++;
      return;
    }
    const entry: QueuedEntry = { time: Date.now(), level, source, message: String(message) };
    if (context !== undefined) {
      // Make it cloneable now: the caller may keep mutating its objects.
      entry.context = cloneContext(context);
    }
    logQueue.push(entry);
    if (logQueue.length >= LOG_BATCH) flushLog();
    else logTimer ??= setTimeout(flushLog, LOG_FLUSH_MS);
  } catch {
    // Logging must never throw into the app.
  }
}

const windowSource = windowName === 'overlay' ? 'overlay' : 'renderer';

// Uncaught errors of the page. The listener runs in the preload's isolated
// world; the message, file and line are always available, the stack when the
// error object can be read across worlds.
window.addEventListener('error', (e: ErrorEvent) => {
  const err = e.error as { name?: unknown; stack?: unknown } | null | undefined;
  queueLog('error', windowSource, `uncaught error: ${e.message}`, {
    file: e.filename,
    line: e.lineno,
    column: e.colno,
    name: typeof err?.name === 'string' ? err.name : undefined,
    stack: typeof err?.stack === 'string' ? err.stack : undefined,
  });
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const r = e.reason as { name?: unknown; message?: unknown; stack?: unknown } | null | undefined;
  const message =
    r && typeof r === 'object' && typeof r.message === 'string' ? r.message : String(e.reason);
  queueLog('error', windowSource, `unhandled promise rejection: ${message}`, {
    name: r && typeof r === 'object' && typeof r.name === 'string' ? r.name : undefined,
    stack: r && typeof r === 'object' && typeof r.stack === 'string' ? r.stack : undefined,
  });
});
window.addEventListener('pagehide', flushLog);
window.addEventListener('beforeunload', flushLog);

const api: FreilaufApi = {
  simMode: arg(ARG.sim) === '1',
  bleLogEnabled: arg(ARG.bleLog) === '1',
  window: windowName,

  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Settings>,
    update: (patch: DeepPartial<Settings>) =>
      ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<Settings>,
    forgetDevice: (kind) => ipcRenderer.invoke(IPC.settingsForgetDevice, kind) as Promise<Settings>,
    onChange: (listener) => settingsChanged.subscribe(listener),
  },

  live: {
    publish: (state) => ipcRenderer.send(IPC.livePublish, state),
    onState: (listener) => {
      const off = live.subscribe(listener);
      if (lastLive !== undefined) live.deliver(lastLive, listener);
      return off;
    },
  },

  overlay: {
    setEditMode: (value) => ipcRenderer.send(IPC.overlaySetEditMode, value),
    onEditMode: (listener) => {
      const off = edit.subscribe(listener);
      if (editMode !== undefined) edit.deliver(editMode, listener);
      return off;
    },
    setBounds: (bounds: Bounds) => ipcRenderer.send(IPC.overlaySetBounds, bounds),
    getBounds: () => ipcRenderer.invoke(IPC.overlayGetBounds) as Promise<Bounds>,
  },

  bluetooth: {
    grantUserGesture: () => ipcRenderer.invoke(IPC.btGrantUserGesture) as Promise<void>,
    prepareChooser: (autoSelect) =>
      ipcRenderer.invoke(IPC.btPrepareChooser, autoSelect) as Promise<void>,
    onPickerDevices: (listener) => pickerDevices.subscribe(listener),
    pick: (deviceId) => ipcRenderer.send(IPC.btPick, deviceId),
    cancelPicker: () => ipcRenderer.send(IPC.btCancelPicker),
  },

  rides: {
    list: () => ipcRenderer.invoke(IPC.ridesList) as Promise<RideListItem[]>,
    save: (ride, finished) => ipcRenderer.invoke(IPC.ridesSave, ride, finished) as Promise<void>,
    exportFit: (id) => ipcRenderer.invoke(IPC.ridesExportFit, id) as Promise<string | null>,
    delete: (id) => ipcRenderer.invoke(IPC.ridesDelete, id) as Promise<void>,
    openFolder: () => ipcRenderer.invoke(IPC.ridesOpenFolder) as Promise<void>,
  },

  diagnostics: {
    bleLog: (line) => queueLog('debug', 'ble', String(line)),
    logFilePath: () => ipcRenderer.invoke(IPC.diagLogFilePath) as Promise<string>,
    log: (level, source, message, context) => queueLog(level, source, message, context),
    getLogInfo: () => ipcRenderer.invoke(IPC.diagLogInfo) as Promise<LogInfo>,
    openLogFolder: async () => {
      flushLog();
      await (ipcRenderer.invoke(IPC.diagOpenLogFolder) as Promise<void>);
    },
    exportLog: () => {
      flushLog();
      return ipcRenderer.invoke(IPC.diagExportLog) as Promise<string | null>;
    },
    readRecent: (maxBytes) => {
      flushLog();
      return ipcRenderer.invoke(IPC.diagReadRecent, maxBytes) as Promise<string>;
    },
  },
};

contextBridge.exposeInMainWorld('freilauf', api);
