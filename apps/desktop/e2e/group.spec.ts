import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appDir, launch, NO_RELAYS_SWITCH, windows } from './helpers';

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
 * The default path (public relays) from a fresh install, up to where the network is needed:
 * Create shows an invite with a secret at once, pasted invites are parsed and checked, and with
 * every relay unreachable (forced by a host-resolver rule, so this does not depend on the
 * network the tests run on) the plain "No relay server reachable" message appears instead of a
 * hang. Two riders over real public relays cannot be tested here (docs/group-rides.md).
 */
test('group tab: zero-setup create and join, relays unreachable → plain message', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freilauf-e2e-relays-'));
  const app = await launch(userData, [NO_RELAYS_SWITCH]);
  try {
    const { main } = await windows(app);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));

    await main.getByTestId('tab-group').click();
    // Fresh install: Create right away, nothing to set up; the own server is tucked away.
    await expect(main.getByTestId('group-start')).toBeVisible();
    await expect(main.getByTestId('group-create')).toBeVisible();
    await expect(main.getByTestId('group-how')).toContainText('public relay servers');
    await expect(main.getByTestId('group-how')).toContainText('encrypted handshake');
    await expect(main.getByTestId('group-advanced')).not.toHaveAttribute('open', '');

    // A bare six-character code lacks the secret: explained before any connection attempt.
    await main.getByTestId('group-join-input').fill('ABC-DEF');
    await main.getByTestId('group-join').click();
    await expect(main.getByTestId('group-error')).toHaveAttribute('data-failure', 'secret-missing');
    await expect(main.getByTestId('group-error')).toContainText('whole invite link');
    await main.getByTestId('group-back').click();

    // Create: the invite (link with secret, and the full code) is shown at once.
    const started = Date.now();
    await main.getByTestId('group-create').click();
    const link = main.getByTestId('group-link');
    await expect(link).toHaveText(/^freilauf:\/\/join\/[A-HJKMNP-Z2-9]{6}#[A-HJKMNP-Z2-9]{12}$/, {
      timeout: 15_000,
    });
    const invite = (await link.textContent())!;
    await expect(main.getByTestId('group-code')).toHaveText(
      /^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/,
    );
    const code = (await main.getByTestId('group-code').textContent())!;
    expect(code.replace(/-/g, '')).toBe(invite.slice('freilauf://join/'.length).replace('#', ''));

    // No relay can be reached: a plain message, within the relay timeout, never a raw error.
    const error = main.getByTestId('group-error');
    await expect(error).toHaveAttribute('data-failure', 'no-relay', { timeout: 30_000 });
    expect(Date.now() - started).toBeLessThan(25_000);
    await expect(error).toContainText('No relay server reachable');
    await expect(error).toContainText('public relay servers run by others');
    await expect(error).not.toContainText(/relay-failed|GroupError|Trystero|wss:\/\//);
    await main.getByTestId('group-back').click();

    // A typo in the invite is caught locally.
    const last = invite.at(-1)!;
    const typo = invite.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    await main.getByTestId('group-join-input').fill(typo);
    await main.getByTestId('group-join').click();
    await expect(main.getByTestId('group-error')).toHaveAttribute('data-failure', 'invite-typo');
    await main.getByTestId('group-back').click();

    // Joining with the real invite (inside a message) parses, then meets the same wall.
    await main.getByTestId('group-join-input').fill(`Ride with me tonight: ${invite} see you`);
    await main.getByTestId('group-join').click();
    await expect(main.getByTestId('group-error')).toHaveAttribute('data-failure', 'no-relay', {
      timeout: 30_000,
    });
    // The input is kept for another try.
    await expect(main.getByTestId('group-join-input')).toHaveValue(
      `Ride with me tonight: ${invite} see you`,
    );

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

/**
 * The advanced fallback, "Use my own signalling server", against a real signalling server:
 * inline validation, Test connection, Use this server, Create with an old-style invite, and the
 * plain failure when the server is gone.
 */
test('group tab: own signalling server (advanced): test it, host a ride, plain failures', async () => {
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
    await main.getByTestId('group-advanced').locator(':scope > summary').click();

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

    // "Use this server" switches rides to it.
    await main.getByTestId('group-server-save').click();
    await expect(main.getByTestId('group-own-server-toggle')).toBeChecked();
    await expect(main.getByTestId('group-own-server-note')).toContainText(`127.0.0.1:${port}`);
    await expect(main.getByTestId('group-local-note')).toBeVisible();
    await expect(main.getByTestId('group-server')).toContainText(`ws://127.0.0.1:${port}`);

    // Host a ride: the old-style invite link carries the server.
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
    await expect(main.getByTestId('settings-own-server')).toBeChecked();
    const field = main.getByTestId('settings-signalling');
    await field.fill(`ws://127.0.0.1:${closedPort}`);
    await field.press('Enter');
    await main.getByTestId('tab-group').click();
    await main.getByTestId('group-create').click();
    const error = main.getByTestId('group-error');
    await expect(error).toHaveAttribute('data-failure', 'unreachable', { timeout: 30_000 });
    await expect(error).toContainText('Your signalling server is not reachable');
    await expect(error).toContainText(`Nothing answered at 127.0.0.1:${closedPort}`);
    await expect(error).not.toContainText(/localhost|SignallingError|join-timeout/);

    // Switching the option off brings back the zero-setup default.
    await main.getByTestId('group-back').click();
    await main.getByTestId('group-own-server-toggle').uncheck();
    await expect(main.getByTestId('group-own-server-note')).toHaveCount(0);

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    signalling.kill('SIGTERM');
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
