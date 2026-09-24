import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const DEFAULT_BASE_URL = 'https://chat.inceptionlabs.ai';

/**
 * Emits dist/manifest.json. Host permission, content-script match and the header
 * rule all derive from the same origin, so a test build can target a local server.
 */
function extensionManifest(baseUrl: string): Plugin {
  return {
    name: 'inception-direct:manifest',
    apply: 'build',
    generateBundle() {
      const url = new URL(baseUrl);
      // Chrome match patterns don't carry ports; `*://host/*` style is port-agnostic.
      const pattern = `${url.protocol}//${url.hostname}/*`;
      const icons = { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' };
      const manifest = {
        manifest_version: 3,
        name: 'Mercury — Inception Direct',
        short_name: 'Mercury',
        version: pkg.version,
        description: 'Mercury by Inception, typeset. Streams chat.inceptionlabs.ai right in your browser, on your own IP. No servers in between.',
        minimum_chrome_version: '116',
        icons,
        action: { default_title: 'Open Mercury', default_icon: icons },
        background: { service_worker: 'background.js', type: 'module' },
        permissions: ['declarativeNetRequestWithHostAccess'],
        host_permissions: [pattern],
        content_scripts: [
          {
            matches: [pattern],
            js: ['content-bridge.js'],
            run_at: 'document_idle',
            all_frames: false,
          },
        ],
      };
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(manifest, null, 2)}\n` });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_');
  const baseUrl = (env.VITE_INCEPTION_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);

  return {
    base: './',
    plugins: [react(), extensionManifest(baseUrl)],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      port: 5173,
      ...(allowedHosts?.length ? { allowedHosts } : {}),
    },
    preview: {
      port: 4173,
      ...(allowedHosts?.length ? { allowedHosts } : {}),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'chrome116',
      sourcemap: false,
      modulePreload: { polyfill: false },
      chunkSizeWarningLimit: 1200,
      rolldownOptions: {
        input: {
          index: `${root}index.html`,
          background: `${root}src/extension/background.ts`,
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
