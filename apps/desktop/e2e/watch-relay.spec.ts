import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { _electron as electron, expect, test } from '@playwright/test';
import { appDir, atStart, electronArgs, windows } from './helpers';

/**
 * "Share with my watch" end to end, with the fake helper (fakeSensorRelay.mjs)
 * standing in for the native Bluetooth program: it records every command the
 * app sends and plays back events written to a control file.
 */

const FAKE = path.join(appDir, 'e2e', 'fakeSensorRelay.mjs');
const uuid16 = (n: number) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
const HR_SERVICE = uuid16(0x180d);
const HR_MEASUREMENT = uuid16(0x2a37);
const CP_SERVICE = uuid16(0x1818);
const CP_MEASUREMENT = uuid16(0x2a63);
const CSC_SERVICE = uuid16(0x1816);
const CSC_MEASUREMENT = uuid16(0x2a5b);

interface Logged {
  t: number;
  cmd: { type: string; services?: { uuid: string }[]; characteristic?: string; value?: string };
}

function readLog(file: string): Logged[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Logged);
}

const bytes = (hex: string) => Buffer.from(hex, 'hex');

async function launchWithFake(
  userData: string,
  env: Record<string, string>,
): Promise<ElectronApplication> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  delete base.ELECTRON_RENDERER_URL;
  delete base.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: electronArgs(),
    cwd: appDir,
    env: {
      ...base,
      FREILAUF_USER_DATA: userData,
      FREILAUF_SIM: '1',
      FREILAUF_SENSOR_RELAY_HELPER: FAKE,
      ...env,
    },
  });
}

test('share with my watch: start, relay at ≤ 4 Hz, a watch subscribes, stop', async () => {
  test.setTimeout(120_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-relay-'));
  const log = path.join(dir, 'commands.jsonl');
  const control = path.join(dir, 'control.jsonl');
  const app = await launchWithFake(path.join(dir, 'user'), {
    FAKE_RELAY_LOG: log,
    FAKE_RELAY_CONTROL: control,
  });
  try {
    const { main } = await windows(app);
    await atStart(main);
    await expect(main.getByTestId('watch-relay-badge')).toHaveCount(0);

    // Devices → Share with my watch: off by default, trainer data unticked.
    await main.getByTestId('start-devices').click();
    const status = main.getByTestId('watch-relay-status');
    await expect(status).toHaveAttribute('data-state', 'off');
    await expect(main.getByTestId('watch-relay-share-trainer')).not.toBeChecked();
    await expect(main.getByTestId('watch-relay-share-power')).toBeChecked();
    await main.getByTestId('watch-relay-enabled').check();

    // The fake receives `start` with the selected services; the UI waits for a watch.
    await expect.poll(() => readLog(log)[0]?.cmd.type, { timeout: 15_000 }).toBe('start');
    expect(readLog(log)[0]?.cmd.services?.map((s) => s.uuid)).toEqual([
      HR_SERVICE,
      CP_SERVICE,
      CSC_SERVICE,
    ]);
    await expect(status).toHaveAttribute('data-state', 'sharing');
    await expect(status).toContainText('Waiting for a watch');
    await expect(status).toContainText('power meter');

    // Ride (simulated devices) — updates flow at ≤ 4 Hz with plausible values.
    await main.getByTestId('screen-back').click();
    await expect(main.getByTestId('watch-relay-badge')).toContainText('Watch: waiting');
    await main.getByTestId('start-riding').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding');
    await expect(main.getByTestId('watch-relay-badge')).toBeVisible();
    const rideStart = Date.now();
    await main.waitForTimeout(6000);

    const notifies = readLog(log).filter((e) => e.cmd.type === 'notify' && e.t >= rideStart);
    const of = (c: string) => notifies.filter((e) => e.cmd.characteristic === c);
    for (const c of [HR_MEASUREMENT, CP_MEASUREMENT, CSC_MEASUREMENT]) {
      const list = of(c);
      expect(list.length, c).toBeGreaterThanOrEqual(12);
      const spanS = (list.at(-1)!.t - list[0]!.t) / 1000;
      expect((list.length - 1) / spanS, `${c} rate`).toBeLessThanOrEqual(4.4);
    }
    // Heart rate: flags (uint8 bpm), then a plausible bpm.
    const hr = bytes(of(HR_MEASUREMENT).at(-1)!.cmd.value!);
    expect(hr[1]).toBeGreaterThan(50);
    expect(hr[1]).toBeLessThan(220);
    // Cycling power: flags u16 (crank data), power s16, crank revs u16, event time u16.
    const cp = bytes(of(CP_MEASUREMENT).at(-1)!.cmd.value!);
    expect(cp.readUInt16LE(0) & 0x20).toBe(0x20);
    expect(cp.readInt16LE(2)).toBeGreaterThan(50);
    expect(cp.readInt16LE(2)).toBeLessThan(1000);
    // CSC: wheel and crank counts grow while riding.
    const csc = (e: Logged) => {
      const b = bytes(e.cmd.value!);
      return { flags: b[0], wheel: b.readUInt32LE(1), crank: b.readUInt16LE(7) };
    };
    const first = csc(of(CSC_MEASUREMENT)[0]!);
    const last = csc(of(CSC_MEASUREMENT).at(-1)!);
    expect(last.flags).toBe(0x03);
    expect(last.wheel).toBeGreaterThan(first.wheel);
    expect(last.crank).toBeGreaterThan(first.crank);

    // A watch subscribes: "Connected: 1 device".
    fs.appendFileSync(
      control,
      `${JSON.stringify({
        type: 'subscribers',
        service: CP_SERVICE,
        characteristic: CP_MEASUREMENT,
        centrals: ['c5a1e2b3'],
      })}\n`,
    );
    await expect(main.getByTestId('watch-relay-badge')).toContainText('Watch: 1');
    await main.getByTestId('ride-pause').click();
    await main.getByTestId('ride-leave').click();
    await main.getByTestId('start-devices').click();
    await expect(status).toContainText('Connected: 1 device');

    // Off: the fake is told to stop (and quit).
    await main.getByTestId('watch-relay-enabled').uncheck();
    await expect(status).toHaveAttribute('data-state', 'off');
    await expect
      .poll(
        () =>
          readLog(log)
            .map((e) => e.cmd.type)
            .slice(-2),
        { timeout: 10_000 },
      )
      .toEqual(['stop', 'quit']);
    const logText = await main.evaluate(() => window.freilauf.diagnostics.readRecent(200_000));
    expect(logText).toContain('share with watch: advertising');
    expect(logText).toContain('share with watch: subscriptions changed');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('share with my watch: an adapter that cannot act as a sensor shows the reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-relay-'));
  const app = await launchWithFake(path.join(dir, 'user'), {
    FAKE_RELAY_MODE: 'unsupported',
    FAKE_RELAY_REASON: 'This adapter has no peripheral role (fake).',
  });
  try {
    const { main } = await windows(app);
    await atStart(main);
    await main.getByTestId('start-devices').click();
    await main.getByTestId('watch-relay-enabled').check();
    const status = main.getByTestId('watch-relay-status');
    await expect(status).toHaveAttribute('data-state', 'unsupported');
    await expect(status).toHaveText(
      'Not supported on this computer — This adapter has no peripheral role (fake).',
    );
    await main.getByTestId('screen-back').click();
    await expect(main.getByTestId('watch-relay-badge')).toContainText('Watch: problem');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
