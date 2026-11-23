import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, windows } from './helpers';

const num = (v: string | null): number => Number(v ?? Number.NaN);

/**
 * A small synthetic GPX: 80 m straight north, a 90° right bend over 150 m,
 * then 600 m straight east climbing at 6 %. Points every 10 m with elevation.
 */
function syntheticGpx(): string {
  const lat0 = 47.5;
  const lon0 = 8.5;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const pts: { x: number; y: number; e: number }[] = [{ x: 0, y: 0, e: 400 }];
  let heading = 0;
  const step = 10;
  const legs = [
    { len: 80, turn: 0, grade: 0 },
    { len: 150, turn: 90, grade: 0 },
    { len: 600, turn: 0, grade: 6 },
  ];
  for (const leg of legs) {
    const n = leg.len / step;
    for (let i = 0; i < n; i++) {
      const dh = ((leg.turn / n) * Math.PI) / 180;
      const mid = heading + dh / 2;
      heading += dh;
      const last = pts[pts.length - 1]!;
      pts.push({
        x: last.x + Math.sin(mid) * step,
        y: last.y + Math.cos(mid) * step,
        e: last.e + (leg.grade / 100) * step,
      });
    }
  }
  const trkpts = pts
    .map(
      (p) =>
        `<trkpt lat="${(lat0 + p.y / mPerDegLat).toFixed(7)}" lon="${(lon0 + p.x / mPerDegLon).toFixed(7)}"><ele>${p.e.toFixed(2)}</ele></trkpt>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="freilauf-e2e" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>E2E test road</name><trkseg>
${trkpts}
</trkseg></trk>
</gpx>`;
}

/** Import a GPX, select it, ride it: the road scene follows the file. */
test('routes: import a GPX, ride it in the road view', async () => {
  test.setTimeout(150_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-routes-'));
  const gpxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-gpx-'));
  const gpxFile = path.join(gpxDir, 'test-road.gpx');
  fs.writeFileSync(gpxFile, syntheticGpx());
  const app = await launch(userData);
  try {
    const { main, overlay } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await expect(main.getByTestId('stat-power')).toContainText(/[1-9]\d+/, { timeout: 15_000 });

    // Without a route: the side-on scene and the manual gradient.
    await expect(main.getByTestId('ride-scene')).toHaveAttribute('data-view', 'side');

    // Import through the file input.
    await main.getByTestId('tab-routes').click();
    await expect(main.getByTestId('panel-routes')).toBeVisible();
    await main.getByTestId('route-import').setInputFiles(gpxFile);
    const result = main.getByTestId('route-import-result');
    await expect(result).toHaveAttribute('data-ok', 'true');
    await expect(result).toContainText('E2E test road');
    const row = main.getByTestId('route-row').filter({ hasText: 'E2E test road' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('route-summary')).toContainText('Point to point');

    // Details: larger profile and map.
    await row.getByTestId('route-details-toggle').click();
    await expect(row.getByTestId('route-details')).toBeVisible();
    await expect(row.getByTestId('route-steepest')).toContainText('%');

    // Select it and go to the ride.
    await row.getByTestId('route-select').click();
    await expect(row.getByTestId('route-selected')).toBeVisible();
    await row.getByTestId('route-go-ride').click();

    const scene = main.getByTestId('ride-scene');
    await expect(scene).toHaveAttribute('data-view', 'road');
    await expect(main.getByTestId('ride-route')).toBeVisible();
    await expect(main.getByTestId('route-map')).toBeVisible();
    await expect(main.getByTestId('gradient-route-note')).toHaveText('The route sets the gradient');
    await expect(main.getByTestId('gradient-up')).toBeDisabled();
    const heading0 = num(await scene.getAttribute('data-heading'));
    expect(Math.abs(heading0)).toBeLessThan(10); // heading north at the start

    // Ride.
    await main.getByTestId('sim-effort').fill('450');
    await main.getByTestId('ride-start').click();
    await expect(scene).toHaveAttribute('data-state', 'riding');
    await expect
      .poll(async () => num(await scene.getAttribute('data-distance')), { timeout: 20_000 })
      .toBeGreaterThan(5);
    const profile = main.getByTestId('route-profile');
    const pos0 = num(await profile.getAttribute('data-position'));

    // The bend shows ahead, then the heading turns through it.
    await expect
      .poll(async () => num(await scene.getAttribute('data-curve')), { timeout: 20_000 })
      .toBeGreaterThan(30);
    await expect
      .poll(async () => num(await scene.getAttribute('data-heading')), { timeout: 60_000 })
      .toBeGreaterThan(70);

    // Steering moves the rider across the lane.
    await main.getByTestId('stat-power').click();
    const lat0 = num(await scene.getAttribute('data-lateral'));
    await main.keyboard.down('d');
    await expect
      .poll(async () => num(await scene.getAttribute('data-lateral')), { timeout: 5_000 })
      .toBeGreaterThan(lat0 + 0.3);
    await main.keyboard.up('d');

    // On the climb the gradient comes from the file (6 %), not from the manual control (0 %).
    await expect
      .poll(async () => num(await scene.getAttribute('data-distance')), { timeout: 60_000 })
      .toBeGreaterThan(330);
    await expect
      .poll(async () => num(await scene.getAttribute('data-grade')), { timeout: 10_000 })
      .toBeGreaterThan(4);
    expect(num(await scene.getAttribute('data-grade'))).toBeLessThan(8);
    await expect(main.getByTestId('gradient-value')).toContainText(/\+[4-7]\.\d %/);

    // The profile marker has moved; the overlay shows the route strip.
    expect(num(await profile.getAttribute('data-position'))).toBeGreaterThan(pos0 + 0.2);
    await expect(main.getByTestId('route-remaining')).toContainText(/m|km/);
    await expect(overlay.getByTestId('overlay-route')).toContainText('to go');

    // While riding the route cannot be changed.
    await main.getByTestId('tab-routes').click();
    await expect(main.getByTestId('routes-locked')).toBeVisible();
    await expect(
      main.getByTestId('route-row').filter({ hasText: 'E2E test road' }).getByTestId('route-clear'),
    ).toBeDisabled();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(gpxDir, { recursive: true, force: true });
  }
});
