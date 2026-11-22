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
    bleLog: (line) => ipcRenderer.send(IPC.diagBleLog, line),
    logFilePath: () => ipcRenderer.invoke(IPC.diagLogFilePath) as Promise<string>,
  },
};

contextBridge.exposeInMainWorld('freilauf', api);
