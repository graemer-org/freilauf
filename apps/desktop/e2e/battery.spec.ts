import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { atStart, launch, windows } from './helpers';

/** Battery levels of the simulated devices: top bar, Devices screen, the ride start notice. */
test('battery levels in sim mode: icons, colours, details and the low-battery notice', async () => {
  test.setTimeout(90_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-battery-'));
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await atStart(main);

    // Start screen chips: HR 64 %, controllers' weaker grip 12 % (orange), no trainer battery.
    const chips = main.getByTestId('start-devices');
    await expect(chips.getByTestId('battery-heartRate')).toHaveAttribute('data-percent', '64');
    await expect(chips.getByTestId('battery-heartRate')).toHaveAttribute('data-tone', 'normal');
    await expect(chips.getByTestId('battery-controller')).toHaveAttribute('data-percent', '12');
    await expect(chips.getByTestId('battery-controller')).toHaveAttribute('data-tone', 'low');
    await expect(chips.getByTestId('battery-trainer')).toHaveCount(0);

    // Devices screen: both grips separately.
    await main.getByTestId('start-devices').click();
    await expect(main.getByTestId('battery-detail-heartRate-whole')).toContainText('64');
    await expect(main.getByTestId('battery-detail-controller-left')).toContainText('Left 81');
    await expect(main.getByTestId('battery-detail-controller-right')).toContainText('Right 12');
    await expect(main.getByTestId('battery-detail-controller-right')).toHaveAttribute(
      'data-tone',
      'low',
    );
    await expect(main.getByTestId('battery-detail-trainer')).toHaveCount(0);
    await main.getByTestId('screen-back').click();

    // Ride view top bar; the simulation panel changes the levels (red below 10 %).
    await main.getByTestId('start-open-ride').click();
    await expect(main.getByTestId('panel-ride')).toBeVisible();
    const top = main.getByTestId('ride-open-devices');
    await expect(top.getByTestId('battery-heartRate')).toContainText('64');
    await expect(top.getByTestId('battery-controller')).toContainText('R12');
    await expect(top.getByTestId('battery-controller')).toHaveAttribute(
      'title',
      'Controller battery: left 81\u00a0%, right 12\u00a0%',
    );
    await main.getByTestId('sim-battery-heartRate').fill('7');
    await expect(top.getByTestId('battery-heartRate')).toHaveAttribute('data-tone', 'critical');
    await main.getByTestId('sim-battery-trainer').fill('55');
    await expect(top.getByTestId('battery-trainer')).toHaveAttribute('data-percent', '55');
    await main.getByTestId('sim-battery-trainer').fill('');
    await expect(top.getByTestId('battery-trainer')).toHaveCount(0);

    // Starting the ride: one notice names every device below 15 %.
    await main.getByTestId('ride-start').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding', {
      timeout: 15_000,
    });
    const notice = main.getByTestId('notice-warn');
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText('Low battery: heart rate sensor 7');
    await expect(notice).toContainText('right controller 12');

    // A dropped controller keeps its last level while reconnecting.
    await main.getByTestId('sim-drop-controller').click();
    await expect(main.getByTestId('dot-controller')).toHaveAttribute('data-state', 'reconnecting');
    await expect(top.getByTestId('battery-controller')).toHaveAttribute('data-percent', '12');
    await expect(main.getByTestId('dot-controller')).toHaveAttribute('data-state', 'connected', {
      timeout: 10_000,
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
