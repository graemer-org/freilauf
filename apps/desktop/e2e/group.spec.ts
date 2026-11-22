import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appDir, launch, windows } from './helpers';

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

/**
 * The Group tab from a fresh install: the setup state, the host path against a real signalling
 * server (Test connection, Use this server, Create), and the plain failure messages.
 */
test('group tab: set up a server, test it, host a ride, and plain failures', async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  const closedPort = await freePort();
  const signalling = await startSignalling(port);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-group-'));
  const app = await launch(userData);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));

    await main.getByTestId('tab-group').click();
    // Fresh install: no server, so no Create button that is bound to fail.
    await expect(main.getByTestId('group-setup')).toBeVisible();
    await expect(main.getByTestId('group-create')).toHaveCount(0);
    await expect(main.getByTestId('group-path-join')).toContainText('A friend invited me');
    await expect(main.getByTestId('group-path-host')).toContainText('I want to host');

    // A bare code cannot work without a server: explained before any connection attempt.
    await main.getByTestId('group-join-input').fill('ABC-DEF');
    await main.getByTestId('group-join').click();
    await expect(main.getByTestId('group-error')).toHaveAttribute('data-failure', 'no-server');
    await expect(main.getByTestId('group-error')).toContainText('invite link');
    await main.getByTestId('group-back').click();

    // Inline validation.
    const input = main.getByTestId('group-server-input');
    await input.fill(`127.0.0.1:${port}`);
    await input.blur();
    await expect(main.getByTestId('group-server-form')).toContainText(
      'Start the address with wss://',
    );
    await expect(main.getByTestId('group-server-test')).toBeDisabled();

    // Nothing listening there: not reachable.
    await input.fill(`ws://127.0.0.1:${closedPort}`);
    await main.getByTestId('group-server-test').click();
    const result = main.getByTestId('group-server-test-result');
    await expect(result).toHaveAttribute('data-result', 'error', { timeout: 15_000 });
    await expect(result).toContainText('Not reachable');

    // The real server: reachable.
    await input.fill(`ws://127.0.0.1:${port}`);
    await main.getByTestId('group-server-test').click();
    await expect(result).toHaveAttribute('data-result', 'ok', { timeout: 15_000 });
    await expect(result).toContainText('Reachable');

    await main.getByTestId('group-server-save').click();
    await expect(main.getByTestId('group-create')).toBeVisible();
    await expect(main.getByTestId('group-local-note')).toBeVisible();
    await expect(main.getByTestId('group-server')).toContainText(`ws://127.0.0.1:${port}`);

    // Host a ride: the invite link carries the server.
    await main.getByTestId('group-create').click();
    await expect(main.getByTestId('group-code')).toHaveText(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/, {
      timeout: 15_000,
    });
    const link = await main.getByTestId('group-link').textContent();
    expect(link).toMatch(/^freilauf:\/\/join\/[A-Z0-9]{6}\?s=/);
    expect(decodeURIComponent(link!.split('?s=')[1]!)).toBe(`ws://127.0.0.1:${port}`);
    await expect(main.getByTestId('group-link').locator('..')).toContainText(
      'Friends only need this link.',
    );
    await expect(main.getByTestId('group-empty')).toContainText('Waiting for friends');
    await main.getByTestId('group-leave').click();

    // A server that went away: a plain message, never a raw error.
    await main.getByTestId('tab-settings').click();
    const field = main.getByTestId('settings-signalling');
    await field.fill(`ws://127.0.0.1:${closedPort}`);
    await field.press('Enter');
    await main.getByTestId('tab-group').click();
    await main.getByTestId('group-create').click();
    const error = main.getByTestId('group-error');
    await expect(error).toHaveAttribute('data-failure', 'unreachable', { timeout: 30_000 });
    await expect(error).toContainText('Server not reachable');
    await expect(error).toContainText(`Nothing answered at 127.0.0.1:${closedPort}`);
    await expect(error).not.toContainText(/localhost|SignallingError|join-timeout/);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    signalling.kill('SIGTERM');
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
