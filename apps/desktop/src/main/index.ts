/**
 * Electron main process entry. Kept fast: everything the windows need is
 * loaded synchronously right after `ready`, windows are created immediately
 * with `show: false` and shown on `ready-to-show`. No splash screen.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, app, dialog, screen, session, shell } from 'electron';
import type { LiveState, Settings } from '../shared/contract';
import { ARG, IPC } from '../shared/ipc';
import { attachBluetoothChooser, installPairingHandler } from './bluetooth';
import type { BluetoothChooser } from './bluetoothChooser';
import {
  installProcessHandlers,
  newSessionId,
  watchSystem,
  watchWebContents,
  writeSessionHeader,
} from './diagnostics';
import { DiagnosticLog, LogFile } from './logFile';
import { MAIN_MIN_SIZE, centeredBounds, fitToDisplays } from './geometry';
import { registerIpc } from './ipc';
import { OverlayController } from './overlay';
import { RideStore } from './rideStore';
import { helperSpawner, locateHelper } from './sensorRelay';
import { SensorRelayController, relayInputFromLive } from './sensorRelayController';
import type { AppOrigin } from './security';
import { hardenWebContents, installPermissionPolicy } from './security';
import { describeSettingsChange } from './settingsLog';
import { SettingsStore } from './settingsStore';
import { loadWindowState, saveWindowState } from './windowState';

/** The diagnostic log; created in start() once userData is known. */
let diag: DiagnosticLog | null = null;
const log = (m: string) => {
  if (diag) diag.log('info', 'main', m);
  else console.log(`[freilauf] ${m}`);
};

// --- before ready -----------------------------------------------------------

// Test isolation / portable setups: must happen before anything touches
// userData (the single-instance lock lives there too).
if (process.env.FREILAUF_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.FREILAUF_USER_DATA));
}

const simMode = process.env.FREILAUF_SIM === '1';
/** Also log every raw controller frame, uncollapsed (the capture itself is always on). */
const bleLogEnabled = process.env.FREILAUF_BLE_LOG === '1';
const startedAt = Date.now();

