import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { atStart, finishRide, launch, windows } from './helpers';

const num = (v: string | null): number => Number(v ?? Number.NaN);

/** Simulation mode only: shorter pick-up spacing and challenge windows (POWER_UP_TUNING_KEY). */
async function tune(main: Page, tuning: unknown): Promise<void> {
  await main.evaluate((t) => {
    localStorage.setItem('freilauf.powerUps.tuning', JSON.stringify(t));
  }, tuning);
}

/** Power-ups on a built-in route: a gate ahead, the pick-up, using it with P, the race gain. */
test('power-ups: pick one up on a route, use it with P, the race gain shows apart', async () => {
  test.setTimeout(150_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-powerups-'));
  const app = await launch(userData);
  try {
    const { main, overlay } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await atStart(main);
    await tune(main, { spacingM: [50, 70] });

    // A built-in route through the start screen's picker.
    await main.getByTestId('ride-kind-route').click();
    const row = main.getByTestId('route-row').filter({ hasText: 'Rolling loop' });
    await row.getByTestId('route-select').click();
    await row.getByTestId('route-go-ride').click();
    await main.getByTestId('start-open-ride').click();
    const scene = main.getByTestId('ride-scene');
    await expect(scene).toHaveAttribute('data-view', 'road');

    await main.getByTestId('sim-effort').fill('320');
    await main.getByTestId('ride-start').click();
    // A gate shows ahead, then the rider rides through it.
    await expect
      .poll(async () => num(await scene.getAttribute('data-gate-ahead')), { timeout: 20_000 })
      .toBeGreaterThan(0);
    const card = main.getByTestId('powerup-card');
    await expect(card).toBeVisible({ timeout: 40_000 });
    await expect(main.getByTestId('powerup-hint')).toHaveText('Press the side button or P');
    // The spots and their kinds follow from the route id: everyone on this route meets the same.
    // On "Rolling loop" the first is Light load, the second Tailwind.
    await expect(card).toHaveAttribute('data-kind', 'lightLoad');
    // The overlay shows it compactly.
    await expect(overlay.getByTestId('overlay-powerup-held')).toBeVisible();

    // Use it with the key: the scene shows the effect.
    await main.getByTestId('stat-power').click(); // focus off the slider
    await main.keyboard.press('p');
    const effect = main.getByTestId('powerup-effect');
    await expect(effect).toBeVisible();
    await expect(effect).toHaveAttribute('data-kind', 'lightLoad');
    await expect(scene).toHaveAttribute('data-effect', 'lightLoad', { timeout: 5_000 });

    // The next gate gives Tailwind; once Light load has run out, use that one too.
    await expect(card).toHaveAttribute('data-kind', 'tailwind', { timeout: 60_000 });
    await expect(main.getByTestId('powerup-hint')).toHaveText('Press the side button or P', {
      timeout: 40_000,
    });
    const recorded0 = num(
      (await main.getByTestId('stat-distance').locator('.tile-number').textContent()) ?? '',
    );
    await main.keyboard.press('p');
    await expect(scene).toHaveAttribute('data-effect', 'tailwind', { timeout: 5_000 });
    // The race gain grows; the recorded distance keeps counting on its own.
    const gain = main.getByTestId('powerup-gain');
    await expect(gain).toContainText(/\+\d+ m from power-ups/, { timeout: 20_000 });
    const gainOf = async (): Promise<number> =>
      num(/\+(\d+) m/.exec((await gain.textContent()) ?? '')?.[1] ?? null);
    const g1 = await gainOf();
    await expect.poll(gainOf, { timeout: 15_000 }).toBeGreaterThan(g1);
    await expect
      .poll(
        async () =>
          num(
            (await main.getByTestId('stat-distance').locator('.tile-number').textContent()) ?? '',
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(recorded0);
    await expect(overlay.getByTestId('overlay-powerup-effect')).toContainText('Tailwind');

    // Finish: the summary keeps the gain on its own line; the saved ride is physics only.
    await finishRide(main);
    const gainText = await main
      .getByTestId('summary-powerups')
      .textContent({ timeout: 2_000 })
      .catch(() => null);
    const rides = await main.evaluate(() => window.freilauf.rides.list());
    expect(rides).toHaveLength(1);
    const summaryKm = num(
      (await main.getByTestId('summary-distance').locator('.tile-number').textContent()) ?? '',
    );
    expect(Math.abs(summaryKm * 1000 - rides[0]!.distanceM)).toBeLessThan(10);
    expect(gainText).toMatch(/\+\d+ m from power-ups/);
    const saved = await main.evaluate((id) => window.freilauf.rides.load(id), rides[0]!.id);
    expect(JSON.stringify(saved)).not.toMatch(/power-?up|race/i);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

/** The effort challenge: offered when the simulated rider eases off, granted when met. */
test('power-ups: an effort challenge appears when the effort drops and grants one when met', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-challenge-'));
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    await atStart(main);
    await tune(main, {
      spacingM: [90_000, 100_000],
      challenge: { notBeforeS: 15, recentS: 5, baselineS: 8, holdS: 5, offerS: 40 },
    });
    await main.getByTestId('start-open-ride').click();
    await expect(main.getByTestId('panel-ride')).toBeVisible();
    await main.getByTestId('sim-effort').fill('300');
    await main.getByTestId('ride-start').click();
    await expect(main.getByTestId('ride-state')).toHaveAttribute('data-state', 'riding');
    // 20 s at 300 W, then the simulated rider eases off.
    await main.waitForTimeout(20_000);
    await main.getByTestId('sim-effort').fill('150');
    const challenge = main.getByTestId('powerup-challenge');
    await expect(challenge).toBeVisible({ timeout: 30_000 });
    await expect(challenge).toContainText(/Hold \d+ W for 5 s/);
    const target = Number(/Hold (\d+) W/.exec((await challenge.textContent()) ?? '')![1]);
    expect(target).toBeGreaterThan(150);
    // Meet it.
    await main.getByTestId('sim-effort').fill(String(Math.ceil((target + 40) / 10) * 10));
    await expect(challenge).toHaveAttribute('data-phase', 'holding', { timeout: 15_000 });
    await expect(main.getByTestId('powerup-card')).toBeVisible({ timeout: 20_000 });
    await expect(challenge).toBeHidden();
    await finishRide(main);
  } finally {
    await app.close();
  }
});
