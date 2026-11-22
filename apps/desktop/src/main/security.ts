/**
 * Navigation, window.open and permission policy. Our renderers only ever show
 * our own bundled pages (or the Vite dev server in `electron-vite dev`).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Session, WebContents } from 'electron';
import { shell } from 'electron';

export interface AppOrigin {
  /** Dev server origin (ELECTRON_RENDERER_URL) or null in a built app. */
  devUrl: string | null;
  /** Directory containing the built renderer HTML. */
  rendererDir: string;
}

export function isAppUrl(origin: AppOrigin, url: string): boolean {
  try {
    const u = new URL(url);
    if (origin.devUrl) {
      const dev = new URL(origin.devUrl);
      if (u.origin === dev.origin) return true;
    }
    if (u.protocol === 'file:') {
      const base = pathToFileURL(path.resolve(origin.rendererDir) + path.sep).href.toLowerCase();
      return u.href.toLowerCase().startsWith(base);
    }
  } catch {
    // not a URL
  }
  return false;
}

/** Applied to every webContents the app creates. */
export function hardenWebContents(
  wc: WebContents,
  origin: AppOrigin,
  log: (m: string) => void,
): void {
  wc.setWindowOpenHandler(({ url }) => {
    // Plain https links (e.g. "open on Strava") go to the system browser;
    // nothing ever opens a new Electron window.
    if (/^https:\/\//i.test(url)) {
      void shell.openExternal(url);
    } else {
      log(`blocked window.open(${url})`);
    }
    return { action: 'deny' };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (!isAppUrl(origin, url)) {
      event.preventDefault();
      log(`blocked navigation to ${url}`);
    }
  };
  wc.on('will-navigate', (event) => guard(event, event.url));
  wc.on('will-redirect', (event) => guard(event, event.url));
  wc.on('will-frame-navigate', (event) => guard(event, event.url));
  wc.on('will-attach-webview', (event) => {
    event.preventDefault();
    log('blocked <webview>');
  });
}

/** Permissions our own pages may use. Everything else is denied. */
const ALLOWED_PERMISSIONS = new Set<string>(['clipboard-sanitized-write', 'fullscreen']);

/**
 * Note on Bluetooth: Electron has no "bluetooth" permission type in these
 * handlers. Web Bluetooth is governed by the `select-bluetooth-device` event:
 * without a listener Electron cancels every request, so only the main window
 * (the only webContents we attach the listener to) can ever get a device.
 * The device permission handler covers HID/serial/USB, which we do not use.
 */
export function installPermissionPolicy(
  ses: Session,
  isOurs: (wc: WebContents | null) => boolean,
  origin: AppOrigin,
  log: (m: string) => void,
): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ok =
      isOurs(wc) && isAppUrl(origin, details.requestingUrl) && ALLOWED_PERMISSIONS.has(permission);
    if (!ok) log(`denied permission request ${permission} from ${details.requestingUrl}`);
    callback(ok);
  });
  // Checks carry only an origin ("file://" for the built app), so they rely on
  // the navigation guard keeping our webContents on our own pages.
  ses.setPermissionCheckHandler(
    (wc, permission) => isOurs(wc) && ALLOWED_PERMISSIONS.has(permission),
  );
  ses.setDevicePermissionHandler(() => false);
}
