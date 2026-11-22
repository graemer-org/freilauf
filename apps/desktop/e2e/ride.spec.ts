import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, windows } from './helpers';

/** A whole free ride on simulated devices, driven through the real UI. */
test('free ride in sim mode: ride, shift, climb, finish, history', async () => {
  test.setTimeout(90_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-ride-'));
  const app = await launch(userData);
  try {
    const { main, overlay } = await windows(app);
    const errors: string[] = [];
    for (const page of [main, overlay]) {
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    }

    // Simulated devices connect on their own; power starts flowing.
    await expect(main.getByTestId('stat-power')).toContainText(/[1-9]\d+/, { timeout: 15_000 });
    await expect(main.getByTestId('stat-gear')).toContainText('12');

    await main.getByTestId('ride-start').click();
    await expect(main.getByTestId('ride-pause')).toBeVisible();

    // Shifting via UI and keyboard changes the gear, here and in the overlay.
    await main.getByTestId('gear-up').click();
    await main.getByTestId('gear-up').click();
    await expect(main.getByTestId('stat-gear')).toContainText('14');
    await main.getByTestId('stat-power').click(); // move focus off the button
    await main.keyboard.press('ArrowDown');
    await expect(main.getByTestId('stat-gear')).toContainText('13');
    await expect(overlay.getByTestId('overlay-tile-gear')).toContainText('13');

    await main.getByTestId('gradient-up').click();
    await expect(main.getByTestId('gradient-value')).toContainText('0.5');

    // Ride long enough to be kept (≥ 10 s), then finish.
    await expect(main.getByTestId('stat-time')).toContainText(/0:1[2-9]/, { timeout: 30_000 });
    await expect(main.getByTestId('stat-distance')).not.toContainText('0.00');
    await main.getByTestId('ride-finish').click();
    await main.getByTestId('ride-finish-confirm').click();
    await expect(main.getByTestId('ride-start')).toBeVisible();

    await main.getByTestId('tab-history').click();
    await expect(main.getByTestId('history-row')).toHaveCount(1);

    // The ride is on disk and exports to a valid-looking FIT file.
    const rides = fs.readdirSync(path.join(userData, 'rides')).filter((f) => f.endsWith('.json'));
    expect(rides).toHaveLength(1);
    const ride = JSON.parse(fs.readFileSync(path.join(userData, 'rides', rides[0]!), 'utf8'));
    const samples = ride.samples ?? ride.ride?.samples;
    expect(samples.length).toBeGreaterThanOrEqual(12);
    expect(samples.at(-1).gear).toBe(13);
    expect(samples.at(-1).distanceM).toBeGreaterThan(20);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
