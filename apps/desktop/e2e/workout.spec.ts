import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, windows } from './helpers';

const SMALL_ZWO = `<?xml version="1.0" encoding="UTF-8"?>
<workout_file>
  <name>E2E tempo</name>
  <description>Short tempo test workout.</description>
  <sportType>bike</sportType>
  <workout>
    <Warmup Duration="120" PowerLow="0.5" PowerHigh="0.7"/>
    <SteadyState Duration="300" Power="0.85"><textevent timeoffset="0" message="Settle in"/></SteadyState>
    <Cooldown Duration="120" PowerLow="0.6" PowerHigh="0.4"/>
  </workout>
</workout_file>`;

const num = (text: string | null): number => Number((text ?? '').replace(/[^\d.]/g, ''));

/** A structured workout on simulated devices, driven through the real UI. */
test('structured workout in sim mode: select, ride in ERG, skip, intensity, import', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-workout-'));
  const app = await launch(userData);
  try {
    const { main, overlay } = await windows(app);
    const errors: string[] = [];
    for (const page of [main, overlay]) {
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    }
    await expect(main.getByTestId('stat-power')).toContainText(/[1-9]\d+/, { timeout: 15_000 });

    // Choose a built-in workout.
    await main.getByTestId('tab-workouts').click();
    await expect(main.getByTestId('panel-workouts')).toBeVisible();
    const row = main.locator(
      '[data-testid="workout-row"][data-workout-id="builtin-sweet-spot-3x12"]',
    );
    await row.getByTestId('workout-select').click();
    await expect(row.getByTestId('workout-selected')).toBeVisible();
    await row.getByTestId('workout-go-ride').click();

    // Before the start: a banner names the next ride.
    await expect(main.getByTestId('panel-ride')).toBeVisible();
    await expect(main.getByTestId('workout-banner')).toContainText('Sweet spot 3×12');
    await main.getByTestId('ride-start').click();

    // Running: target shown, the simulated trainer converges towards it in ERG.
    const panel = main.getByTestId('workout-panel');
    await expect(panel).toBeVisible();
    await expect(main.getByTestId('workout-label')).toHaveText('Warm-up');
    await expect(main.getByTestId('workout-target-value')).toHaveText(/^\d+$/);
    await expect(main.getByTestId('erg-note')).toBeVisible();
    await expect
      .poll(
        async () => {
          const target = num(await main.getByTestId('workout-target-value').textContent());
          const power = num(
            await main.getByTestId('stat-power3s').locator('.tile-number').textContent(),
          );
          return target > 0 ? Math.abs(power - target) / target : 1;
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBeLessThan(0.1);
    await expect(main.getByTestId('workout-remaining')).toHaveText(/^\d+:\d\d$/);
    await expect(main.getByTestId('workout-next')).toContainText('Next:');

    // The overlay shows the strip above its tiles.
    const strip = overlay.getByTestId('overlay-workout');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('Warm-up');

    // Skip to the next step.
    await main.getByTestId('workout-skip').click();
    await expect(main.getByTestId('workout-label')).toHaveText('Steady');
    await expect(strip).toContainText('Steady');

    // Intensity + raises the target.
    const before = num(await main.getByTestId('workout-target-value').textContent());
    await main.getByTestId('workout-intensity-up').click();
    await expect(main.getByTestId('workout-intensity-value')).toHaveText('105 %');
    await expect
      .poll(async () => num(await main.getByTestId('workout-target-value').textContent()))
      .toBeGreaterThan(before);

    // Finish: the workout is done with; the next ride is a free ride again.
    await expect(main.getByTestId('stat-time')).toContainText(/0:1[1-9]|0:[2-5]\d/, {
      timeout: 30_000,
    });
    await main.getByTestId('ride-finish').click();
    await main.getByTestId('ride-finish-confirm').click();
    await expect(main.getByTestId('ride-start')).toBeVisible();
    await expect(main.getByTestId('workout-panel')).toHaveCount(0);
    await expect(main.getByTestId('workout-banner')).toHaveCount(0);
    await expect(strip).toHaveCount(0);

    // Import a .zwo file through the file input.
    await main.getByTestId('tab-workouts').click();
    await main.getByTestId('workout-import').setInputFiles({
      name: 'e2e-tempo.zwo',
      mimeType: 'application/xml',
      buffer: Buffer.from(SMALL_ZWO, 'utf8'),
    });
    await expect(main.getByTestId('workout-import-result')).toHaveAttribute('data-ok', 'true');
    const mine = main.getByTestId('workouts-mine');
    await expect(mine.getByTestId('workout-row')).toHaveCount(1);
    await expect(mine.getByTestId('workout-row')).toContainText('E2E tempo');
    await expect(mine.getByTestId('workout-row')).toContainText('9 min');

    // A broken file is reported, not thrown.
    await main.getByTestId('workout-import').setInputFiles({
      name: 'broken.zwo',
      mimeType: 'application/xml',
      buffer: Buffer.from('<workout_file><workout>', 'utf8'),
    });
    await expect(main.getByTestId('workout-import-result')).toHaveAttribute('data-ok', 'false');
    await expect(mine.getByTestId('workout-row')).toHaveCount(1);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
