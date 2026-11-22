/**
 * Electron wiring of the diagnostic log: session header, process-level error
 * handlers, renderer health (crash, hang, console warnings), display and
 * power events. The file itself and all pure logic live in logFile.ts and
 * renderer/core/logFormat.ts.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { WebContents } from 'electron';
import { app, powerMonitor, screen } from 'electron';
import type { LogLevel } from '../shared/contract';
import { sessionHeaderEntries } from '../renderer/core/logFormat';
import type { DiagnosticLog, MainLog } from './logFile';

export function newSessionId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/** Display layout without anything personal: sizes, positions, scale factors. */
export function displayLayout(): Record<string, unknown> {
  const primary = screen.getPrimaryDisplay().id;
  return {
    count: screen.getAllDisplays().length,
    displays: screen.getAllDisplays().map((d) => ({
      id: d.id,
      primary: d.id === primary,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      rotation: d.rotation,
      internal: d.internal,
    })),
  };
}

export function writeSessionHeader(
  log: DiagnosticLog,
  info: { sessionId: string; simMode: boolean; bleRaw: boolean },
): void {
  const facts: Record<string, unknown> = {
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      simMode: info.simMode,
      rawBleFrames: info.bleRaw,
    },
    versions: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    os: {
      platform: process.platform,
      release: os.release(),
      version: typeof os.version === 'function' ? os.version() : undefined,
      systemVersion: process.getSystemVersion?.(),
      arch: process.arch,
      cpus: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    },
    locale: {
      app: app.getLocale(),
      system: app.getSystemLocale?.(),
      preferred: app.getPreferredSystemLanguages?.(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      utcOffsetMin: -new Date().getTimezoneOffset(),
    },
    displays: displayLayout(),
  };
  for (const e of sessionHeaderEntries(
    { sessionId: info.sessionId, app: 'Freilauf', version: app.getVersion(), facts },
    Date.now(),
  )) {
    log.write(e);
  }
}

/** Uncaught exceptions and unhandled rejections in the main process. */
export function installProcessHandlers(log: DiagnosticLog): void {
  const l = log.scope('main');
  // The monitor variant does not change Electron's default handling (the
  // error dialog); it only lets us write the error and flush the file first.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    l.error(`uncaught exception (${origin})`, { error: err });
    log.file.flushSync();
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[freilauf] unhandled rejection', reason);
    l.error('unhandled promise rejection', { error: reason });
  });
  process.on('warning', (w) => l.warn(`process warning: ${w.name}: ${w.message}`));
  process.on('exit', (code) => {
    l.info(`process exit (code ${code})`);
    log.file.close();
  });
  app.on('child-process-gone', (_e, details) => {
    l.warn(`child process gone: ${details.type} ${details.reason}`, {
      exitCode: details.exitCode,
      name: details.name,
      serviceName: details.serviceName,
    });
  });
}

const CONSOLE_LEVEL: Record<string, LogLevel | null> = {
  debug: null,
  info: null,
  warning: 'warn',
  error: 'error',
};

/** Crash, hang, failed loads and console warnings/errors of one of our windows. */
export function watchWebContents(wc: WebContents, name: string, log: DiagnosticLog): void {
  const l = log.scope(name === 'overlay' ? 'overlay' : 'main');
  wc.on('render-process-gone', (_e, details) => {
    l.error(`${name} renderer gone: ${details.reason}`, { exitCode: details.exitCode });
    log.file.flushSync();
  });
  wc.on('unresponsive', () => l.warn(`${name} window unresponsive`));
  wc.on('responsive', () => l.info(`${name} window responsive again`));
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) l.error(`${name} failed to load: ${description} (${code})`, { url });
  });
  wc.on('preload-error', (_e, preloadPath, error) => {
    l.error(`${name} preload error`, { preload: preloadPath, error });
  });
  wc.on('did-finish-load', () => l.info(`${name} page loaded`));
  wc.on('console-message', (event) => {
    const level = CONSOLE_LEVEL[event.level];
    if (!level) return;
    log.write({
      time: Date.now(),
      level,
      source: name === 'overlay' ? 'overlay' : 'renderer',
      message: `console.${event.level}: ${event.message}`,
      context: { source: event.sourceId, line: event.lineNumber },
    });
  });
}

/** Display changes and sleep/resume (a typical cause of dropped BLE links). */
export function watchSystem(l: MainLog): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const displays = (why: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      l.info(`displays changed (${why})`, displayLayout());
    }, 300);
  };
  screen.on('display-added', () => displays('added'));
  screen.on('display-removed', () => displays('removed'));
  screen.on('display-metrics-changed', (_e, _d, changed) =>
    displays(`metrics: ${changed.join(', ')}`),
  );
  for (const ev of [
    'suspend',
    'resume',
    'lock-screen',
    'unlock-screen',
    'on-ac',
    'on-battery',
  ] as const) {
    powerMonitor.on(ev as 'suspend', () => l.info(`power: ${ev}`));
  }
}
