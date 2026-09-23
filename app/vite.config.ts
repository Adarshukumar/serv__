import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA is static. In dev, /bridge is proxied to the LOCAL egress bridge so
// the browser only ever talks to same-origin paths (no CORS, no mixed content).
// The bridge itself is what dials the providers, from the user's own IP.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/bridge': {
        target: process.env.BRIDGE_URL || 'http://127.0.0.1:8787',
        changeOrigin: true,
        // SSE must not be buffered
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            proxyRes.headers['x-accel-buffering'] = 'no';
          });
        },
      },
    },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { outDir: 'dist', sourcemap: true },
});
