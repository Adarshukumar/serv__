import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const DEFAULT_API_URL = 'https://api.inceptionlabs.ai';

/**
 * Production builds carry a strict Content-Security-Policy: the page may load code
 * only from itself and may talk only to itself and Inception's API. Even if some
 * markup slipped past the sanitiser, the stored API key could not be sent anywhere
 * else. (Dev builds skip it: Vite's dev client needs inline scripts and websockets.)
 */
function contentSecurityPolicy(apiOrigin: string): Plugin {
  const policy = [
    "default-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    "script-src 'self'",
    // KaTeX positions glyphs with inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
  ].join('; ');
  return {
    name: 'inception-direct:csp',
    apply: 'build',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_');
  const apiUrl = (process.env.VITE_INCEPTION_API_URL || env.VITE_INCEPTION_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);

  return {
    base: './',
    plugins: [react(), contentSecurityPolicy(new URL(apiUrl).origin)],
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
      target: ['chrome111', 'edge111', 'firefox114', 'safari16.4'],
      sourcemap: false,
      modulePreload: { polyfill: false },
      chunkSizeWarningLimit: 1200,
    },
  };
});
