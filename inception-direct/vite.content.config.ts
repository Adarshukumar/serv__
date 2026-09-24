import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Content scripts must be classic scripts (no `import`), so the bridge is built on
 * its own as a self-contained IIFE into the same dist/ folder.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'chrome116',
    sourcemap: false,
    lib: {
      entry: `${root}src/extension/content-bridge.ts`,
      formats: ['iife'],
      name: 'InceptionDirectBridge',
      fileName: () => 'content-bridge.js',
    },
  },
});
