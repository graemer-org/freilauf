import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, windows } from './helpers';

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
