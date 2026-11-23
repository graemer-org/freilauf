import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { atStart, finishRide, launch, windows } from './helpers';

/** Counts every click the page receives from now on. */
async function countClicks(main: Page): Promise<() => Promise<number>> {
  await main.evaluate(() => {
    const w = window as unknown as { __clicks: number };
    w.__clicks = 0;
    window.addEventListener('click', () => w.__clicks++, true);
  });
  return () => main.evaluate(() => (window as unknown as { __clicks: number }).__clicks);
}

/**
 * Cold start: the start screen is usable at once and one click starts the ride (the first-run
 * questions sit inline and never block). The questions come back until they are answered or
 * skipped, and never after that.
 */
test('cold start: one click from launch to riding; first-run asked until answered, never again', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-nav-first-'));
  try {
    // 1) Launch, one click, riding.
    let app = await launch(userData);
    try {
      const { main } = await windows(app);
      await expect(main.getByTestId('start-riding')).toBeVisible({ timeout: 20_000 });
      await expect(main.getByTestId('first-run')).toBeVisible();
      const clicks = await countClicks(main);
      await main.getByTestId('start-riding').click();
      await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding');
      await expect(main.getByTestId('stat-power')).toContainText(/[1-9]\d+/, { timeout: 15_000 });
      expect(await clicks()).toBe(1);
      await main.getByTestId('ride-pause').click();
    } finally {
      await app.close();
    }

    // 2) Not answered yet: asked again. Answer it (FTP unknown → kept, the FTP test card hinted).
    app = await launch(userData);
    try {
      const { main } = await windows(app);
      await atStart(main);
      await expect(main.getByTestId('first-run')).toBeVisible();
      await main.getByTestId('first-run-name').fill('Ana');
      await main.getByTestId('first-run-mass').fill('68.5');
      await main.getByTestId('first-run-ftp-unknown').check();
      await expect(main.getByTestId('first-run-ftp')).toBeDisabled();
      await expect(main.getByTestId('first-run')).toContainText('The FTP test card below');
      await main.getByTestId('first-run-save').click();
      await expect(main.getByTestId('first-run')).toHaveCount(0);
      await expect(main.getByTestId('ride-kind-ftp')).toHaveClass(/is-hinted/);
      await expect
        .poll(() => main.evaluate(() => window.freilauf.settings.get().then((s) => s.rider)))
        .toMatchObject({ name: 'Ana', massKg: 68.5, ftpW: 200 });
    } finally {
      await app.close();
    }

    // 3) Never again.
    app = await launch(userData);
    try {
      const { main } = await windows(app);
      await atStart(main);
      await expect(main.getByTestId('start-screen')).toContainText('What are you riding today?');
      await expect(main.getByTestId('first-run')).toHaveCount(0);
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('first-run: skipping is answering', async () => {
  test.setTimeout(60_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-nav-skip-'));
  try {
    let app = await launch(userData);
    try {
      const { main } = await windows(app);
      await atStart(main);
      await main.getByTestId('first-run-skip').click();
      await expect(main.getByTestId('first-run')).toHaveCount(0);
    } finally {
      await app.close();
    }
    app = await launch(userData);
    try {
      const { main } = await windows(app);
      await atStart(main);
      await expect(main.getByTestId('first-run')).toHaveCount(0);
      expect((await main.evaluate(() => window.freilauf.settings.get())).rider.name).toBe('Rider');
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

/**
 * The start flow end to end: a workout and a route (with a start point) chosen from the start
 * screen, riding them, leaving the ride view while it records, Activity, Settings and Devices
 * on the way, the summary, Ride again, and the last choice preselected afterwards.
 */
test('start screen: workout + route, leave and return mid-ride, quiet places, summary', async () => {
  test.setTimeout(150_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-nav-flow-'));
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await atStart(main);
    await main.getByTestId('first-run-skip').click();
    await expect(main.getByTestId('ride-kind-free')).toHaveAttribute('aria-pressed', 'true');

    // The workout picker; Escape goes back without choosing.
    await main.getByTestId('ride-kind-workout').click();
    await expect(main.getByTestId('panel-workouts')).toBeVisible();
    await main.keyboard.press('Escape');
    await expect(main.getByTestId('start-screen')).toBeVisible();
    await main.getByTestId('ride-kind-workout').click();
    const openers = main.locator(
      '[data-testid="workout-row"][data-workout-id="builtin-openers-30"]',
    );
    await openers.getByTestId('workout-select').click();
    await openers.getByTestId('workout-go-ride').click();
    await expect(main.getByTestId('start-workout-summary')).toContainText('Openers');

    // The route picker: a built-in route, starting part-way along (picked on its profile).
    await main.getByTestId('ride-kind-route').click();
    const climb = main.locator('[data-testid="route-row"][data-route-id="builtin-steady-climb"]');
    await climb.getByTestId('route-select').click();
    await climb.getByTestId('route-details-toggle').click();
    const pick = climb.getByTestId('route-details-profile-pick');
    const box = (await pick.boundingBox())!;
    await pick.click({ position: { x: box.width * 0.5, y: box.height / 2 } });
    await main.getByTestId('route-jump-ok').click();
    await expect(climb.getByTestId('route-start-info')).toContainText('The next ride starts at km');
    await climb.getByTestId('route-go-ride').click();
    await expect(main.getByTestId('start-route-summary')).toContainText(
      /Steady climb · \d+\.\d km · starts at km \d+\.\d/,
    );
    await expect(main.getByTestId('start-combined-note')).toBeVisible();
    await expect(main.getByTestId('ride-kind-workout')).toHaveAttribute('aria-pressed', 'true');
    await expect(main.getByTestId('ride-kind-route')).toHaveAttribute('aria-pressed', 'true');

    // Ride both.
    await main.getByTestId('start-riding').click();
    await expect(main.getByTestId('workout-panel')).toBeVisible();
    await expect(main.getByTestId('ride-scene')).toHaveAttribute('data-view', 'road');
    await expect(main.getByTestId('ride-route')).toBeVisible();

    // Leaving the ride view never pauses the ride: a persistent bar leads back.
    await main.getByTestId('ride-leave').click();
    const bar = main.getByTestId('ride-return-bar');
    await expect(bar).toHaveAttribute('data-state', 'riding');
    const t0 = await bar.locator('.return-time').textContent();
    await expect(bar.locator('.return-time')).not.toHaveText(t0 ?? '', { timeout: 5_000 });
    await expect(main.getByTestId('ride-kind-free')).toBeDisabled();
    await expect(main.getByTestId('start-locked')).toBeVisible();

    // Activity: rides and community, as two tabs of one place; Escape back.
    await main.getByTestId('nav-activity').click();
    await expect(main.getByTestId('panel-history')).toBeVisible();
    await main.getByTestId('tab-community').click();
    await expect(main.getByTestId('panel-community')).toBeVisible();
    await expect(bar).toBeVisible();
    await main.keyboard.press('Escape');
    await expect(main.getByTestId('start-screen')).toBeVisible();

    // Settings: rarely used options collapsed under Advanced; no controllers here.
    await main.getByTestId('nav-settings').click();
    await expect(main.getByTestId('settings-ftp')).toBeVisible();
    await expect(main.getByTestId('settings-advanced')).not.toHaveAttribute('open', '');
    await expect(main.getByTestId('settings-ratio')).toBeHidden();
    await main.getByTestId('settings-advanced').locator(':scope > summary').click();
    await expect(main.getByTestId('settings-ratio')).toBeVisible();
    await expect(main.getByTestId('button-mapping')).toHaveCount(0);
    await main.getByTestId('screen-back').click();

    // Devices: from the device line; the controllers live here.
    await main.getByTestId('start-devices').click();
    await expect(main.getByTestId('device-trainer')).toBeVisible();
    await expect(main.getByTestId('button-mapping')).toBeVisible();
    await expect(main.getByTestId('lever-mapping')).toBeVisible();

    // Back to the ride: still recording.
    await main.getByTestId('ride-return').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding');
    await expect(main.getByTestId('ride-return-bar')).toHaveCount(0);

    // Paused, the bar says so.
    await main.getByTestId('ride-pause').click();
    await main.getByTestId('ride-leave').click();
    await expect(bar).toHaveAttribute('data-state', 'paused');
    await expect(main.getByTestId('start-riding')).toHaveText('Return to ride');
    await main.getByTestId('start-riding').click();
    await main.getByTestId('ride-start').click();

    // Finish → summary; Ride again starts the same workout on the same route.
    await expect(main.getByTestId('stat-time')).toContainText(/0:1[1-9]|0:[2-5]\d/, {
      timeout: 30_000,
    });
    await finishRide(main);
    await expect(main.getByTestId('summary-what')).toHaveText(/Openers.* on Steady climb/);
    await main.getByTestId('summary-again').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding');
    await expect(main.getByTestId('workout-panel')).toBeVisible();
    await expect(main.getByTestId('ride-scene')).toHaveAttribute('data-view', 'road');

    // Too short to keep: the summary says so; Done → the start screen with the last choice.
    await finishRide(main);
    await expect(main.getByTestId('summary-not-saved')).toBeVisible();
    await main.getByTestId('summary-done').click();
    await expect(main.getByTestId('start-screen')).toBeVisible();
    await expect(main.getByTestId('start-workout-summary')).toContainText('Openers');
    await expect(main.getByTestId('start-route-summary')).toContainText('Steady climb');

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
