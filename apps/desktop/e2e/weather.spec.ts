import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeWeather } from './fakeWeather';
import { atStart, finishRide, launch, windows } from './helpers';
import { isarExcerpt } from './osmScenery';

/**
 * The weather of that day (docs/routes.md): import a recorded GPX with "Load the weather of
 * that day" ticked, against a fake archive on this computer; the day of the recording is used,
 * fetched once from the main process, stored next to the route; the ride shows the wind and
 * is flagged in the summary; "Ride with that day's wind" off rides without it.
 */
test('weather: import with the day’s weather from a fake archive, ride with its wind, switch off', async () => {
  test.setTimeout(180_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-wx-'));
  const gpxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-gpx-'));
  const gpxFile = path.join(gpxDir, 'isar-valley.gpx');
  fs.writeFileSync(gpxFile, isarExcerpt(4)); // with the fixture's <time>s (2 May 2026)
  const server = await fakeWeather();
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await atStart(main);
    await main.evaluate(
      (url) => window.freilauf.settings.update({ weather: { archiveUrl: url } }),
      server.url,
    );

    await main.getByTestId('ride-kind-route').click();
    await expect(main.getByTestId('panel-routes')).toBeVisible();
    const option = main.getByTestId('route-import-weather');
    await expect(option).not.toBeChecked(); // off by default
    await expect(main.getByTestId('route-import-weather-note')).toContainText(
      'learns roughly where (to about 10 km) and which day',
    );
    await option.check();
    await expect(main.getByTestId('route-import-weather-date')).toBeVisible();
    await main.getByTestId('route-import').setInputFiles(gpxFile);
    const result = main.getByTestId('route-import-result');
    await expect(result).toHaveAttribute('data-ok', 'true');
    await expect(result).toContainText('Weather of the recorded ride: 2 May 2026');
    const row = main.getByTestId('route-row').filter({ hasText: 'Isar valley test' });
    await expect(row.getByTestId('route-weather-badge')).toContainText('Weather of 2 May 2026', {
      timeout: 30_000,
    });

    // What the weather server saw: one GET with grid cells, the recorded days, a generic name.
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.method).toBe('GET');
    expect(req.userAgent).toBe('Freilauf (open-source indoor cycling app)');
    expect(req.url).toContain('start_date=2026-05-01&end_date=2026-05-03');
    expect(req.url).toMatch(/latitude=47\.\d(&|,)/);

    // Details: the summary and the attribution.
    await row.getByTestId('route-details-toggle').click();
    await expect(row.getByTestId('route-weather-summary')).toContainText('2 May 2026');
    await expect(row.getByTestId('route-weather-summary')).toContainText('wind 29 km/h');
    await expect(row.getByTestId('route-weather-attribution')).toContainText(
      'Weather data by Open-Meteo.com (CC BY 4.0)',
    );

    // Start screen: "Ride with that day's wind", on by default.
    await row.getByTestId('route-select').click();
    await row.getByTestId('route-go-ride').click();
    const toggle = main.getByTestId('start-wind-toggle');
    await expect(toggle).toBeChecked();
    await expect(main.getByTestId('start-wind')).toContainText('(2 May 2026)');

    // Ride: the wind chip names the wind along the road and the weather of that hour.
    await main.getByTestId('start-open-ride').click();
    const chip = main.getByTestId('wind-chip');
    await expect(chip).toBeVisible();
    await expect(main.getByTestId('wind-text')).toHaveText(
      /^(Headwind|Tailwind|Crosswind) \d+ km\/h$/,
    );
    await expect(main.getByTestId('wind-weather')).toHaveText('14 °C · Rain');
    await expect(main.getByTestId('scene-rain')).toBeVisible();
    await main.getByTestId('sim-effort').fill('300');
    await main.getByTestId('ride-start').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding');
    await main.waitForTimeout(12_000);
    expect(server.requests).toHaveLength(1); // nothing fetched at ride time
    await finishRide(main);
    await expect(main.getByTestId('summary-wind')).toHaveText('With wind of 2 May 2026');
    await main.getByTestId('summary-done').click();

    // Switched off: ridden without wind, not flagged; remembered.
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await main.getByTestId('start-open-ride').click();
    await expect(main.getByTestId('panel-ride')).toBeVisible();
    await expect(chip).toHaveCount(0);
    await main.getByTestId('ride-start').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding');
    await main.waitForTimeout(12_000);
    await finishRide(main);
    await expect(main.getByTestId('summary-screen')).toBeVisible();
    await expect(main.getByTestId('summary-wind')).toHaveCount(0);
    const settings = await main.evaluate(() => window.freilauf.settings.get());
    expect(Object.values(settings.weather.rideWithWind)).toEqual([false]);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await server.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(gpxDir, { recursive: true, force: true });
  }
});
