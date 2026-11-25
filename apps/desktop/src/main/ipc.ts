/**
 * IPC handlers. Every message is checked for its sender (the main frame of one
 * of our two windows, showing one of our pages) and its payload shape before
 * anything happens.
 */
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { LiveState, WatchRelayStatus } from '../shared/contract';
import { IPC } from '../shared/ipc';
import { isLogLevel } from '../renderer/core/logFormat';
import type { BluetoothChooser } from './bluetoothChooser';
import type { DiagnosticLog } from './logFile';
import type { OverlayController } from './overlay';
import type { RideStore } from './rideStore';
import type { AppOrigin } from './security';
import { isAppUrl } from './security';
import { isDeviceKind, isPlainObject } from './settings';
import type { SettingsStore } from './settingsStore';
import { isAutoSelect, isBounds, isLiveState, isRecordedRide, isShortString } from './validate';

export type WindowName = 'main' | 'overlay';

export interface IpcDeps {
  origin: AppOrigin;
  mainWindow(): BrowserWindow | null;
  overlay(): OverlayController | null;
  chooser(): BluetoothChooser | null;
  settings: SettingsStore;
  rides: RideStore;
  diag: DiagnosticLog;
  exportFit(id: string): Promise<string | null>;
  openRidesFolder(): Promise<void>;
  openLogFolder(): Promise<void>;
  exportLog(): Promise<string | null>;
  log(m: string): void;
  /** Share with my watch: the current status. */
  watchRelayStatus?(): WatchRelayStatus;
  /** Every accepted LiveState from the main window (feeds the watch relay). */
  onLive?(state: LiveState): void;
}

function bad(channel: string): never {
  throw new Error(`${channel}: invalid arguments`);
}

