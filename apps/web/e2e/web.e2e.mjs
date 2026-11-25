// End-to-end check of the production web build, driven in real (headless)
// Chromium: static server + /signal WebSocket on one port, a full simulated
// ride with .fit download, CSP/console cleanliness, the Bluetooth notice in an
// insecure context, the default (public relay) group flow up to where the
// network is needed — with every relay unreachable, forced by a host-resolver
// rule — and a two-rider group ride over the bundled signalling (the advanced
// "own signalling server" fallback).
//
// Uses the `playwright` package (not @playwright/test, which is only installed
// for apps/desktop). Run after building:
//   pnpm --filter @freilauf/web build
//   pnpm --filter @freilauf/web test:e2e          # or: node apps/web/e2e/web.e2e.mjs
// Against an already running server (e.g. the Docker container):
//   FREILAUF_URL=http://localhost:8080 node apps/web/e2e/web.e2e.mjs
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
let failed = false;

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

async function startServer() {
  if (process.env.FREILAUF_URL)
    return { base: process.env.FREILAUF_URL.replace(/\/$/, ''), stop() {} };
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(here, '../src/server/main.ts')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
    child.stdout.on('data', (d) => {
      process.stdout.write(`[server] ${d}`);
      if (String(d).includes('freilauf web on')) resolve();
    });
  });
  return { base: `http://127.0.0.1:${port}`, port, stop: () => child.kill('SIGTERM') };
}

/**
 * Collects console errors, page errors and CSP violations of a page.
 * One exception: Chromium builds without Web Bluetooth (e.g. Playwright's
 * headless Linux build) do not know the `bluetooth` Permissions-Policy
 * feature and warn about it; real Chrome/Edge with Web Bluetooth do not.
 */
async function watch(page, label) {
  const problems = [];
  const knownNoise = /Unrecognized feature: 'bluetooth'/;
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (knownNoise.test(m.text())) {
      page
        .evaluate(() => 'bluetooth' in navigator && !navigator.bluetooth.__freilaufStub)
        .then((has) => {
          if (has) problems.push(`${label} console: ${m.text()}`);
        })
        .catch(() => undefined);
      return;
    }
    if (
      m.type() === 'error' ||
      /Content Security Policy|Permissions-Policy|Unrecognized feature/i.test(m.text())
    ) {
      problems.push(`${label} console.${m.type()}: ${m.text()}`);
    }
  });
  return problems;
}

const text = (page, id) => page.getByTestId(id).first().innerText();

/** The start screen is up and the simulated trainer is connected. */
const trainerConnected = (page, timeout = 15_000) =>
  page.locator('[data-testid="chip-trainer"][data-state="connected"]').waitFor({ timeout });

async function waitForText(page, id, re, timeout = 15_000) {
  const locator = page.getByTestId(id).first();
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = (await locator.innerText().catch(() => '')) ?? '';
    if (re.test(last)) return last;
    await page.waitForTimeout(200);
  }
  throw new Error(`${id}: ${JSON.stringify(last)} never matched ${re}`);
}

