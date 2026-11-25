// Fails the packaging step if the built main/preload bundles import anything
// other than `electron` and Node built-ins. The packaged app ships no
// node_modules (see electron-builder.yml), so such an import would only show
// up as a crash on the user's machine. The usual cause is a new @freilauf/*
// workspace package missing from WORKSPACE_PACKAGES in electron.vite.config.ts.
//
//   node build/check-bundle.mjs   (run by `pnpm dist` after electron-vite build)
//
// It also checks the prebuilt Windows watch-relay helper against its recorded
// SHA-256 (electron-builder.yml `win.extraResources`), so a corrupted or
// swapped binary never gets packaged. Missing is only an error on Windows,
// the one platform that ships it.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';

const outDir = path.resolve(import.meta.dirname, '..', 'out');
const allowed = new Set(['electron', ...builtinModules]);
const specifier =
  /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*[\w*{}\s,$]+\s*from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

const problems = [];
for (const dir of ['main', 'preload']) {
  for (const name of await readdir(path.join(outDir, dir))) {
    if (!/\.(c|m)?js$/.test(name)) continue;
    const code = await readFile(path.join(outDir, dir, name), 'utf8');
    for (const [, spec] of code.matchAll(specifier)) {
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      const bare = spec.replace(/^node:/, '');
      if (allowed.has(spec) || allowed.has(bare) || allowed.has(bare.split('/')[0])) continue;
      problems.push(`out/${dir}/${name}: ${spec}`);
    }
  }
}

const helper = path.resolve(
  import.meta.dirname,
  '..',
  'native/sensor-relay/prebuilt/win32-x64/freilauf-sensor-relay.exe',
);
if (existsSync(helper)) {
  const want = (await readFile(`${helper}.sha256`, 'utf8')).split(/\s+/)[0];
  const got = createHash('sha256')
    .update(await readFile(helper))
    .digest('hex');
  if (got !== want) {
    problems.push(
      `native/sensor-relay/prebuilt/win32-x64/freilauf-sensor-relay.exe: SHA-256 ${got}, expected ${want} (rebuild with build-windows.sh)`,
    );
  }
} else if (process.platform === 'win32') {
  problems.push('native/sensor-relay/prebuilt/win32-x64/freilauf-sensor-relay.exe is missing');
}

if (problems.length) {
  console.error(
    'Not ready to package (imports that will not exist in the packaged app, or a bad helper binary):\n  ' +
      problems.join('\n  ') +
      '\nFor imports: bundle them (electron.vite.config.ts) or ship them via electron-builder.yml `files`.',
  );
  process.exit(1);
}
console.log('check-bundle: main and preload only import electron and Node built-ins');
if (existsSync(helper)) console.log('check-bundle: watch-relay helper matches its SHA-256');
