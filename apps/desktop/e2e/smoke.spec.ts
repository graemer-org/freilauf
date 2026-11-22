import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { RecordedRide } from '@freilauf/session';
import type { LiveState } from '../src/shared/contract';
import { launch, mainEntry, windows } from './helpers';

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
      expect(await main.evaluate(() => window.freilauf.window)).toBe('main');
      expect(await overlay.evaluate(() => window.freilauf.window)).toBe('overlay');
      await expect(main.getByTestId('tab-ride')).toBeVisible();
      await expect(overlay.getByTestId('overlay-root')).toBeVisible();

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

      // The simulated rig feeds the ride; its live state reaches the overlay.
      const overlayPower = overlay.getByTestId('overlay-tile-power3s');
      await expect(overlayPower).toContainText(/[1-9]\d+/, { timeout: 15_000 });

      // The overlay may not publish live state (a bogus value never shows up).
      await overlay.evaluate((s) => window.freilauf.live.publish(s), liveState(9999));
      await overlay.waitForTimeout(600);
      await expect(overlayPower).not.toContainText('9999');

      // A reloaded overlay gets state again right away.
      await overlay.reload();
      await expect(overlay.getByTestId('overlay-tile-power3s')).toContainText(/[1-9]\d+/);

      // Edit mode is reflected via onEditMode in both windows.
      await expect(overlay.getByTestId('overlay-edit-bar')).toHaveCount(0);
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
      await expect(overlay.getByTestId('overlay-edit-bar')).toBeVisible();
      expect(await mainSawEdit).toBe(true);
      await main.evaluate(() => window.freilauf.overlay.setEditMode(false));
      await expect(overlay.getByTestId('overlay-edit-bar')).toHaveCount(0);

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
