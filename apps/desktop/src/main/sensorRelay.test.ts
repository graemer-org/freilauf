import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayUuid } from '@freilauf/devices';
import { afterEach, describe, expect, it } from 'vitest';
import type { WatchRelayStatus } from '../shared/contract';
import { DEFAULT_WATCH_RELAY } from '../shared/contract';
import type { MainLog } from './logFile';
import { HELPER_EXE, UNAVAILABLE_OS, helperSpawner, resolveHelper } from './sensorRelay';
import { SensorRelayController } from './sensorRelayController';

const FAKE = path.resolve(import.meta.dirname, '../../e2e/fakeSensorRelay.mjs');

describe('resolveHelper', () => {
  const base = {
    platform: 'win32' as NodeJS.Platform,
    release: '10.0.22631',
    packaged: true,
    resourcesPath: 'C:\\Freilauf\\resources',
    appPath: '/repo/apps/desktop',
    exists: () => true,
  };

  it('uses the resources folder in a packaged Windows build', () => {
    expect(resolveHelper(base)).toEqual({
      kind: 'exe',
      path: path.join(base.resourcesPath, 'sensor-relay', HELPER_EXE),
    });
  });

  it('prefers a cargo build in development, else the checked-in binary', () => {
    const dev = { ...base, packaged: false };
    expect(resolveHelper(dev)).toEqual({
      kind: 'exe',
      path: path.join(
        '/repo/apps/desktop',
        'native',
        'sensor-relay',
        'target',
        'release',
        HELPER_EXE,
      ),
    });
    expect(resolveHelper({ ...dev, exists: (p) => p.includes('prebuilt') })).toEqual({
      kind: 'exe',
      path: path.join(
        '/repo/apps/desktop',
        'native',
        'sensor-relay',
        'prebuilt',
        'win32-x64',
        HELPER_EXE,
      ),
    });
  });

  it('is unavailable on macOS, Linux and old Windows 10', () => {
    expect(resolveHelper({ ...base, platform: 'darwin' })).toEqual({
      kind: 'unavailable',
      reason: UNAVAILABLE_OS,
    });
    expect(resolveHelper({ ...base, platform: 'linux' }).kind).toBe('unavailable');
    expect(resolveHelper({ ...base, release: '10.0.16299' }).kind).toBe('unavailable');
    expect(resolveHelper({ ...base, release: '10.0.17134' }).kind).toBe('exe');
  });

  it('reports a missing binary', () => {
    const r = resolveHelper({ ...base, exists: () => false });
    expect(r.kind).toBe('unavailable');
  });

  it('honours the override only in unpackaged builds', () => {
    const o = { ...base, platform: 'linux' as NodeJS.Platform, override: '/x/fake.mjs' };
    expect(resolveHelper({ ...o, packaged: false })).toEqual({
      kind: 'script',
      path: path.resolve('/x/fake.mjs'),
    });
    expect(resolveHelper({ ...o, packaged: false, override: '/x/relay.exe' }).kind).toBe('exe');
    expect(resolveHelper(o).kind).toBe('unavailable');
  });
});

describe('with the fake helper process', () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete process.env.FAKE_RELAY_LOG;
    delete process.env.FAKE_RELAY_CONTROL;
    delete process.env.FAKE_RELAY_MODE;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const quiet: MainLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  async function until<T>(f: () => T | undefined, ms = 5000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = f();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('starts, relays, counts a subscribed watch and stops', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    dirs.push(dir);
    const logFile = path.join(dir, 'commands.jsonl');
    const control = path.join(dir, 'control.jsonl');
    process.env.FAKE_RELAY_LOG = logFile;
    process.env.FAKE_RELAY_CONTROL = control;
    let status: WatchRelayStatus = { state: 'off' };
    let distanceM = 0;
    const relay = new SensorRelayController({
      spawn: helperSpawner({ kind: 'script', path: FAKE }),
      unavailableReason: '',
      input: () => ({
        heartRateBpm: 130,
        powerW: 180,
        cadenceRpm: 85,
        speedMps: 9,
        distanceM: (distanceM += 2),
      }),
      computerName: 'PC',
      log: quiet,
      onStatus: (s) => (status = s),
    });
    relay.configure({ ...DEFAULT_WATCH_RELAY, enabled: true });
    await until(() => status.state === 'sharing');
    const commands = () =>
      (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { t: number; cmd: { type: string; characteristic?: string } });
    await until(() => commands().filter((c) => c.cmd.type === 'notify').length >= 9);
    expect(commands()[0]?.cmd.type).toBe('start');

    fs.appendFileSync(
      control,
      `${JSON.stringify({
        type: 'subscribers',
        service: RelayUuid.cyclingPowerService,
        characteristic: RelayUuid.cyclingPowerMeasurement,
        centrals: ['c0ffee01'],
      })}\n`,
    );
    await until(() => status.state === 'sharing' && status.devices === 1);

    relay.configure(DEFAULT_WATCH_RELAY);
    expect(status).toEqual({ state: 'off' });
    await until(() => commands().some((c) => c.cmd.type === 'quit'));
    expect(
      commands()
        .map((c) => c.cmd.type)
        .slice(-2),
    ).toEqual(['stop', 'quit']);
  });

  it('shows the reason when the computer cannot act as a sensor', async () => {
    process.env.FAKE_RELAY_MODE = 'unsupported';
    let status: WatchRelayStatus = { state: 'off' };
    const relay = new SensorRelayController({
      spawn: helperSpawner({ kind: 'script', path: FAKE }),
      unavailableReason: '',
      input: () => null,
      computerName: 'PC',
      log: quiet,
      onStatus: (s) => (status = s),
    });
    relay.configure({ ...DEFAULT_WATCH_RELAY, enabled: true });
    await until(() => status.state === 'unsupported');
    expect(status).toMatchObject({ reason: expect.stringContaining('cannot act as a sensor') });
    relay.dispose();
  });

  it('reports a helper that cannot be started', async () => {
    let status: WatchRelayStatus = { state: 'off' };
    const relay = new SensorRelayController({
      spawn: helperSpawner({ kind: 'exe', path: path.join(os.tmpdir(), 'no-such-helper-x') }),
      unavailableReason: '',
      input: () => null,
      computerName: 'PC',
      log: quiet,
      onStatus: (s) => (status = s),
    });
    relay.configure({ ...DEFAULT_WATCH_RELAY, enabled: true });
    await until(() => status.state === 'error');
    expect(status).toMatchObject({ retrying: true });
    relay.dispose();
  });
});
