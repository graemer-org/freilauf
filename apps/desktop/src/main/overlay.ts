/**
 * The overlay window: frameless, transparent, always on top, click-through
 * except in edit mode.
 *
 * Staying above a fullscreen browser video, per platform (only partly
 * verifiable in CI; see the report in the PR):
 *
 * - Windows: any `setAlwaysOnTop(true, level)` other than 'normal' makes the
 *   window HWND_TOPMOST. Browsers' fullscreen (YouTube in Chrome/Edge/Firefox)
 *   is a borderless window that is NOT topmost, so a topmost overlay stays
 *   above it. What can break it in practice: other topmost windows (taskbar
 *   when clicked, some players), Chromium's own SetWindowPos calls when a
 *   window enters fullscreen, Explorer restarts, display mode changes and
 *   sleep/resume, after which Windows may reorder or drop the topmost band.
 *   So we re-assert (`setAlwaysOnTop` + `moveTop`) on main-window blur, on
 *   display changes, on resume/unlock, when shown, and on a slow 5 s timer
 *   while visible. `moveTop` does not activate the window because the overlay
 *   is non-focusable (WS_EX_NOACTIVATE) outside edit mode, and we skip it in
 *   edit mode. Exclusive-mode fullscreen games are out of scope (nothing
 *   non-injected can draw over those).
 * - macOS: 'screen-saver' level plus `setVisibleOnAllWorkspaces(true,
 *   { visibleOnFullScreen: true })` so the overlay also shows in the separate
 *   Space a native-fullscreen browser window gets.
 * - Linux: best effort; depends on the window manager/compositor (without a
 *   compositor transparency renders black).
 *
 * Transparent frameless windows are not natively resizable on Windows, so the
 * window is `resizable: false` and the renderer resizes via
 * `overlay.setBounds` from its own grip in edit mode.
 */
import type { Display } from 'electron';
import { BrowserWindow, Notification, globalShortcut, powerMonitor, screen } from 'electron';
import type { Bounds, Settings } from '../shared/contract';
import { IPC } from '../shared/ipc';
import { RateLimiter } from '../renderer/core/logFormat';
import { OVERLAY_MIN_SIZE, clampSize, defaultOverlayBounds, fitToDisplays } from './geometry';
import type { MainLog } from './logFile';
import type { SettingsStore } from './settingsStore';

export interface OverlayDeps {
  settings: SettingsStore;
  preload: string;
  additionalArguments: string[];
  load(win: BrowserWindow): void;
  /** Sends to every window of the app (edit mode is shown in both). */
  broadcast(channel: string, ...args: unknown[]): void;
  log: MainLog;
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const TOP_LEVEL = 'screen-saver' as const;
const PERSIST_DEBOUNCE_MS = 500;
const REASSERT_INTERVAL_MS = 5000;

function workAreas(): Bounds[] {
  return screen.getAllDisplays().map((d: Display) => d.workArea);
}

export class OverlayController {
  readonly win: BrowserWindow;
  private editMode = false;
  private quitting = false;
  private hotkey: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private displayTimer: ReturnType<typeof setTimeout> | null = null;
  private reassertTimer: ReturnType<typeof setInterval> | null = null;
  /** Last bounds we wrote to settings, to tell our own writes from user edits. */
  private persistedBounds: string;
  private readonly deps: OverlayDeps;
  /** Re-assertions happen every few seconds on Windows: log a few, count the rest. */
  private readonly reassertLimit = new RateLimiter(5, 60_000);
  private reassertCount = 0;

  constructor(deps: OverlayDeps) {
    this.deps = deps;
    const s = deps.settings.get().overlay;
    const bounds = this.resolveBounds(s.bounds);
    this.persistedBounds = JSON.stringify(s.bounds);

    this.win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Linux: setFocusable() is not supported there, so keep it focusable
      // (mouse click-through still works); Windows/macOS toggle it below.
      focusable: !(isWin || isMac),
      alwaysOnTop: true,
      title: 'Freilauf overlay',
      webPreferences: {
        preload: deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        additionalArguments: deps.additionalArguments,
      },
    });
    this.applyOnTop();
    this.applyEditMode();
    this.win.setMenu(null);
    deps.log.info('overlay window created', { bounds, savedBounds: s.bounds, visible: s.visible });

