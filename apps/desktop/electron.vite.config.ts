import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/** Workspace packages are TypeScript source: bundle them, never externalise. */
const WORKSPACE_PACKAGES = [
  '@freilauf/devices',
  '@freilauf/p2p',
  '@freilauf/session',
  '@freilauf/sim',
];

/**
 * The HTML files carry the strict production CSP. The Vite dev server needs a
 * little more (inline React-refresh preamble, injected <style> tags, its HMR
 * websocket), so relax it only when serving.
 */
function devCsp(): Plugin {
  return {
    name: 'freilauf:dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i,
        (_m, a: string, csp: string, z: string) => {
          const relaxed = csp
            .replace(/script-src ([^;]*)/, "script-src $1 'unsafe-inline'")
            .replace(/connect-src ([^;]*)/, 'connect-src $1 http://localhost:* ws://localhost:*');
          return a + relaxed + z;
        },
      );
    },
  };
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: WORKSPACE_PACKAGES },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads must be a single CommonJS file that only requires
      // 'electron', so nothing is externalised.
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), devCsp()],
    build: {
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          overlay: resolve(import.meta.dirname, 'src/renderer/overlay.html'),
        },
      },
    },
  },
});
