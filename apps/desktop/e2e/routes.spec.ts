import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { atStart, launch, openRideView, windows } from './helpers';

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
    await atStart(main);

    // Without a route: the side-on scene and the manual gradient.
    await openRideView(main);
    await expect(main.getByTestId('ride-scene')).toHaveAttribute('data-view', 'side');
    await main.getByTestId('ride-leave').click();

    // Import through the file input: the Route card opens the library as a picker.
    await main.getByTestId('ride-kind-route').click();
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

    // Select it; Done leads back to the start screen, which names it.
    await row.getByTestId('route-select').click();
    await expect(row.getByTestId('route-selected')).toBeVisible();
    await row.getByTestId('route-go-ride').click();
    await expect(main.getByTestId('start-route-summary')).toContainText(/E2E test road · 8\d0 m/);
    await expect(main.getByTestId('ride-kind-route')).toHaveAttribute('aria-pressed', 'true');
    await main.getByTestId('start-open-ride').click();

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

    // While riding the route cannot be changed (the start screen leads to the locked picker;
    // the ride keeps recording meanwhile and the bar leads back).
    await main.getByTestId('ride-leave').click();
    await expect(main.getByTestId('ride-return-bar')).toHaveAttribute('data-state', 'riding');
    await expect(main.getByTestId('start-riding')).toHaveText('Return to ride');
    await main.getByTestId('ride-kind-route').click();
    await expect(main.getByTestId('routes-locked')).toBeVisible();
    await expect(
      main.getByTestId('route-row').filter({ hasText: 'E2E test road' }).getByTestId('route-clear'),
    ).toBeDisabled();
    await main.getByTestId('ride-return').click();
    await expect(scene).toHaveAttribute('data-state', 'riding');

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(gpxDir, { recursive: true, force: true });
  }
});

/**
 * Choose a start point on the profile before the ride, then jump during it: the place on the
 * route (position, gradient, "to go", the road scene) changes; the ride distance does not.
 */
test('routes: start part-way along, then jump back during the ride', async () => {
  test.setTimeout(150_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-jump-'));
  const gpxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-gpx-'));
  const gpxFile = path.join(gpxDir, 'test-road.gpx');
  fs.writeFileSync(gpxFile, syntheticGpx());
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await atStart(main);

    await main.getByTestId('ride-kind-route').click();
    await main.getByTestId('route-import').setInputFiles(gpxFile);
    const row = main.getByTestId('route-row').filter({ hasText: 'E2E test road' });
    await row.getByTestId('route-select').click();
    await row.getByTestId('route-go-ride').click();
    await openRideView(main);

    const scene = main.getByTestId('ride-scene');
    const pick = main.getByTestId('route-profile-pick');
    const confirm = main.getByTestId('route-jump-confirm');
    await expect(pick).toHaveAttribute('data-mode', 'start');
    const clickAt = async (fraction: number) => {
      const box = (await pick.boundingBox())!;
      await pick.click({ position: { x: box.width * fraction, y: box.height / 2 } });
    };

    // Before the ride: hover shows the point; a click asks; "Start here" sets the start.
    const box0 = (await pick.boundingBox())!;
    await pick.hover({ position: { x: box0.width * 0.6, y: box0.height / 2 } });
    await expect(main.getByTestId('route-pick-tip').first()).toContainText(/km 0\.\d · \d+ m · /);
    await clickAt(0.6); // ≈ 500 m: on the 6 % climb, heading east
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveAttribute('data-mode', 'start');
    await expect(main.getByTestId('route-jump-text')).toContainText(/^Start at km 0\.5 /);
    await main.getByTestId('route-jump-ok').click();
    await expect(confirm).toHaveCount(0);
    await expect(main.getByTestId('route-start-note')).toHaveText('Starts at km 0.5');
    await expect(main.getByTestId('route-start-marker')).toHaveCount(1);
    await expect
      .poll(async () => num(await scene.getAttribute('data-distance')), { timeout: 10_000 })
      .toBeGreaterThan(450);
    expect(num(await scene.getAttribute('data-heading'))).toBeGreaterThan(80); // east, not north

    // Ride: it starts there, on the climb (the start of the file is flat).
    await main.getByTestId('sim-effort').fill('450');
    await main.getByTestId('ride-start').click();
    await expect(scene).toHaveAttribute('data-state', 'riding');
    await expect
      .poll(async () => num(await scene.getAttribute('data-grade')), { timeout: 15_000 })
      .toBeGreaterThan(4);
    await expect(main.getByTestId('route-start-note')).toHaveText('Started at km 0.5');
    expect(
      num(await main.getByTestId('route-profile').getAttribute('data-position')),
    ).toBeGreaterThan(0.55);
    await expect(pick).toHaveAttribute('data-mode', 'jump');
    await expect
      .poll(async () => num(await scene.getAttribute('data-distance')), { timeout: 20_000 })
      .toBeGreaterThan(520);

    // Cancel does nothing.
    await clickAt(0.05);
    await expect(main.getByTestId('route-jump-text')).toContainText(/^Jump to km 0\.0 /);
    await main.getByTestId('route-jump-cancel').click();
    await expect(confirm).toHaveCount(0);
    await main.waitForTimeout(600);
    expect(num(await scene.getAttribute('data-distance'))).toBeGreaterThan(500);
    await expect(main.getByTestId('route-start-note')).toHaveText('Started at km 0.5');

    // Jump back to the flat start (heading north): place changes, ride distance does not.
    const remainingBefore = await main.getByTestId('route-remaining').textContent();
    const ridden = async () => {
      const t = (await main.getByTestId('stat-distance').textContent()) ?? '';
      return Number(t.replace(/[^\d.]/g, ''));
    };
    const riddenBefore = await ridden();
    await clickAt(0.05);
    await main.getByTestId('route-jump-ok').click();
    await expect(main.getByTestId('route-start-note')).toHaveText(/^Jumped to km 0\.0$/);
    await expect
      .poll(async () => num(await scene.getAttribute('data-distance')), { timeout: 5_000 })
      .toBeLessThan(150);
    await expect(scene).toHaveAttribute('data-jumps', '1');
    await expect
      .poll(async () => num(await scene.getAttribute('data-heading')), { timeout: 5_000 })
      .toBeLessThan(20);
    await expect
      .poll(async () => num(await scene.getAttribute('data-grade')), { timeout: 10_000 })
      .toBeLessThan(1);
    await expect(main.getByTestId('route-remaining')).not.toHaveText(remainingBefore ?? '');
    await expect(main.getByTestId('route-remaining')).toContainText(/[78]\d0 m/);
    const riddenAfter = await ridden();
    expect(riddenAfter).toBeGreaterThanOrEqual(riddenBefore);
    expect(riddenAfter - riddenBefore).toBeLessThan(0.2); // km: no 500 m step

    // Keyboard: focus the profile, move the cursor, Enter asks, Escape cancels.
    await pick.focus();
    await main.keyboard.press('ArrowRight');
    await expect(pick).toHaveAttribute('aria-valuetext', /^km 0\.\d · /);
    await main.keyboard.press('Enter');
    await expect(confirm).toBeVisible();
    await main.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(gpxDir, { recursive: true, force: true });
  }
});
