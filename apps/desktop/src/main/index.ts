/**
 * Electron main process entry. Kept fast: everything the windows need is
 * loaded synchronously right after `ready`, windows are created immediately
 * with `show: false` and shown on `ready-to-show`. No splash screen.
 */
import path from 'node:path';
import { BrowserWindow, app, dialog, screen, session, shell } from 'electron';
import { ARG, IPC } from '../shared/ipc';
import { attachBluetoothChooser, installPairingHandler } from './bluetooth';
import type { BluetoothChooser } from './bluetoothChooser';
import { BleLog } from './bleLog';
import { MAIN_MIN_SIZE, centeredBounds, fitToDisplays } from './geometry';
import { registerIpc } from './ipc';
import { OverlayController } from './overlay';
import { RideStore } from './rideStore';
import type { AppOrigin } from './security';
import { hardenWebContents, installPermissionPolicy } from './security';
import { SettingsStore } from './settingsStore';
import { loadWindowState, saveWindowState } from './windowState';

const log = (m: string) => console.log(`[freilauf] ${m}`);

// --- before ready -----------------------------------------------------------

// Test isolation / portable setups: must happen before anything touches
// userData (the single-instance lock lives there too).
if (process.env.FREILAUF_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.FREILAUF_USER_DATA));
}

const simMode = process.env.FREILAUF_SIM === '1';
const bleLogEnabled = process.env.FREILAUF_BLE_LOG === '1';

if (process.platform === 'win32') app.setAppUserModelId('org.freilauf.desktop');