    this.win.once('ready-to-show', () => {
      if (this.deps.settings.get().overlay.visible) this.show();
    });
    // Only user moves (edit mode) are persisted: `overlay.bounds` stays null
    // until the user actually placed the overlay.
    this.win.on('move', () => {
      if (this.editMode) this.schedulePersist();
    });
    this.win.on('resize', () => {
      if (this.editMode) this.schedulePersist();
    });
    this.win.on('close', (event) => {
      // Alt+F4 in edit mode (the only time it can have focus) must not
      // destroy the overlay: hide it instead. Any other close (quit, OS
      // shutdown) goes through.
      if (!this.quitting && this.editMode) {
        event.preventDefault();
        deps.settings.update({ overlay: { visible: false } });
      }
    });
    this.win.on('closed', () => {
      deps.log.info('overlay window closed');
      this.stopReassertTimer();
    });

    screen.on('display-added', () => this.onDisplaysChanged());
    screen.on('display-removed', () => this.onDisplaysChanged());
    screen.on('display-metrics-changed', () => this.onDisplaysChanged());
    powerMonitor.on('resume', () => this.reassertTop('resume'));
    powerMonitor.on('unlock-screen', () => this.reassertTop('unlock'));

    deps.settings.onChange((next) => this.onSettings(next));
    this.registerHotkey(deps.settings.get().overlay.editHotkey);
    deps.load(this.win);
  }

  get isEditMode(): boolean {
    return this.editMode;
  }

  setQuitting(): void {
    this.quitting = true;
    this.flushPersist();
    this.stopReassertTimer();
  }

  private resolveBounds(saved: Bounds | null): Bounds {
    const primary = screen.getPrimaryDisplay().workArea;
    if (!saved) return defaultOverlayBounds(primary);
    return fitToDisplays(saved, workAreas(), primary, OVERLAY_MIN_SIZE, defaultOverlayBounds);
  }

  private applyOnTop(): void {
    this.win.setAlwaysOnTop(true, TOP_LEVEL);
    if (isMac) {
      // Called once: Electron briefly transforms the process type (the Dock
      // icon blinks), which is what lets the window join fullscreen Spaces.
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
  }

  /** See the module comment for why this is needed on Windows. */
  reassertTop(reason = 'unspecified'): void {
    if (this.win.isDestroyed() || !this.win.isVisible()) return;
    this.win.setAlwaysOnTop(true, TOP_LEVEL);
    if (isWin && !this.editMode) this.win.moveTop();
    this.reassertCount++;
    const d = this.reassertLimit.take(reason);
    if (d.allowed) {
      this.deps.log.debug(`always-on-top re-asserted (${reason})`, {
        total: this.reassertCount,
        isAlwaysOnTop: this.win.isAlwaysOnTop(),
        ...(d.suppressed ? { notLoggedBefore: d.suppressed } : {}),
      });
    }
  }

  private show(): void {
    if (this.win.isDestroyed()) return;
    this.win.showInactive();
    this.deps.log.info('overlay shown', { bounds: this.win.getBounds() });
    this.reassertTop('show');
    if (isWin && !this.reassertTimer) {
      this.reassertTimer = setInterval(() => this.reassertTop('timer'), REASSERT_INTERVAL_MS);
    }
  }

  private hide(): void {
    if (this.win.isDestroyed()) return;
    if (this.editMode) this.setEditMode(false);
    this.win.hide();
    this.deps.log.info('overlay hidden');
    this.stopReassertTimer();
  }

  private stopReassertTimer(): void {
    if (this.reassertTimer) clearInterval(this.reassertTimer);
    this.reassertTimer = null;
  }

  setEditMode(edit: boolean): void {
    if (edit === this.editMode) {
      this.deps.broadcast(IPC.overlayEditMode, this.editMode);
      return;
    }
    if (edit && !this.deps.settings.get().overlay.visible) {
      this.deps.log.info('edit mode requested while the overlay is hidden; showing it');
      this.deps.settings.update({ overlay: { visible: true } });
    }
    this.editMode = edit;
    this.deps.log.info(`overlay edit mode ${edit ? 'on' : 'off'}`);
    this.applyEditMode();
    if (!edit) this.flushPersist();
    this.deps.broadcast(IPC.overlayEditMode, this.editMode);
  }

  private applyEditMode(): void {
    if (this.win.isDestroyed()) return;
    if (this.editMode) {
      this.win.setIgnoreMouseEvents(false);
      if (isWin || isMac) this.win.setFocusable(true);
    } else {
      // forward: the renderer still gets mousemove (hover effects) on Windows/macOS.
      this.win.setIgnoreMouseEvents(true, { forward: true });
      if (isWin || isMac) this.win.setFocusable(false);
      if (this.win.isFocused()) this.win.blur();
    }
    this.reassertTop('edit mode');
  }

  getBounds(): Bounds {
    return this.win.getBounds();
  }

  /** Renderer resize grip / drag in edit mode. */
  setBounds(b: Bounds): void {
    if (this.win.isDestroyed()) return;
    const maxW = Math.max(...workAreas().map((w) => w.width));
    const maxH = Math.max(...workAreas().map((w) => w.height));
    const size = clampSize(b, OVERLAY_MIN_SIZE, { width: maxW, height: maxH });
    this.win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), ...size });
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.flushPersist(), PERSIST_DEBOUNCE_MS);
  }

  /** Writes a pending (user-caused) bounds change now. */
  private flushPersist(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.win.isDestroyed()) return;
    const bounds = this.win.getBounds();
    const key = JSON.stringify(bounds);
    if (key === this.persistedBounds) return;
    this.persistedBounds = key;
    this.deps.log.info('overlay moved/resized by the user', { bounds });
    this.deps.settings.update({ overlay: { bounds } });
  }

  private onDisplaysChanged(): void {
    // Debounced: plugging a monitor in fires several events. A scale-factor
    // change makes Windows rescale the window physically; re-applying our DIP
    // bounds keeps its logical size and keeps it on a display.
    if (this.displayTimer) clearTimeout(this.displayTimer);
    this.displayTimer = setTimeout(() => {
      this.displayTimer = null;
      if (this.win.isDestroyed()) return;
      const saved = this.deps.settings.get().overlay.bounds;
      const target = this.resolveBounds(saved ?? this.win.getBounds());
      const cur = this.win.getBounds();
      if (JSON.stringify(cur) !== JSON.stringify(target)) {
        this.deps.log.info('displays changed: moving overlay', { from: cur, to: target });
        this.win.setBounds(target);
      }
      this.reassertTop('display change');
    }, 300);
  }

  private onSettings(next: Settings): void {
    if (this.win.isDestroyed()) return;
    const o = next.overlay;
    if (o.visible && !this.win.isVisible()) this.show();
    if (!o.visible && this.win.isVisible()) this.hide();
    if (o.editHotkey !== this.hotkey) this.registerHotkey(o.editHotkey);
    // Bounds changed by someone else (e.g. "reset position" in the main
    // window sets null): apply them.
    const key = JSON.stringify(o.bounds);
    if (key !== this.persistedBounds) {
      this.persistedBounds = key;
      const target = this.resolveBounds(o.bounds);
      this.deps.log.info('overlay bounds changed in settings', {
        saved: o.bounds,
        applied: target,
      });
      this.win.setBounds(target);
    }
  }

  /** Never throws: an unusable hotkey is reported and edit mode stays reachable via the UI. */
  registerHotkey(accelerator: string): boolean {
    if (this.hotkey) {
      try {
        globalShortcut.unregister(this.hotkey);
      } catch {
        // ignore
      }
    }
    this.hotkey = accelerator;
    let ok = false;
    let reason = 'it is already used by another application';
    try {
      ok = globalShortcut.register(accelerator, () => this.setEditMode(!this.editMode));
    } catch (e) {
      reason = `it is not a valid accelerator (${String(e)})`;
    }
    if (ok) this.deps.log.info(`edit hotkey "${accelerator}" registered`);
    if (!ok) {
      const msg = `Could not register the overlay edit hotkey "${accelerator}": ${reason}. Use the main window to toggle edit mode or choose another hotkey.`;
      this.deps.log.warn(msg);
      try {
        if (Notification.isSupported())
          new Notification({ title: 'Freilauf', body: msg, silent: true }).show();
      } catch {
        // ignore
      }
    }
    return ok;
  }

  unregisterHotkey(): void {
    if (this.hotkey) {
      try {
        globalShortcut.unregister(this.hotkey);
      } catch {
        // ignore
      }
    }
  }

  close(): void {
    this.quitting = true;
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}
