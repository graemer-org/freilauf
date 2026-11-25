import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { appDir, atStart, launch, windows } from './helpers';

const signallingMain = path.resolve(appDir, '../signalling/src/main.ts');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startSignalling(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [signallingMain], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`signalling exited with ${code}`)));
    child.stdout?.on('data', (d: Buffer) => {
      if (String(d).includes('listening')) resolve();
    });
  });
  return child;
}

/** A fresh simulated install with a name and short feed bag spacing (simulation mode only). */
async function rider(
  name: string,
  itemPool: string[],
): Promise<{ app: ElectronApplication; main: Page; dir: string; errors: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `freilauf-e2e-rumble-${name}-`));
  const app = await launch(dir);
  const { main } = await windows(app);
  const errors: string[] = [];
  main.on('pageerror', (e) => errors.push(e.message));
  await expect(main.getByTestId('first-run')).toBeVisible({ timeout: 20_000 });
  await main.getByTestId('first-run-name').fill(name);
  await main.getByTestId('first-run-save').click();
  await atStart(main);
  await main.evaluate((pool) => {
    localStorage.setItem(
      'freilauf.powerUps.tuning',
      JSON.stringify({ spacingM: [30, 40], itemPool: pool }),
    );
  }, itemPool);
  return { app, main, dir, errors };
}

/**
 * Freilauf Rumble between two app instances over a local signalling server (each in simulation
 * mode, with its own user data): Anna creates a Rumble, Ben joins with the invite and rides
 * ahead. Anna throws a water bottle at Ben with P; it lands on Ben's screen and his race
 * position drops. Then Ben drops a mud puddle behind him with P, and Anna — behind him — rides
 * through it: it lands on her screen, once.
 */
test('Freilauf Rumble: two apps, a bottle thrown at the rider ahead, a puddle ridden through', async () => {
  test.setTimeout(240_000);
  const port = await freePort();
  const signalling = await startSignalling(port);
  const anna = await rider('Anna', ['bottle']);
  const ben = await rider('Ben', ['puddle']);
  try {
    // Anna: her own server, Freilauf Rumble, create.
    const a = anna.main;
    await a.getByTestId('with-group').click();
    await a.getByTestId('group-advanced').locator(':scope > summary').click();
    await a.getByTestId('group-server-input').fill(`ws://127.0.0.1:${port}`);
    await a.getByTestId('group-server-save').click();
    await expect(a.getByTestId('group-mode-create-normal')).toHaveText('Normal');
    await a.getByTestId('group-mode-create-rumble').click();
    await expect(a.getByTestId('group-mode-create-rumble')).toHaveText('Freilauf Rumble');
    await expect(a.getByTestId('group-mode-blurb')).toContainText('feed bags');
    await a.getByTestId('group-create').click();
    await expect(a.getByTestId('group-code')).toHaveText(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/, {
      timeout: 15_000,
    });
    await expect(a.getByTestId('group-mode')).toHaveAttribute('data-mode', 'rumble');
    await expect(a.getByTestId('group-mode-switch-rumble')).toHaveAttribute('aria-pressed', 'true');
    const link = (await a.getByTestId('group-link').textContent())!;

    // Ben joins with the link (it carries the server).
    const b = ben.main;
    await b.getByTestId('with-group').click();
    await b.getByTestId('group-join-input').fill(link);
    await b.getByTestId('group-join').click();
    await expect(b.getByTestId('group-peer')).toHaveAttribute('data-state', 'connected', {
      timeout: 30_000,
    });
    // Everyone sees the mode, from the host.
    await expect(b.getByTestId('group-mode-badge')).toHaveAttribute('data-mode', 'rumble', {
      timeout: 10_000,
    });
    await expect(b.getByTestId('group-mode-badge')).toContainText('Freilauf Rumble');
    await expect(b.getByTestId('group-mode')).toContainText('Chosen by the host');

    // Ben rides first and harder: he is ahead.
    await b.getByTestId('start-open-ride').click();
    await b.getByTestId('sim-effort').fill('320');
    await b.getByTestId('ride-start').click();
    await b.waitForTimeout(6_000);
    await a.getByTestId('start-open-ride').click();
    await a.getByTestId('sim-effort').fill('200');
    await a.getByTestId('ride-start').click();

    // 1) Anna's left slot: a water bottle aimed at Ben, ready. P throws it.
    const left = a.getByTestId('item-left');
    await expect(left).toHaveAttribute('data-kind', 'bottle', { timeout: 40_000 });
    await expect(left).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
    await expect(a.getByTestId('item-left-hint')).toContainText('→ Ben');
    await a.getByTestId('stat-power').click(); // focus off the slider
    await a.keyboard.press('p');
    await expect(a.getByTestId('ride-scene')).toHaveAttribute('data-flying', 'throw:bottle', {
      timeout: 2_000,
    });

    // Ben's screen: the notice, the effect, the scene; his race position drops.
    await expect(b.getByTestId('rumble-notice')).toContainText('Anna got you with a water bottle', {
      timeout: 10_000,
    });
    await expect(b.getByTestId('item-slots')).toHaveAttribute('data-hit', 'bottle');
    await expect(b.getByTestId('rumble-hit')).toContainText('from Anna');
    await expect(b.getByTestId('ride-scene')).toHaveAttribute('data-rumble', /bottle/, {
      timeout: 5_000,
    });
    await expect(a.getByTestId('rumble-notice')).toContainText('Your water bottle got Ben', {
      timeout: 10_000,
    });
    await expect(b.getByTestId('rumble-race-line')).toContainText('from hits', {
      timeout: 20_000,
    });
    // Then protection.
    await expect(b.getByTestId('rumble-protection')).toBeVisible({ timeout: 15_000 });

    // 2) Ben drops a mud puddle behind him (his left slot, P); Anna rides into it.
    const benLeft = b.getByTestId('item-left');
    await expect(benLeft).toHaveAttribute('data-kind', 'puddle', { timeout: 30_000 });
    await expect(benLeft).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });
    // Anna catches up a little faster from here, so she reaches the puddle well within its life.
    await a.getByTestId('sim-effort').fill('360');
    await b.getByTestId('stat-power').click();
    await b.keyboard.press('p');
    await expect(b.getByTestId('rumble-notice')).toContainText('Mud puddle dropped behind you', {
      timeout: 5_000,
    });
    // Anna sees it on the road ahead of her, then rides through it.
    await expect(a.getByTestId('ride-scene')).toHaveAttribute('data-puddle-ahead', /\d+/, {
      timeout: 10_000,
    });
    await expect(a.getByTestId('rumble-notice')).toContainText(
      'You rode through Ben’s mud puddle',
      {
        timeout: 45_000,
      },
    );
    await expect(a.getByTestId('item-slots')).toHaveAttribute('data-hit', 'puddle');
    await expect(b.getByTestId('rumble-notice')).toContainText(
      'Anna rode through your mud puddle',
      {
        timeout: 10_000,
      },
    );
    // Used up: it is gone from Anna's road.
    await expect(a.getByTestId('ride-scene')).toHaveAttribute('data-puddle-ahead', '', {
      timeout: 5_000,
    });

    expect(anna.errors).toEqual([]);
    expect(ben.errors).toEqual([]);
  } finally {
    await anna.app.close();
    await ben.app.close();
    signalling.kill('SIGTERM');
    fs.rmSync(anna.dir, { recursive: true, force: true });
    fs.rmSync(ben.dir, { recursive: true, force: true });
  }
});
