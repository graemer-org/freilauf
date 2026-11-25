import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { atStart, finishRide, launch, openRideView, windows } from './helpers';

/**
 * Energy estimates (docs/energy.md): a finished sim ride's summary shows kcal from power and
 * fat / carbohydrate, consistent with kcal = kJ / (4.184 × 0.24) of the recorded ride and with
 * fat × 9.4 + carbohydrate × 4.1 = kcal.
 */
test('the summary shows kcal and fat/carb consistent with the power-based formula', async () => {
  test.setTimeout(90_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-energy-'));
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await atStart(main);
    // FTP 400 W: riding at 300 W is 75 % of FTP, so a fair share of the energy is from fat.
    await main.evaluate(() =>
      window.freilauf.settings.update({ rider: { ftpW: 400, ageYears: 40, sex: 'male' } }),
    );
    await expect
      .poll(() => main.evaluate(() => window.freilauf.settings.get().then((s) => s.rider.ftpW)))
      .toBe(400);
    await openRideView(main);
    await main.getByTestId('sim-effort').fill('300');
    await main.getByTestId('ride-start').click();
    await expect(main.getByTestId('stat-time')).toContainText(/0:2[0-9]/, { timeout: 40_000 });
    // Live: kcal so far under the power.
    await expect(main.getByTestId('stat-calories')).toContainText(/[1-9]\d*\s*kcal/);
    await finishRide(main);

    const energy = main.getByTestId('summary-energy');
    await expect(energy).toBeVisible();
    await expect(energy).toHaveAttribute('data-source', 'power');
    await expect(main.getByTestId('summary-kcal')).toContainText(/[1-9]\d*\s*kcal/);
    await expect(main.getByTestId('summary-fat')).toContainText(/\d+\s*g/);
    await expect(main.getByTestId('summary-carb')).toContainText(/\d+\s*g/);
    await expect(main.getByTestId('summary-energy-rough')).toContainText('rough estimate');

    const kcal = Number(await energy.getAttribute('data-kcal'));
    const fatG = Number(await energy.getAttribute('data-fat-g'));
    const carbG = Number(await energy.getAttribute('data-carb-g'));

    // The recorded ride: work from its 1 Hz samples.
    const dir = path.join(userData, 'rides');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    expect(file).toBeTruthy();
    const stored = JSON.parse(fs.readFileSync(path.join(dir, file!), 'utf8')) as {
      ride: { ftpW?: number; samples: { elapsedS: number; powerW: number }[] };
    };
    expect(stored.ride.ftpW).toBe(400);
    let prev = 0;
    let workJ = 0;
    for (const s of stored.ride.samples) {
      workJ += s.powerW * Math.min(5, Math.max(0, s.elapsedS - prev));
      prev = s.elapsedS;
    }
    expect(workJ).toBeGreaterThan(0);
    expect(kcal).toBeCloseTo(workJ / 1000 / (4.184 * 0.24), 6);
    expect(fatG).toBeGreaterThan(0);
    expect(carbG).toBeGreaterThan(0);
    expect(fatG * 9.4 + carbG * 4.1).toBeCloseTo(kcal, 6);
    await main.getByTestId('summary-done').click();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
