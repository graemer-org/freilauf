import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { atStart, finishRide, launch, windows } from './helpers';

/**
 * The countdown before a ride starts or resumes (docs/getting-started.md): Start → 3, 2, 1 in
 * the ride view and the overlay → recording from 0:00; pause is immediate, Resume counts again;
 * Start / Space / Escape cancel; Settings → Ride → Off starts at once.
 */
test('countdown before the start and the resume; cancel; off', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-countdown-'));
  const app = await launch(userData);
  try {
    const { main, overlay } = await windows(app);
    const errors: string[] = [];
    for (const page of [main, overlay]) {
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    }
    await atStart(main);

    // Start riding: the ride view shows the countdown at once; nothing is recorded yet.
    const pressedAt = Date.now();
    await main.getByTestId('start-riding').click();
    await expect(main.getByTestId('panel-ride')).toBeVisible();
    const countdown = main.getByTestId('ride-countdown');
    const digit = countdown.getByTestId('countdown-digit');
    await expect(countdown).toHaveAttribute('data-kind', 'start');
    await expect(countdown).toContainText('Get ready');
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'idle');
    await expect(main.getByTestId('ride-start')).toHaveText('Cancel');
    // The overlay shows it too (seen over a fullscreen video).
    await expect(overlay.getByTestId('overlay-countdown')).toBeVisible();
    for (const n of ['3', '2', '1']) {
      await expect(digit).toHaveText(n, { timeout: 2_000 });
      await expect(overlay.getByTestId('countdown-digit')).toHaveText(n, { timeout: 2_000 });
    }
    await expect(main.getByTestId('stat-time')).toContainText('0:00');

    // Zero: recording starts, the time from 0:00.
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding', {
      timeout: 3_000,
    });
    const tookMs = Date.now() - pressedAt;
    expect(tookMs).toBeGreaterThan(2_500);
    expect(tookMs).toBeLessThan(5_000);
    await expect(countdown).toHaveCount(0);
    await expect(overlay.getByTestId('overlay-countdown')).toHaveCount(0);
    await expect(main.getByTestId('stat-time')).toContainText(/0:0[0-1]/);

    // Pause: at once. Resume: the countdown again, then riding.
    await expect(main.getByTestId('stat-time')).toContainText(/0:0[3-9]/, { timeout: 10_000 });
    await main.getByTestId('ride-pause').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'paused', {
      timeout: 1_000,
    });
    await expect(countdown).toHaveCount(0);
    await main.getByTestId('ride-start').click();
    await expect(countdown).toHaveAttribute('data-kind', 'resume');
    await expect(overlay.getByTestId('overlay-countdown')).toHaveAttribute('data-kind', 'resume');
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'paused');
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding', {
      timeout: 5_000,
    });

    // Pressing Resume again during the countdown cancels it: still paused afterwards.
    await main.getByTestId('ride-pause').click();
    await main.getByTestId('ride-start').click();
    await expect(countdown).toBeVisible();
    await main.getByTestId('ride-start').click();
    await expect(countdown).toHaveCount(0);
    await expect(main.getByTestId('ride-start')).toHaveText('Resume');

    // Space starts the countdown, Escape cancels it; Space twice cancels too.
    await main.getByTestId('stat-power').click(); // focus off the buttons
    await main.keyboard.press('Space');
    await expect(countdown).toBeVisible();
    await main.keyboard.press('Escape');
    await expect(countdown).toHaveCount(0);
    await main.keyboard.press('Space');
    await expect(countdown).toBeVisible();
    await main.keyboard.press('Space');
    await expect(countdown).toHaveCount(0);
    await main.waitForTimeout(3_500);
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'paused');

    // Long enough to keep, finish; then Settings → Ride → Off: Start riding starts at once.
    await main.getByTestId('ride-start').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding', {
      timeout: 5_000,
    });
    await expect(main.getByTestId('stat-time')).toContainText(/0:1[0-9]/, { timeout: 15_000 });
    await finishRide(main);
    await main.getByTestId('summary-done').click();
    await main.getByTestId('nav-settings').click();
    await expect(main.getByTestId('settings-countdown-3')).toHaveAttribute('aria-checked', 'true');
    await main.getByTestId('settings-countdown-0').click();
    await expect(main.getByTestId('settings-countdown-0')).toHaveAttribute('aria-checked', 'true');
    await main.getByTestId('screen-back').click();
    await main.getByTestId('start-riding').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding', {
      timeout: 1_000,
    });
    await expect(countdown).toHaveCount(0);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
