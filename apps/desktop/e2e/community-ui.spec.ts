import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, windows } from './helpers';

/**
 * The Community tab after a real (simulated) ride, a personal challenge created through the UI,
 * and Settings → Diagnostics → Copy recent log.
 */
test('community tab: own week, a new challenge and the diagnostics card', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-community-ui-'));
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await expect(main.getByTestId('stat-power')).toContainText(/[1-9]\d+/, { timeout: 15_000 });
    // Hard effort: a 25 s ride at the default FTP scores a couple of points.
    await main.getByTestId('sim-effort').fill('400');
    await main.getByTestId('ride-start').click();
    await expect(main.getByTestId('stat-time')).toContainText(/0:2[5-9]/, { timeout: 40_000 });
    await main.getByTestId('ride-finish').click();
    await main.getByTestId('ride-finish-confirm').click();
    await expect(main.getByTestId('ride-start')).toBeVisible();

    await main.getByTestId('tab-community').click();
    await expect(main.getByTestId('panel-community')).toBeVisible();
    await expect(main.getByTestId('community-week-rides')).toHaveText('1');
    const points = Number(await main.getByTestId('community-week-points').textContent());
    expect(points).toBeGreaterThan(0);
    await expect(main.getByTestId('leaderboard-empty')).toBeVisible();
    await expect(main.getByTestId('board-row')).toHaveCount(0);

    // A personal weekly goal: points, low enough that the ride already counts.
    await main.getByTestId('challenge-new').click();
    await expect(main.getByTestId('challenge-create')).toBeVisible();
    await main.getByTestId('challenge-template-personal-goal').click();
    await main.getByTestId('challenge-metric').selectOption('points');
    await main.getByTestId('challenge-target').fill('9999');
    await main.getByTestId('challenge-submit').click();
    await expect(main.getByTestId('challenge-form').getByRole('alert')).toContainText(
      'Enter a number from 1 to 3,500 points.',
    );
    await main.getByTestId('challenge-target').fill('50');
    await main.getByTestId('challenge-title').fill('Fifty this week');
    await main.getByTestId('challenge-submit').click();
    await expect(main.getByTestId('challenge-create')).toHaveCount(0);
    const card = main.getByTestId('challenge-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Fifty this week');
    await expect(card).toContainText('Personal goal · 50 points each');
    await expect(card).toContainText(`${points} / 50 points`);
    await expect(card.getByRole('meter')).toHaveAttribute(
      'aria-valuenow',
      String(Math.round(Math.min(1, points / 50) * 100)),
    );

    // Diagnostics: copy the recent log.
    await main.getByTestId('tab-settings').click();
    const diag = main.getByTestId('settings-diagnostics');
    await diag.scrollIntoViewIfNeeded();
    await diag.getByTestId('log-copy').click();
    await expect(
      main.getByTestId('notice-info').filter({ hasText: 'of the log to the clipboard' }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
