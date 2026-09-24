/**
 * ══════════════════════════════════════════════════════════════════
 *  server/proxy.js — Vite dev/preview plugin: the "spoof rung"
 * ══════════════════════════════════════════════════════════════════
 *
 *  WHY THIS EXISTS
 *  ───────────────
 *  A page running on any non-deepinfra.com origin cannot legally set
 *  `Origin`, `Referer`, `User-Agent` or `Sec-Fetch-*` — the browser
 *  overwrites or rejects them. The Python provider you reverse
 *  engineered could set all of them freely. This middleware restores
 *  that freedom: it runs in Node, so it *can* send the exact header set
 *  the web-embed build of deepinfra.com sends, and it streams the SSE
 *  response straight back to the browser byte-for-byte.
 *
 *  ROUTES
 *  ──────
 *    GET  /deepinfra-proxy/health              → tiny JSON status
 *    GET  /deepinfra-proxy/v1/models           → upstream model catalogue
 *    POST /deepinfra-proxy/v1/chat/completions → upstream SSE stream
 *
 *  KEY HANDLING
 *  ────────────
 *  Priority:  x-deepinfra-key request header  →  process.env.DEEPINFRA_API_KEY
 *  The key never leaves this machine and is never written to disk by us.
 *  With no key we send the anonymous `X-Deepinfra-Source: web-embed` set.
 */

import http from 'node:http'
import https from 'node:https'

/**
 * Upstream is api.deepinfra.com over https in normal use. Both are
 * overridable so scripts/selftest.mjs can point the proxy at a local mock
 * and prove — offline — that the request it builds is exactly right.
 */
export const UPSTREAM_HOST = process.env.DEEPINFRA_PROXY_HOST || 'api.deepinfra.com'
export const UPSTREAM_SCHEME = process.env.DEEPINFRA_PROXY_SCHEME || 'https'
export const CHAT_PATH = '/v1/openai/chat/completions'
export const MODELS_PATH = '/v1/openai/models'

/**
 * The reverse-engineered header sets. Three variants, selectable by the
 * client through the `x-deepinfra-variant` request header:
 *
 *   web-embed (default) → what g4f.Provider.DeepInfraChat really sends:
 *                         Origin https://deepinfra.com + X-Deepinfra-Source: web-embed
 *   legacy              → what My PREVIOUS ENTIRE SERVER/API/providers/DeepInfra.py sent:
 *                         Origin https://g4f.dev + a frozen x-request-id
 *   minimal             → no fingerprinting at all, just enough to be a client
 */
export function spoofHeaders({ apiKey, variant = 'web-embed', accept = 'text/event-stream' } = {}) {
  const common = {
    'Accept': accept,
    'Content-Type': 'application/json',
  }

  if (variant === 'minimal') {
    const h = {
      ...common,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    }
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
    return h
  }

  if (variant === 'legacy') {
    const h = {
      ...common,
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Origin': 'https://g4f.dev',
      'Referer': 'https://g4f.dev',
      'x-request-id': 'Ry3LRoEwEsPHJxUrUrYpfCzm',
      'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    }
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
    return h
  }

  const h = {
    ...common,
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'Origin': 'https://deepinfra.com',
    'Referer': 'https://deepinfra.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'X-Deepinfra-Source': 'web-embed',
  }
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
  return h
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error('request body too large (2 MB cap)'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[deepinfra-proxy]', ...args)
}

/**
 * Forward one request upstream and pipe the reply back.
 * Resolves with the upstream status code once headers are in.
 */
function forward({ method, path, headers, body, res, onClose }) {
  const [hostname, port] = String(UPSTREAM_HOST).split(':')
  const client = UPSTREAM_SCHEME === 'http' ? http : https
  return new Promise((resolve, reject) => {
    const upstream = client.request(
      { hostname, port: port ? Number(port) : undefined, path, method, headers },
      (upRes) => {
        const status = upRes.statusCode ?? 0
        const outHeaders = {}
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (['connection', 'transfer-encoding', 'keep-alive'].includes(k)) continue
          outHeaders[k] = v
        }
        // streaming-safe defaults
        outHeaders['Cache-Control'] = 'no-cache, no-transform'
        outHeaders['X-Accel-Buffering'] = 'no'

        res.writeHead(status, outHeaders)
        upRes.pipe(res)

        upRes.on('error', (err) => {
          log('upstream stream error:', err.message)
          try { res.destroy() } catch { /* noop */ }
        })
        upRes.on('end', () => resolve(status))
      },
    )

    upstream.setTimeout(180_000, () => {
      log('upstream timeout — destroying')
      upstream.destroy(new Error('upstream timeout'))
    })

    upstream.on('error', (err) => {
      log('upstream request error:', err.message)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
      }
      res.end(JSON.stringify({ error: { message: `proxy → upstream failed: ${err.message}` } }))
      reject(err)
    })

    if (onClose) onClose(() => upstream.destroy())
    if (body) upstream.write(body)
    upstream.end()
  })
}