export function registerIpc(deps: IpcDeps): { lastLive(): LiveState | null } {
  let lastLive: LiveState | null = null;

  const identify = (event: IpcMainEvent | IpcMainInvokeEvent): WindowName | null => {
    const frame = event.senderFrame;
    if (!frame) return null;
    const main = deps.mainWindow();
    const overlay = deps.overlay()?.win ?? null;
    let who: WindowName | null = null;
    if (main && !main.isDestroyed() && event.sender === main.webContents) who = 'main';
    else if (overlay && !overlay.isDestroyed() && event.sender === overlay.webContents)
      who = 'overlay';
    if (!who) return null;
    if (frame !== event.sender.mainFrame || !isAppUrl(deps.origin, frame.url)) return null;
    return who;
  };

  /** ipcMain.handle with sender check; a rejected sender gets an error. */
  const handle = (
    channel: string,
    allowed: readonly WindowName[],
    fn: (who: WindowName, ...args: unknown[]) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const who = identify(event);
      if (!who || !allowed.includes(who)) {
        deps.log(`rejected ${channel} from ${who ?? 'unknown sender'}`);
        throw new Error(`${channel} is not allowed from this window`);
      }
      return fn(who, ...args);
    });
  };

  /** ipcMain.on with sender check; bad messages are logged and dropped. */
  const on = (
    channel: string,
    allowed: readonly WindowName[],
    fn: (who: WindowName, ...args: unknown[]) => void,
  ) => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      const who = identify(event);
      if (!who || !allowed.includes(who)) {
        deps.log(`dropped ${channel} from ${who ?? 'unknown sender'}`);
        return;
      }
      try {
        fn(who, ...args);
      } catch (e) {
        deps.log(`${channel} failed: ${String(e)}`);
      }
    });
  };

  const both = ['main', 'overlay'] as const;
  const mainOnly = ['main'] as const;

  // settings
  handle(IPC.settingsGet, both, () => deps.settings.get());
  handle(IPC.settingsUpdate, both, (_who, patch) => {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
      bad(IPC.settingsUpdate);
    return deps.settings.update(patch);
  });
  handle(IPC.settingsForgetDevice, both, (_who, kind) => {
    if (!isDeviceKind(kind)) bad(IPC.settingsForgetDevice);
    return deps.settings.forgetDevice(kind);
  });

  // live state relay
  on(IPC.livePublish, mainOnly, (_who, state) => {
    if (!isLiveState(state)) {
      deps.log('live.publish: invalid LiveState dropped');
      return;
    }
    lastLive = state;
    deps.onLive?.(state);
    const ov = deps.overlay()?.win;
    if (ov && !ov.isDestroyed()) ov.webContents.send(IPC.liveState, state);
  });
  handle(IPC.liveGet, both, () => lastLive);

  // overlay
  on(IPC.overlaySetEditMode, both, (_who, edit) => {
    if (typeof edit !== 'boolean') return deps.log('overlay.setEditMode: expected a boolean');
    deps.overlay()?.setEditMode(edit);
  });
  handle(IPC.overlayGetEditMode, both, () => deps.overlay()?.isEditMode ?? false);
  on(IPC.overlaySetBounds, ['overlay'], (_who, bounds) => {
    const ov = deps.overlay();
    if (!ov) return;
    if (!isBounds(bounds)) return deps.log('overlay.setBounds: invalid bounds');
    if (!ov.isEditMode) return deps.log('overlay.setBounds outside edit mode ignored');
    ov.setBounds(bounds);
  });
  handle(IPC.overlayGetBounds, both, () => {
    const ov = deps.overlay();
    if (!ov) throw new Error('overlay window is not available');
    return ov.getBounds();
  });

  // bluetooth
  handle(IPC.btGrantUserGesture, mainOnly, async () => {
    const win = deps.mainWindow();
    if (!win || win.isDestroyed()) return;
    // userGesture=true gives the page a transient activation, which
    // navigator.bluetooth.requestDevice() requires.
    await win.webContents.executeJavaScript('void 0', true);
  });
  handle(IPC.btPrepareChooser, mainOnly, (_who, autoSelect) => {
    if (!isAutoSelect(autoSelect)) bad(IPC.btPrepareChooser);
    deps.chooser()?.prepare(autoSelect);
  });
  on(IPC.btPick, mainOnly, (_who, id) => {
    if (!isShortString(id)) return deps.log('bluetooth.pick: invalid device id');
    deps.chooser()?.pick(id);
  });
  on(IPC.btCancelPicker, mainOnly, () => deps.chooser()?.cancel());

  // rides
  handle(IPC.ridesList, mainOnly, () => deps.rides.list());
  handle(IPC.ridesLoad, mainOnly, (_who, id) => {
    if (!isShortString(id)) bad(IPC.ridesLoad);
    return deps.rides.loadRide(id);
  });
  handle(IPC.ridesSave, mainOnly, async (_who, ride, finished) => {
    if (!isRecordedRide(ride) || typeof finished !== 'boolean') bad(IPC.ridesSave);
    await deps.rides.save(ride, finished);
  });
  handle(IPC.ridesExportFit, mainOnly, (_who, id) => {
    if (!isShortString(id)) bad(IPC.ridesExportFit);
    return deps.exportFit(id);
  });
  handle(IPC.ridesDelete, mainOnly, async (_who, id) => {
    if (!isShortString(id)) bad(IPC.ridesDelete);
    await deps.rides.delete(id);
  });
  handle(IPC.ridesOpenFolder, mainOnly, () => deps.openRidesFolder());

  // diagnostics
  on(IPC.diagBleLog, both, (_who, line) => {
    if (typeof line !== 'string') return;
    deps.diag.log('debug', 'ble', line.slice(0, 4000));
  });
  on(IPC.diagLog, both, (who, batch) => {
    if (!Array.isArray(batch)) return;
    const now = Date.now();
    for (const e of batch.slice(0, 500) as unknown[]) {
      if (!isPlainObject(e)) continue;
      const { time, level, source, message, context } = e;
      if (!isLogLevel(level) || typeof source !== 'string' || typeof message !== 'string') continue;
      deps.diag.write({
        // The renderer's clock is the same machine's; still keep it plausible.
        time: typeof time === 'number' && Math.abs(time - now) < 3_600_000 ? time : now,
        level,
        // Overlay entries are always marked as such, whatever the page says.
        source: who === 'overlay' && source === 'renderer' ? 'overlay' : source,
        message: message.slice(0, 4000),
        context: isPlainObject(context) ? context : undefined,
      });
    }
  });
  handle(IPC.diagLogFilePath, both, () => deps.diag.file.filePath);
  handle(IPC.diagLogInfo, mainOnly, () => deps.diag.file.info());
  handle(IPC.diagOpenLogFolder, mainOnly, () => deps.openLogFolder());
  handle(IPC.diagExportLog, mainOnly, () => deps.exportLog());
  handle(IPC.diagReadRecent, mainOnly, (_who, maxBytes) => {
    if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes < 0)
      bad(IPC.diagReadRecent);
    return deps.diag.file.readRecent(maxBytes);
  });

  // share with my watch (settings go through settings:update)
  handle(
    IPC.watchRelayStatus,
    mainOnly,
    (): WatchRelayStatus =>
      deps.watchRelayStatus?.() ?? { state: 'unavailable', reason: 'Not available.' },
  );

  return { lastLive: () => lastLive };
}
