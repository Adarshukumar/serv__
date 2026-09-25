import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** This UI can only talk to its own host. On localhost, that host is the companion;
 * on a hosted preview, it has no chat endpoint. It never contacts an external API.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "connect-src 'self'",
    "script-src 'self'",
    // KaTeX positions glyphs with inline styles.
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

export default defineConfig(() => {
  const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
  return {
    base: './',
    plugins: [react(), contentSecurityPolicy()],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    server: { port: 5173, ...(allowedHosts?.length ? { allowedHosts } : {}) },
    preview: { port: 4173, ...(allowedHosts?.length ? { allowedHosts } : {}) },
    build: {
      outDir: 'dist', emptyOutDir: true,
      target: ['chrome111', 'edge111', 'firefox114', 'safari16.4'],
      sourcemap: false, modulePreload: { polyfill: false }, chunkSizeWarningLimit: 1200,
    },
  };
});
