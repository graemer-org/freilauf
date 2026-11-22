// Generates the placeholder app icon: build/icon.svg (source) and
// build/icon.png (1024x1024, what electron-builder derives the .icns/.ico and
// Linux icon sizes from).
//
//   node apps/desktop/build/generate-icon.mjs
//
// The artwork is original and deliberately simple: a freewheel sprocket
// (Freilauf is German for "freewheel") on a rounded square. It renders the SVG
// with Playwright's Chromium (the e2e tests already depend on Playwright; run
// `pnpm exec playwright install chromium` once if no browser is installed).
// The PNG is committed, so this only needs re-running when the artwork changes.
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const SIZE = 1024;
const here = import.meta.dirname;

/** A sprocket outline: `teeth` rounded teeth between radius r0 and r1. */
function sprocketPath(cx, cy, teeth, r0, r1) {
  const pts = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    // valley, flank up, tip, flank down
    const seg = [
      [a - step * 0.5, r0],
      [a - step * 0.22, r0],
      [a - step * 0.14, r1],
      [a + step * 0.14, r1],
      [a + step * 0.22, r0],
    ];
    for (const [ang, r] of seg) pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
  }
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z';
}

/** Ratchet ring: saw-tooth inner edge, the visual hint of a freewheel. */
function ratchetPath(cx, cy, teeth, rIn, rOut) {
  const pts = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    pts.push([cx + rIn * Math.cos(a), cy + rIn * Math.sin(a)]);
    pts.push([cx + rOut * Math.cos(a + step * 0.85), cy + rOut * Math.sin(a + step * 0.85)]);
    pts.push([cx + rIn * Math.cos(a + step), cy + rIn * Math.sin(a + step)]);
  }
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z';
}

const c = SIZE / 2;
// macOS icon grid: an 824px tile centred on the 1024px canvas.
const tile = 824;
const inset = (SIZE - tile) / 2;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1fb58f"/>
      <stop offset="1" stop-color="#0b5c73"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="185" fill="url(#bg)"/>
  <path d="${sprocketPath(c, c, 18, 268, 318)}" fill="#ffffff"/>
  <circle cx="${c}" cy="${c}" r="212" fill="#0e6f78"/>
  <path d="${ratchetPath(c, c, 12, 150, 190)}" fill="#ffffff" fill-rule="evenodd"/>
  <circle cx="${c}" cy="${c}" r="150" fill="#ffffff"/>
  <circle cx="${c}" cy="${c}" r="62" fill="#0e6f78"/>
</svg>
`;

await writeFile(path.join(here, 'icon.svg'), svg);

/** Project Playwright first, then a globally installed one (NODE_PATH). */
async function launchChromium() {
  const require = createRequire(import.meta.url);
  let lastError;
  for (const id of ['@playwright/test', 'playwright']) {
    try {
      return await require(id).chromium.launch();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const browser = await launchChromium();
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator('svg').screenshot({
    path: path.join(here, 'icon.png'),
    omitBackground: true,
  });
} finally {
  await browser.close();
}
console.log('wrote build/icon.svg and build/icon.png');
