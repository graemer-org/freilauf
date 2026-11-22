import { defineConfig } from '@playwright/test';

// Electron smoke tests against the built app (out/main/index.js); run
// `electron-vite build` first (the `test:e2e` script does). On Linux CI run
// under `xvfb-run -a`.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { trace: 'off' },
});
