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

/** A fresh simulated install with a name and short card spacing (simulation mode only). */
async function rider(
  name: string,
  cardPool: string[],
): Promise<{ app: ElectronApplication; main: Page; dir: string; errors: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `freilauf-e2e-cards-${name}-`));
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
      JSON.stringify({ spacingM: [30, 40], cardPool: pool }),
    );
  }, cardPool);
  return { app, main, dir, errors };
}

/**
 * The Card Race between two app instances over a local signalling server (each in simulation
 * mode, with its own user data): Anna creates a Card Race, Ben joins with the invite and is
 * ahead; Anna plays Headwind with P; it lands on Ben's screen and Ben's race position drops.
 */
test('Card Race: two apps, a Headwind played with P lands on the rider ahead', async () => {
  test.setTimeout(180_000);
  const port = await freePort();
  const signalling = await startSignalling(port);
  const anna = await rider('Anna', ['headwind']);
  const ben = await rider('Ben', ['shield']);
  try {
    // Anna: her own server, the Card Race, create.
    const a = anna.main;
    await a.getByTestId('with-group').click();
    await a.getByTestId('group-advanced').locator(':scope > summary').click();
    await a.getByTestId('group-server-input').fill(`ws://127.0.0.1:${port}`);
    await a.getByTestId('group-server-save').click();
    await a.getByTestId('group-mode-create-cardRace').click();
    await expect(a.getByTestId('group-mode-blurb')).toContainText('two cards');
    await a.getByTestId('group-create').click();
    await expect(a.getByTestId('group-code')).toHaveText(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/, {
      timeout: 15_000,
    });
    await expect(a.getByTestId('group-mode')).toHaveAttribute('data-mode', 'cardRace');
    await expect(a.getByTestId('group-mode-switch-cardRace')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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
    await expect(b.getByTestId('group-mode-badge')).toHaveAttribute('data-mode', 'cardRace', {
      timeout: 10_000,
    });
    await expect(b.getByTestId('group-mode')).toContainText('Chosen by the host');

    // Ben rides first and harder: he is ahead.
    await b.getByTestId('start-open-ride').click();
    await b.getByTestId('sim-effort').fill('320');
    await b.getByTestId('ride-start').click();
    await b.waitForTimeout(6_000);
    await a.getByTestId('start-open-ride').click();
    await a.getByTestId('sim-effort').fill('200');
    await a.getByTestId('ride-start').click();

    // Anna's left card: a Headwind aimed at Ben, ready.
    const left = a.getByTestId('card-left');
    await expect(left).toHaveAttribute('data-kind', 'headwind', { timeout: 40_000 });
    await expect(left).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
    await expect(a.getByTestId('card-left-hint')).toContainText('→ Ben');
    await a.getByTestId('stat-power').click(); // focus off the slider
    await a.keyboard.press('p');

    // Ben's screen: the notice, the effect, the scene; his race position drops.
    await expect(b.getByTestId('card-notice')).toContainText('Anna played Headwind on you', {
      timeout: 10_000,
    });
    await expect(b.getByTestId('card-hand')).toHaveAttribute('data-attack', 'headwind');
    await expect(b.getByTestId('card-attack')).toContainText('from Anna');
    await expect(b.getByTestId('ride-scene')).toHaveAttribute('data-cards', /headwind/, {
      timeout: 5_000,
    });
    await expect(a.getByTestId('card-notice')).toContainText('Headwind hit Ben', {
      timeout: 10_000,
    });
    await expect(b.getByTestId('card-race-line')).toContainText('from attacks', {
      timeout: 20_000,
    });
    // Then protection.
    await expect(b.getByTestId('card-protection')).toBeVisible({ timeout: 15_000 });

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
