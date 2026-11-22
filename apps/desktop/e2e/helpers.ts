import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron, expect, test } from '@playwright/test';

export const appDir = path.resolve(import.meta.dirname, '..');
export const mainEntry = path.join(appDir, 'out', 'main', 'index.js');

export function electronArgs(): string[] {
  const args = [mainEntry];
  // Chromium refuses to start as root without --no-sandbox (containers, CI).
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.env.CI || (process.platform === 'linux' && isRoot)) args.push('--no-sandbox');
  return args;
}

/**
 * Chromium switch that makes every host name except 127.0.0.1 unresolvable: the public relay
 * servers are then unreachable, deterministically, whatever network the tests run on.
 */
export const NO_RELAYS_SWITCH = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';

export async function launch(
  userData: string,
  extraArgs: string[] = [],
): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: [...electronArgs(), ...extraArgs],
    cwd: appDir,
    env: { ...env, FREILAUF_USER_DATA: userData, FREILAUF_SIM: '1' },
  });
}

/** Waits for both windows and tells them apart via window.freilauf.window. */
export async function windows(app: ElectronApplication): Promise<{ main: Page; overlay: Page }> {
  await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(2);
  const found: Partial<Record<'main' | 'overlay', Page>> = {};
  for (const page of app.windows()) {
    await page.waitForLoadState('domcontentloaded');
    const name = await page.evaluate(() => window.freilauf.window);
    found[name] = page;
  }
  if (!found.main || !found.overlay) throw new Error('expected a main and an overlay window');
  return { main: found.main, overlay: found.overlay };
}
