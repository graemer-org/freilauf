// Fails the packaging step if the built main/preload bundles import anything
// other than `electron` and Node built-ins. The packaged app ships no
// node_modules (see electron-builder.yml), so such an import would only show
// up as a crash on the user's machine. The usual cause is a new @freilauf/*
// workspace package missing from WORKSPACE_PACKAGES in electron.vite.config.ts.
//
//   node build/check-bundle.mjs   (run by `pnpm dist` after electron-vite build)
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

if (problems.length) {
  console.error(
    'Bundles import modules that will not exist in the packaged app:\n  ' +
      problems.join('\n  ') +
      '\nBundle them (electron.vite.config.ts) or ship them via electron-builder.yml `files`.',
  );
  process.exit(1);
}
console.log('check-bundle: main and preload only import electron and Node built-ins');
