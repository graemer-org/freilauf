import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { RecordedRide } from '@freilauf/session';
import type { LiveState } from '../src/shared/contract';
import { atStart, launch, mainEntry, windows } from './helpers';

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
      await expect(main.getByTestId('start-riding')).toBeVisible();
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
        'freilauf.log',
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

test('writes an always-on diagnostic log during a short simulated ride', async () => {
  test.setTimeout(60_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-log-'));
  const riderName = 'Zelda Quixote';
  try {
    const app = await launch(userData);
    try {
      const { main, overlay } = await windows(app);
      await main.evaluate(
        (name) => window.freilauf.settings.update({ rider: { name } }),
        riderName,
      );
      await atStart(main);
      await main.getByTestId('start-riding').click();
      await expect(main.getByTestId('stat-power')).toContainText(/[1-9]\d+/, { timeout: 15_000 });
      await main.getByTestId('gear-up').click();
      await main.waitForTimeout(1500);
      await main.getByTestId('ride-pause').click();

      // Both windows can log; the name is redacted wherever it appears.
      await main.evaluate(
        (name) =>
          window.freilauf.diagnostics.log('info', 'e2e', `hello from ${name}`, { who: name }),
        riderName,
      );
      await overlay.evaluate(() =>
        window.freilauf.diagnostics.log('info', 'overlay', 'overlay says hi'),
      );
      await expect(
        overlay.evaluate(() => window.freilauf.diagnostics.readRecent(100)),
      ).rejects.toThrow(/not allowed/);

      const info = await main.evaluate(() => window.freilauf.diagnostics.getLogInfo());
      expect(info.directory).toBe(path.join(userData, 'logs'));
      expect(info.files[0]?.name).toBe('freilauf.log');
      expect(info.files[0]?.bytes).toBeGreaterThan(0);
      const recent = await main.evaluate(() => window.freilauf.diagnostics.readRecent(64 * 1024));
      expect(recent).toContain('hello from [rider]');
    } finally {
      await app.close();
    }

    const logFile = path.join(userData, 'logs', 'freilauf.log');
    expect(fs.existsSync(logFile)).toBe(true);
    const text = fs.readFileSync(logFile, 'utf8');
    // Session header.
    expect(text).toMatch(/INFO +session +===== Freilauf \S+ session [0-9a-f]{8} started =====/);
    expect(text).toMatch(/INFO +session +versions \{"electron":/);
    expect(text).toMatch(/INFO +session +os \{"platform":/);
    expect(text).toMatch(/INFO +session +displays \{"count":\d/);
    // The three simulated devices connect.
    for (const device of [
      'trainer "Simulated Trainer"',
      'heartRate "Simulated HR"',
      'controller "Simulated Controller"',
    ]) {
      expect(text).toContain(`${device} connecting → connected`);
    }
    expect(text).toMatch(/INFO +ride +ride started/);
    expect(text).toMatch(/INFO +ride +gear \d+ → \d+ \(ui\)/);
    expect(text).toMatch(/INFO +ride +ride paused/);
    expect(text).toMatch(/INFO +settings +settings changed \{"changed":\["rider.name"\]/);
    expect(text).toMatch(/INFO +overlay +overlay says hi/);
    expect(text).toMatch(/INFO +main +session end/);
    // Privacy: the rider's name never reaches the file.
    expect(text).not.toContain('Zelda');
    expect(text).not.toContain('Quixote');
    // One event per line, each starting with an ISO timestamp.
    for (const l of text.split('\n').filter(Boolean)) {
      expect(l).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (DEBUG|INFO |WARN |ERROR) /);
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
