import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, windows } from './helpers';

/**
 * Community totals are fed by finished rides. There is no Community UI yet, so this reads the
 * persisted community state through the page (localStorage key `freilauf.community.v1`).
 */
test('a finished sim ride counts towards this week with points', async () => {
  test.setTimeout(90_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-community-'));
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    main.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await expect(main.getByTestId('stat-power')).toContainText(/[1-9]\d+/, { timeout: 15_000 });
    // Hard effort (IF capped at 1.3 with the default FTP of 200 W): ~2 points in 25 s.
    await main.getByTestId('sim-effort').fill('400');
    await main.getByTestId('ride-start').click();
    await expect(main.getByTestId('stat-time')).toContainText(/0:2[5-9]/, { timeout: 40_000 });
    await main.getByTestId('ride-finish').click();
    await main.getByTestId('ride-finish-confirm').click();
    await expect(main.getByTestId('ride-start')).toBeVisible();

    const thisWeek = () =>
      main.evaluate(() => {
        const raw = localStorage.getItem('freilauf.community.v1');
        if (!raw) return null;
        const state = JSON.parse(raw) as {
          ledger: { rides: Record<string, { weekKey: string; points: number }> };
        };
        const now = new Date();
        // ISO week of today, local time (same rule as @freilauf/community).
        const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        const day = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - day);
        const year = d.getUTCFullYear();
        const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
        const key = `${year}-W${String(week).padStart(2, '0')}`;
        const rides = Object.values(state.ledger.rides).filter((f) => f.weekKey === key);
        return { rides: rides.length, points: rides.reduce((a, f) => a + f.points, 0) };
      });
    // Saved with a short debounce.
    await expect.poll(thisWeek, { timeout: 15_000 }).toMatchObject({ rides: 1 });
    expect((await thisWeek())?.points).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
