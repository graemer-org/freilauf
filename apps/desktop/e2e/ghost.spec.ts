import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { atStart, finishRide, launch, windows } from './helpers';

/** A 400 m straight, flat road (north), points every 10 m. */
function laneGpx(): string {
  const lat0 = 47.3;
  const lon0 = 9.2;
  const pts = Array.from({ length: 41 }, (_, i) => ({ lat: lat0 + (i * 10) / 111_320, lon: lon0 }));
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="freilauf-e2e" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>Ghost lane</name><trkseg>
${pts.map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>420</ele></trkpt>`).join('\n')}
</trkseg></trk>
</gpx>`;
}

/** From the start screen: open the ride view, set the simulated effort, start, ride to the finish. */
async function rideToFinish(main: Page, effortW: number): Promise<void> {
  await main.getByTestId('start-open-ride').click();
  await expect(main.getByTestId('panel-ride')).toBeVisible();
  await main.getByTestId('sim-effort').fill(String(effortW));
  await main.getByTestId('ride-start').click();
  await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding', {
    timeout: 10_000,
  });
  await expect(main.getByTestId('ride-route')).toHaveAttribute('data-finished', 'true', {
    timeout: 90_000,
  });
}

/**
 * Ghost rider (docs/ghost.md): ride a route once in simulation, then race that ride as the
 * ghost — chosen on the start screen as "my best time", shown on the scene and in the overlay,
 * judged in the summary.
 */
test('ghost: ride a route twice and race the first ride', async () => {
  test.setTimeout(240_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-ghost-'));
  const gpxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-ghost-gpx-'));
  const gpxFile = path.join(gpxDir, 'lane.gpx');
  fs.writeFileSync(gpxFile, laneGpx());
  const app = await launch(userData);
  try {
    const { main, overlay } = await windows(app);
    const errors: string[] = [];
    for (const page of [main, overlay]) {
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    }
    await atStart(main);

    // A free ride has no ghost, and says why.
    await expect(main.getByTestId('start-ghost-none')).toContainText('needs a route');
    await expect(main.getByTestId('start-ghost')).toHaveCount(0);

    // Import and select the route.
    await main.getByTestId('ride-kind-route').click();
    await main.getByTestId('route-import').setInputFiles(gpxFile);
    await expect(main.getByTestId('route-import-result')).toHaveAttribute('data-ok', 'true');
    const row = main.getByTestId('route-row').filter({ hasText: 'Ghost lane' });
    await row.getByTestId('route-select').click();
    await row.getByTestId('route-go-ride').click();

    // Nothing to race yet: the picker says so and offers an import.
    const picker = main.getByTestId('start-ghost');
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute('data-active', 'none');
    await expect(main.getByTestId('ghost-hint')).toContainText('No earlier ride of this route yet');
    await expect(main.getByTestId('ghost-import-button')).toBeVisible();

    // First ride, easy.
    await rideToFinish(main, 220);
    await finishRide(main);
    await expect(main.getByTestId('summary-best-time')).toContainText(
      'Your first time for the whole route',
    );
    await expect(main.getByTestId('summary-ghost-verdict')).toHaveCount(0);
    await main.getByTestId('summary-done').click();

    // Back on the start screen: that ride is now the ghost, as "my best time".
    await expect(picker).toHaveAttribute('data-active', 'best');
    await expect(main.getByTestId('ghost-source')).toHaveValue('best');
    await expect(main.getByTestId('ghost-hint')).toContainText('Starts when the countdown ends');

    // Second ride, harder: ahead of the ghost on the scene and in the overlay.
    await main.getByTestId('start-open-ride').click();
    await expect(main.getByTestId('ghost-chip')).toHaveAttribute('data-status', 'ready');
    await main.getByTestId('sim-effort').fill('480');
    await main.getByTestId('ride-start').click();
    const chip = main.getByTestId('ghost-chip');
    await expect(chip).toHaveAttribute('data-status', 'racing', { timeout: 15_000 });
    await expect
      .poll(async () => Number(await chip.getAttribute('data-gap-s')), { timeout: 30_000 })
      .toBeGreaterThan(0.5);
    await expect(chip).toHaveClass(/is-ahead/);
    await expect(main.getByTestId('ghost-gap')).toContainText(/^\+\d+ m · \+\d+\.\d s$/);
    await expect(overlay.getByTestId('overlay-ghost')).toHaveAttribute('data-tone', 'ahead');
    await expect(overlay.getByTestId('overlay-ghost')).toContainText(/\+\d+ m · \+\d+\.\d s/);

    // Ride on to the finish: the race is decided there, the summary says so.
    await expect(main.getByTestId('ride-route')).toHaveAttribute('data-finished', 'true', {
      timeout: 90_000,
    });
    await expect(chip).toHaveAttribute('data-status', 'finished');
    await finishRide(main);
    await expect(main.getByTestId('summary-ghost-verdict')).toContainText(
      /You beat your ghost by \d+\.\d s/,
    );
    await expect(main.getByTestId('summary-best-time')).toContainText(
      'New best time on this route',
    );

    // The ride on disk names its route; nothing about the ghost is stored with it.
    const files = fs.readdirSync(path.join(userData, 'rides')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);
    for (const f of files) {
      const stored = JSON.parse(fs.readFileSync(path.join(userData, 'rides', f), 'utf8'));
      expect(stored.ride.route).toMatchObject({ loop: false, offsetsM: [0] });
      expect(Object.keys(stored.ride).sort()).toEqual([
        'ftpW',
        'id',
        'name',
        'riderMassKg',
        'route',
        'samples',
        'startedAt',
      ]);
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(gpxDir, { recursive: true, force: true });
  }
});