async function rideAndExport(browser, base) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const problems = await watch(page, 'ride');
  const response = await page.goto(`${base}/?sim=1`);
  const headers = response.headers();
  check(
    'index served with CSP header',
    /connect-src 'self' ws: wss:/.test(headers['content-security-policy'] ?? ''),
  );
  check(
    'Permissions-Policy allows bluetooth for self',
    /bluetooth=\(self\)/.test(headers['permissions-policy'] ?? ''),
  );
  check('index.html is no-cache', headers['cache-control'] === 'no-cache');

  await page.getByTestId('sim-badge').waitFor({ timeout: 15_000 });
  await page.getByTestId('start-screen').waitFor({ timeout: 15_000 });
  await trainerConnected(page);
  check('the start screen renders, simulated devices connect', true);

  const pip = await page.evaluate(() => 'documentPictureInPicture' in window);
  const pipButton = await page.getByTestId('pip-toggle').count();
  check(
    'PiP button shown exactly when the API exists',
    (pipButton === 1) === pip,
    `documentPictureInPicture=${pip}`,
  );

  if (pip) {
    // Document Picture-in-Picture: open the stats window and look inside it.
    await page.getByTestId('pip-toggle').click();
    const opened = await page
      .waitForFunction(
        () =>
          documentPictureInPicture.window?.document.querySelector(
            '[data-testid="overlay-tile-power3s"]',
          ),
        null,
        { timeout: 5_000 },
      )
      .then(() => true)
      .catch(() => false);
    const tiles = opened
      ? await page.evaluate(
          () => documentPictureInPicture.window.document.querySelectorAll('.ov-tile').length,
        )
      : 0;
    check('PiP stats window opens with overlay tiles', opened && tiles > 0, `${tiles} tiles`);
    if (opened) {
      await page.getByTestId('pip-toggle').click();
      const closed = await page
        .waitForFunction(() => documentPictureInPicture.window === null, null, { timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      check('PiP stats window closes from the button', closed);
    }
  }

  const notice = page.getByTestId('web-bluetooth-notice');
  const noticeReason = (await notice.count())
    ? await notice.getAttribute('data-reason')
    : 'none (Web Bluetooth available)';
  results.push(`INFO  Bluetooth notice on ${base}: ${noticeReason}`);

  await page.getByTestId('start-riding').click();
  // The countdown before the start (default 3 s), then the ride records on its own.
  const counted = await page
    .getByTestId('ride-countdown')
    .waitFor({ timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  check('Start riding: the countdown before the start shows', counted);
  const riding = await page
    .locator('[data-testid="ride-state"][data-state="riding"]')
    .waitFor({ timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  const power = await waitForText(page, 'stat-power', /[1-9]\d+/);
  check(
    'Start riding: one click to a running ride with live power (after the countdown)',
    riding && (await page.getByTestId('ride-countdown').count()) === 0,
    power.replace(/\s+/g, ' '),
  );
  check(
    'the pop-out button sits in the ride toolbar as well',
    (await page.getByTestId('pip-toggle').count()) === pipButton,
  );
  const gearBefore = await text(page, 'stat-gear');
  await page.getByTestId('gear-up').click();
  await waitForText(
    page,
    'stat-gear',
    new RegExp(String(Number(gearBefore.match(/\d+/)?.[0]) + 1)),
  );
  check('shifting changes the gear', true);
  await waitForText(page, 'stat-time', /0:1[2-9]/, 30_000);
  await page.getByTestId('ride-finish').click();
  await page.getByTestId('ride-finish-confirm').click();
  await page.getByTestId('summary-screen').waitFor();
  check(
    'Finish shows the summary',
    /0:1\d/.test(await text(page, 'summary-duration')) &&
      (await page.getByTestId('summary-export-fit').count()) === 1,
  );
  await page.getByTestId('summary-done').click();
  await page.getByTestId('start-screen').waitFor();

  await page.getByTestId('nav-activity').click();
  await page.getByTestId('history-row').first().waitFor();
  check('one ride in history', (await page.getByTestId('history-row').count()) === 1);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10_000 }),
    page.getByTestId('export-fit').first().click(),
  ]);
  const file = await download.path();
  const size = statSync(file).size;
  check(
    '.fit download starts',
    /^freilauf_.*\.fit$/.test(download.suggestedFilename()),
    download.suggestedFilename(),
  );
  check('.fit size plausible (> 200 B for ≥ 12 s)', size > 200, `${size} bytes`);

  // Persistence: the ride survives a reload (IndexedDB).
  await page.reload();
  await page.getByTestId('nav-activity').click();
  await page.getByTestId('history-row').first().waitFor();
  check(
    'ride persists across reload (IndexedDB)',
    (await page.getByTestId('history-row').count()) === 1,
  );

  check(
    'no console errors / CSP violations (ride page)',
    problems.length === 0,
    problems.join(' | '),
  );
  await context.close();
}

async function insecureNotice(base, port) {
  if (!port) return;
  // A non-localhost http:// origin is not a secure context.
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP nas.test 127.0.0.1`] });
  try {
    const page = await browser.newPage();
    const problems = await watch(page, 'insecure');
    await page.goto(`http://nas.test:${port}/?sim=1`);
    const notice = page.getByTestId('web-bluetooth-notice');
    await notice.waitFor({ timeout: 10_000 });
    check(
      'insecure context shows the HTTPS notice',
      (await notice.getAttribute('data-reason')) === 'insecure-context',
      (await notice.innerText()).slice(0, 90) + '…',
    );
    await trainerConnected(page);
    check('sim mode still works without Web Bluetooth', true);
    const settings = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('freilauf.settings.v1') ?? 'null'),
    );
    results.push(
      `INFO  default signalling URL there: ${settings?.group?.signallingUrl ?? '(not yet stored; derived at runtime)'}`,
    );
    await page.getByTestId('web-bluetooth-notice-dismiss').click();
    check('notice is dismissible', (await notice.count()) === 0);
    check('no console errors (insecure page)', problems.length === 0, problems.join(' | '));
  } finally {
    await browser.close();
  }
}

