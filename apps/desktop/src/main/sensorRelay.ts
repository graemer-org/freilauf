/**
 * Node/Electron side of "Share with my watch": finds the helper executable,
 * spawns it and connects it to SensorRelayController (the tested logic).
 *
 * Where the helper is (resolveHelper):
 *  - packaged Windows build: `<resources>/sensor-relay/freilauf-sensor-relay.exe`
 *    (electron-builder.yml `win.extraResources`);
 *  - development: the cargo build output if there is one, else the checked-in
 *    `native/sensor-relay/prebuilt/win32-x64/freilauf-sensor-relay.exe`;
 *  - FREILAUF_SENSOR_RELAY_HELPER (unpackaged builds only): another executable,
 *    or a .mjs/.js script run with Electron's Node (the e2e tests' fake helper).
 * macOS and Linux have no helper: the feature reports itself unavailable.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HelperCallbacks, HelperProcess } from './sensorRelayController';

export const HELPER_EXE = 'freilauf-sensor-relay.exe';

/** First Windows build with GattServiceProvider advertising parameters (Windows 10 1803). */
export const MIN_WINDOWS_BUILD = 17134;

export type HelperLocation =
  | { kind: 'exe'; path: string }
  | { kind: 'script'; path: string }
  | { kind: 'unavailable'; reason: string };

export const UNAVAILABLE_OS =
  'Sharing with a watch needs Windows 10 (version 1803 or later) or Windows 11. On macOS and Linux Freilauf cannot act as a Bluetooth sensor yet.';

export function resolveHelper(opts: {
  platform: NodeJS.Platform;
  /** os.release(), e.g. "10.0.22631". */
  release: string;
  packaged: boolean;
  resourcesPath: string;
  /** apps/desktop in development. */
  appPath: string;
  override?: string;
  exists(p: string): boolean;
}): HelperLocation {
  if (opts.override && !opts.packaged) {
    const p = path.resolve(opts.override);
    if (!opts.exists(p)) return { kind: 'unavailable', reason: `Helper not found at ${p}.` };
    return /\.(c|m)?js$/.test(p) ? { kind: 'script', path: p } : { kind: 'exe', path: p };
  }
  if (opts.platform !== 'win32') return { kind: 'unavailable', reason: UNAVAILABLE_OS };
  const build = Number(opts.release.split('.')[2]);
  if (Number.isFinite(build) && build > 0 && build < MIN_WINDOWS_BUILD) {
    return { kind: 'unavailable', reason: UNAVAILABLE_OS };
  }
  const candidates = opts.packaged
    ? [path.join(opts.resourcesPath, 'sensor-relay', HELPER_EXE)]
    : [
        path.join(opts.appPath, 'native', 'sensor-relay', 'target', 'release', HELPER_EXE),
        path.join(opts.appPath, 'native', 'sensor-relay', 'prebuilt', 'win32-x64', HELPER_EXE),
      ];
  const found = candidates.find((p) => opts.exists(p));
  if (!found) {
    return {
      kind: 'unavailable',
      reason: 'The Bluetooth helper is missing from this installation. Reinstall Freilauf.',
    };
  }
  return { kind: 'exe', path: found };
}

/** Spawns the helper; returns null for an unavailable location. */
export function helperSpawner(
  location: HelperLocation,
): ((callbacks: HelperCallbacks) => HelperProcess) | null {
  if (location.kind === 'unavailable') return null;
  return (cb) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    let command = location.path;
    const args: string[] = [];
    if (location.kind === 'script') {
      command = process.execPath;
      args.push(location.path);
      env.ELECTRON_RUN_AS_NODE = '1';
    } else {
      delete env.ELECTRON_RUN_AS_NODE;
    }
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    let exited = false;
    const exit = (info: { code: number | null; signal: string | null; error?: string }) => {
      if (exited) return;
      exited = true;
      cb.exit(info);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => cb.stdout(d));
    child.stderr.on('data', (d: string) => cb.stderr(d));
    // EPIPE after the helper died: the exit handler reports it.
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => exit({ code: null, signal: null, error: e.message }));
    child.on('exit', (code, signal) => exit({ code, signal }));
    return {
      write: (line) => (child.stdin.writable ? child.stdin.write(line) : false),
      end: () => child.stdin.end(),
      kill: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      },
    };
  };
}

/** The helper location for this process (Electron main). */
export function locateHelper(electron: { isPackaged: boolean; appPath: string }): HelperLocation {
  return resolveHelper({
    platform: process.platform,
    release: os.release(),
    packaged: electron.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: electron.appPath,
    override: process.env.FREILAUF_SENSOR_RELAY_HELPER,
    exists: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
  });
}
