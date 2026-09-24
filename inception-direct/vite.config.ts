import react from '@vitejs/plugin-react';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const DEFAULT_BASE_URL = 'https://chat.inceptionlabs.ai';

/** Where the dev and preview servers offer the packed extension. Keep in sync with ConnectionPanel. */
const DOWNLOAD_PATH = '/download/inception-direct.zip';

/**
 * Serves the zip made by `npm run zip` from the dev and preview servers, so the web
 * preview can hand over the ready-built extension. Build output is untouched: the
 * zip is never copied into dist/ or into the extension itself.
 */
function extensionDownload(): Plugin {
  const fileName = `inception-direct-${pkg.version}.zip`;
  const filePath = `${root}${fileName}`;

  const handler = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    // Mounted at DOWNLOAD_PATH, so req.url is what follows it. Only the exact path is ours.
    const rest = (req.url ?? '/').split('?')[0];
    if ((rest !== '/' && rest !== '') || (req.method !== 'GET' && req.method !== 'HEAD')) return next();

    let stats: { size: number; mtime: Date };
    try {
      stats = statSync(filePath);
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end('The extension has not been packed yet. Run `npm run build && npm run zip`, then reload.\n');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(stats.size));
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Last-Modified', stats.mtime.toUTCString());
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath)
      .on('error', () => res.destroy())
      .pipe(res);
  };

  return {
    name: 'inception-direct:download',
    configureServer(server) {
      server.middlewares.use(DOWNLOAD_PATH, handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(DOWNLOAD_PATH, handler);
    },
  };
}

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
    plugins: [react(), extensionManifest(baseUrl), extensionDownload()],
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