// The ride runs in the main window, which is usually hidden behind a
// fullscreen video. Chromium would throttle its timers (down to once a minute
// after 5 minutes), so background throttling is disabled per window and here.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Web Bluetooth on Linux is still behind Chromium's experimental flag (best effort).
if (process.platform === 'linux')
  app.commandLine.appendSwitch('enable-experimental-web-platform-features');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start(): void {
  let mainWindow: BrowserWindow | null = null;
  let overlay: OverlayController | null = null;
  let chooser: BluetoothChooser | null = null;

  const outDir = path.join(import.meta.dirname, '..');
  const preload = path.join(outDir, 'preload', 'index.cjs');
  const origin: AppOrigin = {
    devUrl:
      !app.isPackaged && process.env.ELECTRON_RENDERER_URL
        ? process.env.ELECTRON_RENDERER_URL
        : null,
    rendererDir: path.join(outDir, 'renderer'),
  };
  const load = (win: BrowserWindow, page: 'index' | 'overlay') => {
    const p = origin.devUrl
      ? win.loadURL(`${origin.devUrl.replace(/\/$/, '')}/${page}.html`)
      : win.loadFile(path.join(origin.rendererDir, `${page}.html`));
    p.catch((e: unknown) => log(`failed to load ${page}: ${String(e)}`));
  };
  const args = (name: 'main' | 'overlay') => [
    `${ARG.window}${name}`,
    `${ARG.sim}${simMode ? '1' : '0'}`,
    `${ARG.bleLog}${bleLogEnabled ? '1' : '0'}`,
  ];
  const isOurs = (wc: Electron.WebContents | null) =>
    !!wc &&
    ((!!mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents) ||
      (!!overlay && !overlay.win.isDestroyed() && wc === overlay.win.webContents));

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_e, wc) => hardenWebContents(wc, origin, log));

  app.whenReady().then(
    () => {
      const userData = app.getPath('userData');
      const settings = new SettingsStore(path.join(userData, 'settings.json'), {
        log: (m) => log(`settings: ${m}`),
      });
      const rides = new RideStore(path.join(userData, 'rides'), (m) => log(`rides: ${m}`));
      const bleLog = new BleLog(path.join(userData, 'logs', 'ble.log'), bleLogEnabled);
      const bt = (m: string) => {
        log(`bluetooth: ${m}`);
        bleLog.write(`[main] ${m}`);
      };
      const windowStatePath = path.join(userData, 'window-state.json');

      installPermissionPolicy(session.defaultSession, isOurs, origin, log);
      installPairingHandler(session.defaultSession, () => mainWindow, bt);

      // --- main window ---
      const ws = loadWindowState(windowStatePath);
      const primary = screen.getPrimaryDisplay().workArea;
      const fallback = (p: Electron.Rectangle) => centeredBounds(p, { width: 1100, height: 760 });
      const mainBounds = ws.bounds
        ? fitToDisplays(
            ws.bounds,
            screen.getAllDisplays().map((d) => d.workArea),
            primary,
            MAIN_MIN_SIZE,
            (p) => fallback(p),
          )
        : fallback(primary);
      const win = new BrowserWindow({
        ...mainBounds,
        minWidth: MAIN_MIN_SIZE.width,
        minHeight: MAIN_MIN_SIZE.height,
        show: false,
        title: 'Freilauf',
        backgroundColor: '#121417',
        autoHideMenuBar: true,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          backgroundThrottling: false,
          additionalArguments: args('main'),
        },
      });
      mainWindow = win;
      if (ws.maximized) win.maximize();
      win.once('ready-to-show', () => win.show());

      let wsTimer: ReturnType<typeof setTimeout> | null = null;
      const saveWs = () => {
        if (win.isDestroyed()) return;
        saveWindowState(windowStatePath, {
          bounds:
            win.isMaximized() || win.isMinimized() || win.isFullScreen()
              ? win.getNormalBounds()
              : win.getBounds(),
          maximized: win.isMaximized(),
        });
      };
      const scheduleWs = () => {
        if (wsTimer) clearTimeout(wsTimer);
        wsTimer = setTimeout(saveWs, 500);
      };
      win.on('move', scheduleWs);
      win.on('resize', scheduleWs);
      win.on('maximize', scheduleWs);
      win.on('unmaximize', scheduleWs);
      win.on('blur', () => overlay?.reassertTop());
      win.on('close', () => {
        if (wsTimer) clearTimeout(wsTimer);
        saveWs();
      });
      // Closing the main window quits the app (also on macOS for now).
      win.on('closed', () => {
        mainWindow = null;
        app.quit();
      });
      chooser = attachBluetoothChooser(win, bt);
      load(win, 'index');

      // --- overlay ---
      const broadcast = (channel: string, ...a: unknown[]) => {
        for (const w of [mainWindow, overlay?.win]) {
          if (w && !w.isDestroyed()) w.webContents.send(channel, ...a);
        }
      };
      overlay = new OverlayController({
        settings,
        preload,
        additionalArguments: args('overlay'),
        load: (w) => load(w, 'overlay'),
        broadcast,
        log: (m) => log(`overlay: ${m}`),
      });

      settings.onChange((s) => broadcast(IPC.settingsChanged, s));

      registerIpc({
        origin,
        mainWindow: () => mainWindow,
        overlay: () => overlay,
        chooser: () => chooser,
        settings,
        rides,
        bleLog,
        log,
        exportFit: (id) =>
          rides.exportFit(id, async (defaultFileName) => {
            const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
            const opts: Electron.SaveDialogOptions = {
              title: 'Export ride as FIT',
              defaultPath: path.join(app.getPath('documents'), defaultFileName),
              filters: [{ name: 'FIT activity', extensions: ['fit'] }],
            };
            const r = parent
              ? await dialog.showSaveDialog(parent, opts)
              : await dialog.showSaveDialog(opts);
            return r.canceled || !r.filePath ? null : r.filePath;
          }),
        openRidesFolder: async () => {
          await rides.ensureDir();
          const err = await shell.openPath(rides.dir);
          if (err) throw new Error(err);
        },
      });

      app.on('before-quit', () => {
        overlay?.setQuitting();
        if (wsTimer) clearTimeout(wsTimer);
        saveWs();
      });
      app.on('will-quit', () => {
        overlay?.unregisterHotkey();
        overlay?.close();
        settings.flushSync();
        bleLog.close();
      });
      app.on('window-all-closed', () => app.quit());
    },
    (e: unknown) => {
      console.error(e);
      app.exit(1);
    },
  );
}
