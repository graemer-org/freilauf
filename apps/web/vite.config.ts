import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { CONTENT_SECURITY_POLICY } from './src/server/securityHeaders.ts';

/**
 * Adds the CSP as a <meta> in the production build only: the dev server
 * (React fast refresh) needs inline scripts. The production server also sends
 * it as a header (src/server/securityHeaders.ts).
 */
function cspMeta(): Plugin {
  return {
    name: 'freilauf-csp-meta',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  plugins: [react(), cspMeta()],
  resolve: {
    // The desktop renderer sources would resolve their imports from
    // apps/desktop/node_modules. Resolve them from this app instead: one copy
    // of each in the bundle, and the Docker build only has to install
    // `@freilauf/web...` (not Electron).
    dedupe: [
      'react',
      'react-dom',
      'zustand',
      '@freilauf/devices',
      '@freilauf/p2p',
      '@freilauf/session',
      '@freilauf/sim',
    ],
  },
  server: {
    // `pnpm signalling` runs the standalone signalling server on :8787.
    proxy: { '/signal': { target: 'ws://localhost:8787', ws: true } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