export function deepinfraProxy() {
  /** @type {import('vite').Plugin} */
  const plugin = {
    name: 'deepinfra-proxy',
    apply: () => true,

    configureServer(server) {
      server.middlewares.use(mountMiddleware(server.config.logger))
    },
    configurePreviewServer(server) {
      server.middlewares.use(mountMiddleware(server.config.logger))
    },
  }
  return plugin
}

export function mountMiddleware(logger) {
  return async function middleware(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://proxy.local')
    if (!url.pathname.startsWith('/deepinfra-proxy')) return next()

    const route = url.pathname.replace('/deepinfra-proxy', '') || '/'
    const keyFromHeader = req.headers['x-deepinfra-key']
    const apiKey =
      (typeof keyFromHeader === 'string' && keyFromHeader.trim()) ||
      process.env.DEEPINFRA_API_KEY ||
      ''
    const variantHeader = req.headers['x-deepinfra-variant']
    const variant =
      typeof variantHeader === 'string' && ['web-embed', 'legacy', 'minimal'].includes(variantHeader)
        ? variantHeader
        : 'web-embed'

    // ── health ────────────────────────────────────────────────────────
    if (route === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          node: process.version,
          upstream: `https://${UPSTREAM_HOST}`,
          serverKey: Boolean(process.env.DEEPINFRA_API_KEY),
          anonymousHeaderSet: 'X-Deepinfra-Source: web-embed',
        }),
      )
      return
    }

    // ── models ────────────────────────────────────────────────────────
    if (route === '/v1/models') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      try {
        const status = await forward({
          method: 'GET',
          path: MODELS_PATH,
          headers: spoofHeaders({ apiKey, variant, accept: 'application/json' }),
          res,
          onClose: (fn) => req.on('close', fn),
        })
        log(`GET models            key=${apiKey ? 'yes' : 'no '} → ${status}`)
      } catch { /* already answered */ }
      return
    }

    // ── chat completions ──────────────────────────────────────────────
    if (route === '/v1/chat/completions') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      let payload
      try {
        payload = await readJsonBody(req)
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: err.message } }))
        return
      }

      payload.stream = true
      if (!payload.stream_options) payload.stream_options = { include_usage: true }

      const body = JSON.stringify(payload)
      log(
        `POST chat/completions model=${payload.model ?? '?'} ` +
          `msgs=${payload.messages?.length ?? 0} key=${apiKey ? 'yes' : 'no '} variant=${variant}`,
      )

      try {
        const status = await forward({
          method: 'POST',
          path: CHAT_PATH,
          headers: {
            ...spoofHeaders({ apiKey, variant }),
            'Content-Length': Buffer.byteLength(body),
          },
          body,
          res,
          onClose: (fn) => req.on('close', fn),
        })
        log(`      … finished with ${status}`)
        logger?.info?.(`[deepinfra-proxy] stream done (${status})`, { timestamp: true })
      } catch { /* already answered */ }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `unknown proxy route: ${route}` } }))
  }
}

function methodNotAllowed(res, allowed) {
  res.writeHead(405, { 'Content-Type': 'application/json', Allow: allowed })
  res.end(JSON.stringify({ error: { message: `method not allowed, use ${allowed}` } }))
}
