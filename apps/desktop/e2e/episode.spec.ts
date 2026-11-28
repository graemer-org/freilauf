import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { atStart, finishRide, launch, windows } from './helpers';

/**
 * "Fit to an episode" (docs/workouts.md) on simulated devices: choose a 10-minute episode on the
 * start screen, ride it in ERG, press "hard now" (H), see the refusal inside the block, skip on
 * and see the cue ahead of the next change in the overlay.
 */
test('workout fitted to an episode: choose, ride, hard now, cue in the overlay', async () => {
  test.setTimeout(150_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-episode-'));
  const app = await launch(userData);
  try {
    const { main, overlay } = await windows(app);
    const errors: string[] = [];
    for (const page of [main, overlay]) {
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    }
    await atStart(main);

    // The dialog starts from the defaults and previews what it makes.
    await main.getByTestId('ride-kind-episode').click();
    const dialog = main.getByTestId('episode-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('episode-length-42')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('episode-summary')).toContainText('42 min');
    // A custom length outside 10–180 is refused.
    await dialog.getByTestId('episode-length-custom').fill('5');
    await expect(dialog.getByTestId('episode-length-error')).toBeVisible();
    await expect(dialog.getByTestId('episode-use')).toBeDisabled();
    await dialog.getByTestId('episode-length-custom').fill('10');
    await dialog.getByTestId('episode-effort-medium').click();
    await dialog.getByTestId('episode-pattern-spread').click();
    await expect(dialog.getByTestId('episode-preview-chart')).toBeVisible();
    await expect(dialog.getByTestId('episode-summary')).toContainText(
      '10 min · ends exactly with the episode',
    );
    await expect(dialog.getByTestId('episode-summary-hard')).toContainText('2 × 1 min at 95 %');
    await dialog.getByTestId('episode-use').click();
    await expect(dialog).toHaveCount(0);
    await expect(main.getByTestId('start-workout-summary')).toContainText(
      'Episode 10 min · Spread, medium · 10 min',
    );
    await expect(main.getByTestId('ride-kind-episode')).toHaveAttribute('aria-pressed', 'true');
    await expect(main.getByTestId('ride-kind-workout')).toHaveAttribute('aria-pressed', 'false');

    // The choices are remembered: the dialog opens with them again.
    await main.getByTestId('start-episode-change').click();
    await expect(dialog.getByTestId('episode-length-custom')).toHaveValue('10');
    await expect(dialog.getByTestId('episode-pattern-spread')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await main.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(main.getByTestId('start-screen')).toBeVisible();

    // Ride: the countdown, then the warm-up in ERG.
    await main.getByTestId('start-riding').click();
    await expect(main.getByTestId('panel-ride')).toBeVisible();
    await expect(main.getByTestId('workout-label')).toHaveText('Warm-up', { timeout: 15_000 });
    await expect(main.getByTestId('workout-episode-progress')).toContainText('left');
    const strip = overlay.getByTestId('overlay-workout');
    await expect(strip).toBeVisible();
    await expect(overlay.getByTestId('overlay-episode')).toContainText(/\d+:\d\d left/);

    // Hard now (H): the block starts at once; the overlay says so.
    await main.keyboard.press('h');
    await expect(main.getByTestId('workout-label')).toHaveText('Hard now');
    await expect(strip).toContainText('Hard now');
    await expect(overlay.getByTestId('overlay-workout-ahead')).toContainText(
      /Hard now: 2 min · \d+ W/,
    );
    // The total stays the episode length.
    await expect(main.getByTestId('workout-total-remaining')).toContainText(
      /Workout left 9:[45]\d/,
    );

    // Again inside the block: refused with a short note; the panel's button says why.
    const button = main.getByTestId('workout-hard-now');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAttribute('title', 'Already in a hard block.');
    await main.keyboard.press('h');
    await expect(main.getByTestId('workout-ahead')).toHaveText('Already in a hard block.');
    await expect(overlay.getByTestId('overlay-workout-ahead')).toHaveText(
      'Already in a hard block.',
    );

    // Skip on to the endurance part before the next hard one: 10 s before it, the cue.
    await main.getByTestId('workout-skip').click();
    await expect(main.getByTestId('workout-label')).toHaveText('Recovery');
    await main.getByTestId('workout-skip').click();
    await expect(main.getByTestId('workout-label')).toHaveText('Endurance');
    const ahead = overlay.getByTestId('overlay-workout-ahead');
    await expect(ahead).toContainText(/^in \d+ s: 1 min hard · \d+ W$/, { timeout: 40_000 });
    await expect(main.getByTestId('workout-ahead')).toContainText(/^in \d+ s: 1 min hard/);
    await expect(main.getByTestId('workout-label')).toHaveText('Hard 1/1', { timeout: 15_000 });

    await finishRide(main);
    await expect(main.getByTestId('summary-what')).toContainText('Episode 10 min');
    await expect(strip).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
