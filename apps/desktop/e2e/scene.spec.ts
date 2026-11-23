import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { atStart, launch, openRideView, windows } from './helpers';

const num = (v: string | null): number => Number(v ?? Number.NaN);

/** The ride scene animates with the ride, follows the gradient and steers with A/D. */
test('ride scene: animates, tilts with the gradient, steers with the keyboard', async () => {
  test.setTimeout(90_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-scene-'));
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    // The ride view before the start (opened without recording).
    await atStart(main);
    await openRideView(main);
    const scene = main.getByTestId('ride-scene');
    await expect(scene).toBeVisible();
    await expect(main.getByTestId('ride-profile')).toBeVisible();
    await expect(scene).toHaveAttribute('role', 'img');
    await expect(scene).toHaveAttribute('aria-label', /percent|Flat road/);
    await expect(main.getByTestId('stat-power')).toContainText(/[1-9]\d+/, { timeout: 15_000 });

    // The loop draws frames; the scene odometer stands still before the start.
    await expect.poll(async () => num(await scene.getAttribute('data-frames'))).toBeGreaterThan(5);
    expect(num(await scene.getAttribute('data-distance'))).toBe(0);

    await main.getByTestId('ride-start').click();
    await expect(scene).toHaveAttribute('data-state', 'riding');
    await expect
      .poll(async () => num(await scene.getAttribute('data-distance')), { timeout: 15_000 })
      .toBeGreaterThan(2);
    const frames = num(await scene.getAttribute('data-frames'));
    await expect
      .poll(async () => num(await scene.getAttribute('data-frames')))
      .toBeGreaterThan(frames);

    // Raising the gradient tilts the road.
    const grade = num(await scene.getAttribute('data-grade'));
    await main.getByTestId('gradient-up').click();
    await main.getByTestId('gradient-up').click();
    await expect
      .poll(async () => num(await scene.getAttribute('data-grade')))
      .toBeCloseTo(grade + 1, 5);

    // Holding D steers towards the near edge, holding A back across.
    await main.getByTestId('stat-power').click(); // focus off the buttons
    expect(num(await scene.getAttribute('data-lateral'))).toBe(0);
    await main.keyboard.down('d');
    await expect
      .poll(async () => num(await scene.getAttribute('data-lateral')), { timeout: 5_000 })
      .toBeGreaterThan(0.3);
    await main.keyboard.up('d');
    const right = num(await scene.getAttribute('data-lateral'));
    await main.keyboard.down('a');
    await expect
      .poll(async () => num(await scene.getAttribute('data-lateral')), { timeout: 5_000 })
      .toBeLessThan(right - 0.3);
    await main.keyboard.up('a');

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

/** Brake key and simulated levers: braking slows the bike, the lever display follows. */
test('levers and brake: S brakes harder than coasting, the lever display follows the levers', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-levers-'));
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    const scene = main.getByTestId('ride-scene');
    const speed = async (): Promise<number> =>
      Number(await main.getByTestId('stat-speed').locator('.tile-number').textContent());
    await atStart(main);
    await openRideView(main);
    await main.getByTestId('sim-effort').fill('400');
    await main.getByTestId('ride-start').click();
    await expect.poll(speed, { timeout: 40_000 }).toBeGreaterThan(30);

    // Coasting (no power) for 1.5 s loses little speed.
    await main.getByTestId('sim-effort').fill('0');
    await main.waitForTimeout(2000); // the simulated trainer settles at no power
    const coastFrom = await speed();
    await main.waitForTimeout(1500);
    const coastDrop = coastFrom - (await speed());

    // Holding S for 1.5 s brakes hard; the scene shows the brake cue.
    await main.getByTestId('stat-power').click(); // focus off the slider
    const brakeFrom = await speed();
    await expect(main.getByTestId('scene-brake')).toBeHidden();
    await main.keyboard.down('s');
    await expect(main.getByTestId('scene-brake')).toBeVisible();
    await expect(main.getByTestId('scene-brake')).toHaveText('Brake 100 %');
    await expect(scene).toHaveAttribute('data-braking', '1.00');
    await main.waitForTimeout(1500);
    const brakeDrop = brakeFrom - (await speed());
    await main.keyboard.up('s');
    await expect(main.getByTestId('scene-brake')).toBeHidden();
    expect(brakeDrop).toBeGreaterThan(10);
    expect(brakeDrop).toBeGreaterThan(coastDrop * 4);

    // A simulated right lever at +60 % steers right (default assignment).
    await main.getByTestId('sim-effort').fill('300');
    await main.getByTestId('stat-power').click();
    const lateral = Number(await scene.getAttribute('data-lateral'));
    await main.getByTestId('sim-lever-right').fill('60');
    await expect
      .poll(async () => Number(await scene.getAttribute('data-lateral')), { timeout: 10_000 })
      .toBeGreaterThan(lateral + 0.2);
    // The left lever pushed + brakes.
    await main.getByTestId('sim-lever-left').fill('100');
    await expect(main.getByTestId('scene-brake')).toBeVisible();
    await main.getByTestId('sim-lever-left').fill('0');
    await expect(main.getByTestId('scene-brake')).toBeHidden();

    // Devices (from the ride's device panel): the live lever display shows the raw value and
    // what the app makes of it. The ride keeps recording meanwhile.
    await main.getByTestId('ride-open-devices').click();
    await expect(main.getByTestId('ride-sheet-devices')).toBeVisible();
    await expect(main.getByTestId('sheet-device-controller')).toHaveAttribute(
      'data-state',
      'connected',
    );
    await main.getByTestId('ride-devices-manage').click();
    await expect(main.getByTestId('panel-devices')).toBeVisible();
    await expect(main.getByTestId('devices-controllers')).toBeVisible();
    await expect(main.getByTestId('ride-return-bar')).toHaveAttribute('data-state', 'riding');
    const right = main.getByTestId('lever-right');
    await right.scrollIntoViewIfNeeded();
    await expect(main.getByTestId('lever-right-value')).toHaveText('+60 %');
    await expect(right).toHaveAttribute('data-value', '60');
    await expect(main.getByTestId('lever-right-result')).toHaveText('Steering: 58 % right');
    await expect(main.getByTestId('lever-left-result')).toHaveText('At rest');
    await main.getByTestId('lever-right-swap').click();
    await expect(main.getByTestId('lever-right-result')).toHaveText('Brake: 58 %');
    await expect(main.getByTestId('lever-right-positive')).toHaveValue('brake');
    await main.getByTestId('lever-left-negative').selectOption('none');
    await expect(main.getByTestId('lever-reset')).toBeEnabled();
    await main.getByTestId('lever-reset').click();
    await expect(main.getByTestId('lever-right-result')).toHaveText('Steering: 58 % right');
    await expect(main.getByTestId('lever-left-negative')).toHaveValue('steerLeft');
    await expect(main.getByTestId('lever-reset')).toBeDisabled();

    // The dead zone is tucked under Advanced, right there.
    await expect(main.getByTestId('lever-advanced')).not.toHaveAttribute('open', '');
    await main.getByTestId('lever-advanced').locator(':scope > summary').click();
    await expect(main.getByTestId('lever-deadzone')).toBeVisible();

    // Back to the ride; dropping the controller returns the levers to rest.
    await main.getByTestId('screen-back').click();
    await expect(main.getByTestId('panel-ride')).toBeVisible();
    await main.getByTestId('sim-drop-controller').click();
    await main.getByTestId('ride-leave').click();
    await main.getByTestId('start-devices').click();
    await expect(main.getByTestId('lever-right-value')).toHaveText('0 %');

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
