/**
 * ══════════════════════════════════════════════════════════════════
 *  NovaChat — Vite config
 * ══════════════════════════════════════════════════════════════════
 *
 *  Two things matter here:
 *
 *  1. `host: true` + `allowedHosts: true`  → the dev server binds
 *     0.0.0.0 and accepts proxied preview hosts (sandbox / LAN / tunnel).
 *
 *  2. `deepinfraProxy()` → a tiny Node middleware (server/proxy.js) that
 *     forwards requests to api.deepinfra.com with the *full* header set —
 *     including the ones a browser is forbidden from setting
 *     (Origin / Referer / User-Agent / Sec-Fetch-*). It is the fallback
 *     rung when the browser's direct fetch is blocked by CORS.
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { deepinfraProxy } from './server/proxy.js'

export default defineConfig({
  plugins: [react(), deepinfraProxy()],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    cors: true,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: false,
    allowedHosts: true,
    cors: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
})