if (process.platform === 'win32') app.setAppUserModelId('org.graemer.freilauf');

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
  const sessionId = newSessionId();
  diag = new DiagnosticLog(new LogFile({ dir: path.join(app.getPath('userData'), 'logs') }));
  diag.setSecrets({ homeDir: os.homedir() });
  installProcessHandlers(diag);
  const d = diag;
  const mainLog = d.scope('main');

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
    p.catch((e: unknown) => mainLog.error(`failed to load ${page}`, { error: e }));
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
      writeSessionHeader(d, { sessionId, simMode, bleRaw: bleLogEnabled });
      mainLog.info('app ready', { msSinceStart: Date.now() - startedAt });
      watchSystem(mainLog);
      const userData = app.getPath('userData');
      const settingsLog = d.scope('settings');
      const settings = new SettingsStore(path.join(userData, 'settings.json'), {
        log: (m) => settingsLog.warn(m),
      });
      d.setSecrets({ riderName: settings.get().rider.name });
      settingsLog.info('settings loaded', {
        rememberedDevices: settings.get().devices,
        buttons: settings.get().shifting.buttons,
        overlayVisible: settings.get().overlay.visible,
      });
      let lastSettings: Settings = settings.get();
      settings.onChange((next) => {
        const change = describeSettingsChange(lastSettings, next);
        lastSettings = next;
        d.setSecrets({ riderName: next.rider.name });
        if (change.changed.length > 0) settingsLog.info('settings changed', { ...change });
      });
      const ridesLog = d.scope('rides');
      const rides = new RideStore(path.join(userData, 'rides'), (m) => ridesLog.warn(m));
      const btLog = d.scope('bluetooth');
      const bt = (m: string) => btLog.info(m);
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
      watchWebContents(win.webContents, 'main', d);
      mainLog.info('main window created', { bounds: mainBounds, maximized: ws.maximized });
      if (ws.maximized) win.maximize();
      win.once('ready-to-show', () => {
        mainLog.info('main window shown', { msSinceStart: Date.now() - startedAt });
        win.show();
      });

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
      win.on('blur', () => overlay?.reassertTop('main window blur'));
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
        log: d.scope('overlay'),
      });
      watchWebContents(overlay.win.webContents, 'overlay', d);

      settings.onChange((s) => broadcast(IPC.settingsChanged, s));

      // --- share with my watch (docs/adr/0005-sensor-relay.md) ---
      const relayLog = d.scope('relay');
      const helper = locateHelper({ isPackaged: app.isPackaged, appPath: app.getAppPath() });
      relayLog.info('watch relay helper', {
        location: helper.kind,
        ...(helper.kind === 'unavailable' ? { reason: helper.reason } : {}),
      });
      let relayLive: { state: LiveState; at: number } | null = null;
      const relay = new SensorRelayController({
        spawn: helperSpawner(helper),
        unavailableReason: helper.kind === 'unavailable' ? helper.reason : '',
        input: (now) => relayInputFromLive(relayLive?.state ?? null, now - (relayLive?.at ?? 0)),
        computerName: os.hostname(),
        log: relayLog,
        onStatus: (status) => {
          // Without the computer's name: the log is meant to be shared.
          const { computerName: _name, ...logged } = { computerName: '', ...status };
          relayLog.info('watch relay status', logged);
          if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send(IPC.watchRelayStatusChanged, status);
        },
      });
      relay.configure(settings.get().watchRelay);
      settings.onChange((s) => relay.configure(s.watchRelay));

      registerIpc({
        origin,
        mainWindow: () => mainWindow,
        overlay: () => overlay,
        chooser: () => chooser,
        settings,
        rides,
        diag: d,
        log,
        watchRelayStatus: () => relay.status,
        onLive: (state) => {
          relayLive = { state, at: Date.now() };
        },
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
        openLogFolder: async () => {
          await d.file.flush();
          await fs.promises.mkdir(d.file.dir, { recursive: true });
          const err = await shell.openPath(d.file.dir);
          if (err) throw new Error(err);
        },
        exportLog: async () => {
          const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
          const stamp = new Date()
            .toISOString()
            .slice(0, 16)
            .replace(/[-:]/g, '')
            .replace('T', '-');
          const opts: Electron.SaveDialogOptions = {
            title: 'Export diagnostic log',
            defaultPath: path.join(app.getPath('documents'), `freilauf-log-${stamp}.txt`),
            filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
          };
          const r = parent
            ? await dialog.showSaveDialog(parent, opts)
            : await dialog.showSaveDialog(opts);
          if (r.canceled || !r.filePath) {
            mainLog.info('log export cancelled');
            return null;
          }
          mainLog.info('log exported');
          const text = await d.file.readAll();
          const header = `Freilauf diagnostic log, exported ${new Date().toISOString()} (session ${sessionId}). See docs/diagnostics.md.\n`;
          await fs.promises.writeFile(r.filePath, header + text, 'utf8');
          return r.filePath;
        },
      });

      app.on('before-quit', () => {
        mainLog.info('quitting');
        overlay?.setQuitting();
        if (wsTimer) clearTimeout(wsTimer);
        saveWs();
      });
      app.on('will-quit', () => {
        relay.dispose();
        overlay?.unregisterHotkey();
        overlay?.close();
        settings.flushSync();
        mainLog.info('session end', {
          uptimeS: Math.round((Date.now() - startedAt) / 1000),
          droppedLogLines: d.file.dropped,
        });
        d.file.flushSync();
      });
      app.on('window-all-closed', () => app.quit());
    },
    (e: unknown) => {
      console.error(e);
      mainLog.error('startup failed', { error: e });
      d.file.flushSync();
      app.exit(1);
    },
  );
}
