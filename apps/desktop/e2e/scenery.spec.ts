import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { atStart, launch, windows } from './helpers';
import { fakeOverpass, isarExcerpt } from './osmScenery';

const num = (v: string | null): number => Number(v ?? Number.NaN);

/**
 * Surroundings from OpenStreetMap (docs/routes.md): import a GPX with "Load surroundings"
 * ticked, against a fake Overpass server on this computer; the scenery is fetched once,
 * stored, and the road view draws the village with the attribution. Nothing is fetched while
 * riding. Removing it takes the buildings away again.
 */
test('scenery: import with surroundings from a fake map server, ride, see buildings', async () => {
  test.setTimeout(180_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-osm-'));
  const gpxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-gpx-'));
  const gpxFile = path.join(gpxDir, 'isar-valley.gpx');
  fs.writeFileSync(gpxFile, isarExcerpt(7));
  const server = await fakeOverpass();
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await atStart(main);
    // A server on this computer instead of the public one (the Settings field does the same).
    await main.evaluate(
      (url) => window.freilauf.settings.update({ scenery: { overpassUrl: url } }),
      server.url,
    );

    await main.getByTestId('ride-kind-route').click();
    await expect(main.getByTestId('panel-routes')).toBeVisible();
    const option = main.getByTestId('route-import-scenery');
    await expect(option).not.toBeChecked(); // off by default
    await expect(main.getByTestId('route-import-scenery-note')).toContainText(
      'roughly where the route runs',
    );
    await option.check();
    await main.getByTestId('route-import').setInputFiles(gpxFile);
    await expect(main.getByTestId('route-import-result')).toHaveAttribute('data-ok', 'true');
    const row = main.getByTestId('route-row').filter({ hasText: 'Isar valley test' });
    await expect(row.getByTestId('route-scenery-badge')).toBeVisible({ timeout: 60_000 });
    await expect(
      main.getByTestId('notice-info').filter({ hasText: 'Surroundings of' }),
    ).toBeVisible();

    // What the map server saw: form-encoded queries with a generic User-Agent, nothing else.
    expect(server.requests.length).toBeGreaterThan(0);
    for (const r of server.requests) {
      expect(r.userAgent).toBe('Freilauf (open-source indoor cycling app)');
      expect(r.contentType).toMatch(/^application\/x-www-form-urlencoded/);
      expect(decodeURIComponent(r.body.replace(/^data=/, ''))).toContain('way["building"]');
    }
    const fetched = server.requests.length;

    // Details: the summary with the attribution.
    await row.getByTestId('route-details-toggle').click();
    await expect(row.getByTestId('route-scenery-summary')).toContainText(/\d+ buildings/);
    await expect(row.getByTestId('route-scenery-summary')).toContainText('Kleinmoos');
    await expect(row.getByTestId('route-scenery-attribution')).toContainText(
      '© OpenStreetMap contributors',
    );

    // Ride it: the village is drawn, with the attribution in the scene's corner.
    await row.getByTestId('route-select').click();
    await row.getByTestId('route-go-ride').click();
    await main.getByTestId('start-open-ride').click();
    const scene = main.getByTestId('ride-scene');
    await expect(scene).toHaveAttribute('data-view', 'road');
    await expect(scene).toHaveAttribute('data-scenery', 'on', { timeout: 10_000 });
    await expect
      .poll(async () => num(await scene.getAttribute('data-buildings')), { timeout: 10_000 })
      .toBeGreaterThan(20);
    await expect(main.getByTestId('scene-attribution')).toBeVisible();
    await expect(main.getByTestId('scene-attribution')).toHaveText('© OpenStreetMap contributors');
    await main.getByTestId('sim-effort').fill('400');
    await main.getByTestId('ride-start').click();
    await expect(scene).toHaveAttribute('data-state', 'riding');
    await expect
      .poll(async () => num(await scene.getAttribute('data-distance')), { timeout: 30_000 })
      .toBeGreaterThan(150);
    // Smooth: the measured draw time stays well inside a 60 fps frame.
    const frameMs = num(await scene.getAttribute('data-frame-ms'));
    console.info(`road view in the village: ${frameMs.toFixed(2)} ms per frame (smoothed)`);
    expect(frameMs).toBeLessThan(12);
    // The side view shows the far side's houses as silhouettes, with the attribution too.
    await main.getByTestId('scene-view-side').click();
    await expect(scene).toHaveAttribute('data-view', 'side');
    await expect(scene).toHaveAttribute('data-scenery', 'on', { timeout: 10_000 });
    await expect(main.getByTestId('scene-attribution')).toBeVisible();
    await main.getByTestId('scene-view-road').click();
    expect(server.requests.length).toBe(fetched); // nothing fetched at ride time

    // Switched off in Settings: the road view is as before, without the attribution.
    await main.evaluate(() => window.freilauf.settings.update({ scenery: { enabled: false } }));
    await expect(scene).toHaveAttribute('data-scenery', 'off', { timeout: 10_000 });
    await expect(main.getByTestId('scene-attribution')).toBeHidden();
    await main.evaluate(() => window.freilauf.settings.update({ scenery: { enabled: true } }));
    await expect(scene).toHaveAttribute('data-scenery', 'on', { timeout: 10_000 });

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await server.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(gpxDir, { recursive: true, force: true });
  }
});

test('scenery: stored with the route across restarts, removable, never fetched unasked', async () => {
  test.setTimeout(180_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-osm2-'));
  const gpxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-gpx-'));
  const gpxFile = path.join(gpxDir, 'isar-valley.gpx');
  fs.writeFileSync(gpxFile, isarExcerpt(3));
  const server = await fakeOverpass();
  try {
    let app = await launch(userData);
    let { main } = await windows(app);
    await atStart(main);
    await main.evaluate(
      (url) => window.freilauf.settings.update({ scenery: { overpassUrl: url } }),
      server.url,
    );
    // Imported without the option: no request at all.
    await main.getByTestId('ride-kind-route').click();
    await main.getByTestId('route-import').setInputFiles(gpxFile);
    let row = main.getByTestId('route-row').filter({ hasText: 'Isar valley test' });
    await expect(row).toBeVisible();
    await row.getByTestId('route-details-toggle').click();
    await expect(row.getByTestId('route-scenery')).toHaveAttribute('data-state', 'none');
    expect(server.requests).toHaveLength(0);
    // Later, from the details.
    await row.getByTestId('route-scenery-load').click();
    await expect(row.getByTestId('route-scenery')).toHaveAttribute('data-state', 'ready', {
      timeout: 60_000,
    });
    const files = fs.readdirSync(path.join(userData, 'scenery'));
    expect(files).toHaveLength(1);
    await app.close();

    // After a restart it is still there (offline: the server is not asked again).
    const before = server.requests.length;
    app = await launch(userData);
    ({ main } = await windows(app));
    await atStart(main);
    await main.getByTestId('ride-kind-route').click();
    row = main.getByTestId('route-row').filter({ hasText: 'Isar valley test' });
    await expect(row.getByTestId('route-scenery-badge')).toBeVisible();
    await row.getByTestId('route-details-toggle').click();
    await expect(row.getByTestId('route-scenery-summary')).toContainText(/\d+ buildings/);
    await row.getByTestId('route-scenery-remove').click();
    await expect(row.getByTestId('route-scenery')).toHaveAttribute('data-state', 'none');
    expect(fs.readdirSync(path.join(userData, 'scenery'))).toHaveLength(0);
    expect(server.requests.length).toBe(before);
    await app.close();
  } finally {
    await server.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(gpxDir, { recursive: true, force: true });
  }
});