async function relayFlow(base) {
  // Every host but 127.0.0.1 is unresolvable: the public relays cannot be reached.
  const browser = await chromium.launch({
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  try {
    const page = await browser.newPage();
    const raw = await watch(page, 'relays');
    const thirdParty = [];
    page.on('request', (r) => {
      if (!r.url().startsWith(base) && /^https?:/.test(r.url())) thirdParty.push(r.url());
    });
    const sockets = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    await page.goto(`${base}/?sim=1`);
    await trainerConnected(page);
    await page.getByTestId('with-group').click();
    check(
      'start screen → Group ride: Create right away, with the note on public relays',
      (await page.getByTestId('group-create').count()) === 1 &&
        /public relay servers/.test(await text(page, 'group-how')),
    );
    const started = Date.now();
    await page.getByTestId('group-create').click();
    const link = (await waitForText(page, 'group-link', /^freilauf:\/\/join\//)).trim();
    check(
      'the invite carries a secret',
      /^freilauf:\/\/join\/[A-HJKMNP-Z2-9]{6}#[A-HJKMNP-Z2-9]{12}$/.test(link),
      link.replace(/#.*/, '#…'),
    );
    const failure = await page
      .getByTestId('group-error')
      .waitFor({ timeout: 30_000 })
      .then(() => page.getByTestId('group-error').getAttribute('data-failure'))
      .catch(() => null);
    check(
      'no relay reachable: plain message instead of a hang',
      failure === 'no-relay' && /No relay server reachable/.test(await text(page, 'group-error')),
      `${failure} after ${Date.now() - started} ms`,
    );
    check(
      'relay handshake attempts only go to wss:// relays, no other third-party requests',
      sockets.length > 0 && sockets.every((u) => u.startsWith('wss://')) && thirdParty.length === 0,
      `${sockets.length} relay sockets; other: ${thirdParty.join(', ') || 'none'}`,
    );
    // Chromium logs each refused relay WebSocket as a console error; that is expected here.
    const problems = raw.filter((p) => !/WebSocket connection to 'wss:\/\/[^']+' failed/.test(p));
    check(
      'no other console errors / CSP violations (relay page)',
      problems.length === 0,
      problems.join(' | '),
    );
  } finally {
    await browser.close();
  }
}

async function groupRide(browser, base) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const problems = [...(await watch(a, 'groupA')), ...(await watch(b, 'groupB'))];
  const wsUrls = [];
  a.on('websocket', (ws) => wsUrls.push(ws.url()));
  for (const p of [a, b]) {
    await p.goto(`${base}/?sim=1`);
    await trainerConnected(p);
    await p.getByTestId('with-group').click();
  }
  // Advanced fallback: the page's own /signal is prefilled; switching it on uses it.
  await a.getByTestId('group-advanced').locator(':scope > summary').click();
  await a.getByTestId('group-own-server-toggle').check();
  await a.getByTestId('group-own-server-note').waitFor({ timeout: 5_000 });
  // Served from localhost: the same-origin server is configured, with a "this computer" note.
  check(
    'own server (advanced): Create with the same-origin server',
    (await a.getByTestId('group-create').count()) > 0 &&
      (await a.getByTestId('group-local-note').count()) === 1,
  );
  await a.getByTestId('group-create').first().click();
  const code = (await waitForText(a, 'group-code', /[A-Z0-9]{3}-?[A-Z0-9]{3}/)).trim();
  const link = (await text(a, 'group-link')).trim();
  check(
    'group created over same-origin /signal',
    wsUrls.some((u) => u.endsWith('/signal')),
    `code ${code}, ws ${wsUrls.join(', ')}`,
  );
  check(
    'the invite link carries the server',
    /^freilauf:\/\/join\/[A-Z0-9]{6}\?s=ws/.test(link) &&
      decodeURIComponent(link.split('?s=')[1] ?? '').endsWith('/signal'),
    link,
  );

  // The second rider pastes the whole invite, as a friend would.
  await b.getByTestId('group-join-input').fill(`Ride with me: ${link}`);
  await b.getByTestId('group-join').click();
  await waitForText(b, 'group-code', /[A-Z0-9]{3}-?[A-Z0-9]{3}/);
  check('second rider joins with the invite link', true);

  // The ride view's group panel has the live rider table.
  for (const p of [a, b]) {
    await p.getByTestId('start-open-ride').click();
    await p.getByTestId('ride-open-group').click();
  }
  let seen = false;
  try {
    await Promise.all([
      a.getByTestId('group-rider').first().waitFor({ timeout: 20_000 }),
      b.getByTestId('group-rider').first().waitFor({ timeout: 20_000 }),
    ]);
    seen = true;
  } catch {
    // reported below
  }
  check(
    'riders see each other (WebRTC data channel)',
    seen,
    seen
      ? `A sees: ${(await text(a, 'group-rider')).replace(/\s+/g, ' ')}`
      : 'no remote rider row within 20 s',
  );
  const peerStates = await a
    .getByTestId('group-peer')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
  check(
    'the host sees the guest as connected',
    peerStates.join() === 'connected',
    peerStates.join(),
  );
  check('no console errors (group pages)', problems.length === 0, problems.join(' | '));
  await ctxA.close();
  await ctxB.close();
}

async function pairingWithoutPicker(browser, base) {
  // 1) No Web Bluetooth at all (this headless build): Pair explains, no modal.
  {
    const page = await browser.newPage();
    const problems = await watch(page, 'pair-unavailable');
    await page.goto(`${base}/`);
    const warning = await waitForText(page, 'start-device-warning', /power will read 0/, 10_000)
      .then(() => true)
      .catch(() => false);
    check(
      'start screen without a trainer: warns, but Start riding stays usable',
      warning && (await page.getByTestId('start-riding').isEnabled()),
    );
    await page.getByTestId('start-devices').click();
    await page.getByTestId('pair-trainer').click();
    const err = await waitForText(page, 'notice-error', /Bluetooth/, 5_000).catch(() => '');
    check(
      'Pair without Web Bluetooth shows an explanation',
      /Bluetooth/.test(err),
      err.replace(/\s+/g, ' ').slice(0, 80),
    );
    check(
      'no in-app picker modal (unavailable)',
      (await page.getByTestId('device-picker').count()) === 0,
    );
    check(
      'no unexpected console errors (unavailable)',
      problems.length === 0,
      problems.join(' | '),
    );
    await page.close();
  }
  // 2) A stub navigator.bluetooth: the browser chooser is "cancelled", and a
  //    remembered trainer cannot be re-acquired on start.
  {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const bt = {
        __freilaufStub: true,
        requestDevice: () =>
          Promise.reject(
            new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'),
          ),
        getDevices: async () => [],
        getAvailability: async () => true,
      };
      Object.defineProperty(Navigator.prototype, 'bluetooth', {
        get: () => bt,
        configurable: true,
      });
      if (!localStorage.getItem('freilauf.settings.v1')) {
        localStorage.setItem(
          'freilauf.settings.v1',
          JSON.stringify({ devices: { heartRate: { id: 'gone==', name: 'Old strap' } } }),
        );
      }
    });
    const page = await context.newPage();
    const problems = await watch(page, 'pair-stub');
    await page.goto(`${base}/`);
    await page.getByTestId('start-devices').click();
    await page.getByTestId('pair-trainer').click();
    await page.waitForTimeout(500);
    check(
      'browser chooser cancel: no in-app picker, no error, Pair usable again',
      (await page.getByTestId('device-picker').count()) === 0 &&
        (await page.getByTestId('notice-error').count()) === 0 &&
        (await page.getByTestId('pair-trainer').isEnabled()),
    );
    const retry = await page
      .getByTestId('retry-heartRate')
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    check(
      'remembered device not re-acquirable stays "remembered" with Retry',
      retry,
      (await page.getByTestId('device-heartRate').innerText()).replace(/\s+/g, ' '),
    );
    check('no console errors (stub bluetooth)', problems.length === 0, problems.join(' | '));
    await context.close();
  }
}

const server = await startServer();
const browser = await chromium.launch();
try {
  await rideAndExport(browser, server.base);
  await relayFlow(server.base);
  await groupRide(browser, server.base);
  await pairingWithoutPicker(browser, server.base);
  await insecureNotice(server.base, server.port);
} catch (err) {
  check('run completed', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  await browser.close();
  server.stop();
}
console.log(`\n${results.join('\n')}`);
process.exit(failed ? 1 : 0);
