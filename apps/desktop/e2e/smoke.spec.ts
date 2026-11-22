import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron, expect, test } from '@playwright/test';
import type { RecordedRide } from '@freilauf/session';
import type { LiveState } from '../src/shared/contract';

const appDir = path.resolve(import.meta.dirname, '..');
const mainEntry = path.join(appDir, 'out', 'main', 'index.js');

function electronArgs(): string[] {
  const args = [mainEntry];
  // Chromium refuses to start as root without --no-sandbox (containers, CI).
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.env.CI || (process.platform === 'linux' && isRoot)) args.push('--no-sandbox');
  return args;
}

async function launch(userData: string): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: electronArgs(),
    cwd: appDir,
    env: { ...env, FREILAUF_USER_DATA: userData, FREILAUF_SIM: '1' },
  });
}

/** Waits for both windows and tells them apart via window.freilauf.window. */
async function windows(app: ElectronApplication): Promise<{ main: Page; overlay: Page }> {
  await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(2);
  const found: Partial<Record<'main' | 'overlay', Page>> = {};
  for (const page of app.windows()) {
    await page.waitForLoadState('domcontentloaded');
    const name = await page.evaluate(() => window.freilauf.window);
    found[name] = page;
  }
  if (!found.main || !found.overlay) throw new Error('expected a main and an overlay window');
  return { main: found.main, overlay: found.overlay };
}

function liveState(powerW: number): LiveState {
  return {
    ride: {
      state: 'riding',
      elapsedS: 12,
      distanceM: 100,
      speedMps: 9,
      powerW,
      power3sW: powerW,
      wattsPerKg: powerW / 75,
      cadenceRpm: 90,
      heartRateBpm: 140,
      gear: 12,
      gearCount: 24,
      gradePercent: 1,
    },
    devices: { trainer: { name: 'Sim', state: 'connected' }, heartRate: null, controller: null },
    group: null,
    localName: 'E2E',
  };
}

function smallRide(): RecordedRide {
  const startedAt = Date.UTC(2026, 10, 22, 8, 0, 0);
  return {
    id: 'e2e-ride-1',
    name: 'E2E ride',
    startedAt,
    riderMassKg: 75,
    samples: Array.from({ length: 5 }, (_, i) => ({
      timestamp: startedAt + i * 1000,
      elapsedS: i,
      powerW: 200,
      cadenceRpm: 90,
      heartRateBpm: 140,
      speedMps: 9,
      distanceM: i * 9,
      gradePercent: 0,
      gear: 12,
    })),
  };
}

test.describe('desktop smoke', () => {
  let userData: string;

  test.beforeAll(() => {
    if (!fs.existsSync(mainEntry))
      throw new Error(`${mainEntry} missing: run "electron-vite build" first`);
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-'));
  });

  test.afterAll(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test('launches, relays state, persists settings and rides', async () => {
    let app = await launch(userData);
    try {
      const { main, overlay } = await windows(app);

      // The API is exposed in both windows.
      expect(await main.evaluate(() => typeof window.freilauf)).toBe('object');
      expect(await overlay.evaluate(() => typeof window.freilauf)).toBe('object');
      expect(await main.evaluate(() => window.freilauf.simMode)).toBe(true);
      await expect(main.getByTestId('window-name')).toContainText('main');
      await expect(overlay.getByTestId('window-name')).toHaveText('overlay');

      // Node is not reachable from the renderer.
      expect(await main.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
        'undefined',
      );

      // settings.update round-trips and is broadcast to the other window.
      const overlayGotSettings = overlay.evaluate(
        () =>
          new Promise<string>((resolve) => {
            const off = window.freilauf.settings.onChange((s) => {
              off();
              resolve(s.rider.name);
            });
          }),
      );
      const updated = await main.evaluate(() =>
        window.freilauf.settings.update({ rider: { name: 'E2E Rider' } }),
      );
      expect(updated.rider.name).toBe('E2E Rider');
      expect(updated.rider.massKg).toBe(75);
      expect(await overlayGotSettings).toBe('E2E Rider');
      expect((await main.evaluate(() => window.freilauf.settings.get())).rider.name).toBe(
        'E2E Rider',
      );

      // live.publish from the main window arrives in the overlay.
      await main.evaluate((s) => window.freilauf.live.publish(s), liveState(321));
      await expect(overlay.getByTestId('power')).toHaveText('321');

      // The overlay may not publish live state.
      await overlay.evaluate((s) => window.freilauf.live.publish(s), liveState(999));
      await main.evaluate((s) => window.freilauf.live.publish(s), liveState(322));
      await expect(overlay.getByTestId('power')).toHaveText('322');

      // A reloaded overlay gets the last state immediately.
      await overlay.reload();
      await expect(overlay.getByTestId('power')).toHaveText('322');

      // Edit mode is reflected via onEditMode in both windows.
      await expect(overlay.getByTestId('edit-mode')).toHaveText('locked');
      const mainSawEdit = main.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const off = window.freilauf.overlay.onEditMode((e) => {
              if (e) {
                off();
                resolve(e);
              }
            });
          }),
      );
      await main.evaluate(() => window.freilauf.overlay.setEditMode(true));
      await expect(overlay.getByTestId('edit-mode')).toHaveText('edit');
      expect(await mainSawEdit).toBe(true);
      await main.evaluate(() => window.freilauf.overlay.setEditMode(false));
      await expect(overlay.getByTestId('edit-mode')).toHaveText('locked');

      // Overlay-only and main-only calls are enforced.
      await expect(overlay.evaluate(() => window.freilauf.rides.list())).rejects.toThrow(
        /not allowed/,
      );
      const b = await overlay.evaluate(() => window.freilauf.overlay.getBounds());
      expect(b.width).toBeGreaterThan(0);

      // Saving a ride and listing it.
      await main.evaluate((r) => window.freilauf.rides.save(r, true), smallRide());
      const rides = await main.evaluate(() => window.freilauf.rides.list());
      expect(rides).toHaveLength(1);
      expect(rides[0]).toMatchObject({
        id: 'e2e-ride-1',
        name: 'E2E ride',
        finished: true,
        durationS: 4,
      });
      await expect(
        main.evaluate(() => window.freilauf.rides.save({ id: '../x' } as never, true)),
      ).rejects.toThrow();

      expect(await main.evaluate(() => window.freilauf.diagnostics.logFilePath())).toContain(
        'ble.log',
      );
    } finally {
      await app.close();
    }

    expect(fs.existsSync(path.join(userData, 'rides', 'e2e-ride-1.json'))).toBe(true);

    // Settings persist across a relaunch.
    app = await launch(userData);
    try {
      const { main, overlay } = await windows(app);
      expect((await main.evaluate(() => window.freilauf.settings.get())).rider.name).toBe(
        'E2E Rider',
      );
      expect((await overlay.evaluate(() => window.freilauf.settings.get())).rider.name).toBe(
        'E2E Rider',
      );
      expect(await main.evaluate(() => window.freilauf.rides.list())).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
