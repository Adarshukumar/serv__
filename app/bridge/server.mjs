#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
//  bridge/server.mjs — LOCAL egress bridge
//
//  Not a hosted server. It runs on the user's own machine so provider requests
//  carry the user's own IP, and because Node — unlike a browser — may set the
//  forbidden headers (Origin / Referer / Sec-Fetch-*) that every one of these
//  providers sends. See ARCHITECTURE.md §2 and §3.
//
//  Zero dependencies: Node ≥20 built-in http + fetch only.
//
//  The bridge does NOT parse provider responses. It pipes the raw SSE through
//  and lets the browser's normalisers (src/lib/normalizers.ts, covered by 50
//  tests) do the work. One parser implementation, not two.
//
//    node bridge/server.mjs
//    HOST=127.0.0.1 PORT=8787 node bridge/server.mjs
// ══════════════════════════════════════════════════════════════

import http from 'node:http';
import { mockStream } from './mock.mjs';
import { HEADERS, ENDPOINTS } from './headers.mjs';
import {
  deepInfraPayload,
  mCloudFlarePayload,
  dolphinPayload,
  llmChatPayload,
  llmChatUrl,
  mercuryPayload,
  upstagePayload,
} from './payloads.mjs';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);

// ── outer SSE envelope (bridge → browser) ───────────────────
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// ── per-provider request assembly ───────────────────────────
// `wire` tells the browser which normaliser to instantiate.
const PROVIDERS = {
  mock: {
    wire: (req) => req.wire || 'upstage-v3',
    // Mock never leaves the machine.
    run: async function* (req, emit) {
      const wire = req.wire || 'upstage-v3';
      emit('meta', { provider: 'mock', wire, model: req.model || 'mock' });
      for await (const chunk of mockStream(wire)) emit('raw', { chunk });
    },
  },

  DeepInfra: {
    wire: () => 'openai-delta',
    url: () => ENDPOINTS.DeepInfra,
    headers: () => HEADERS.DeepInfra,
    body: (req) => deepInfraPayload(req),
  },

  mCloudFlare: {
    wire: () => 'workers-raw',
    url: () => ENDPOINTS.mCloudFlare,
    headers: () => HEADERS.mCloudFlare,
    body: (req) => mCloudFlarePayload(req),
  },

  Dolphin: {
    wire: () => 'openai-delta',
    url: () => ENDPOINTS.Dolphin,
    headers: () => HEADERS.Dolphin,
    body: (req) => dolphinPayload(req),
    // Dolphin honours finish_reason as its terminator (Dolphin._parse_sse).
    honourFinish: true,
  },

  LLMChat: {
    wire: () => 'reasoning-delta',
    url: (req) => llmChatUrl(ENDPOINTS.LLMChat, req.tag || '@cf', req.modelId),
    headers: () => HEADERS.LLMChat,
    body: (req) => llmChatPayload(req),
  },

  Mercury: {
    wire: () => 'typed-events',
    url: () => ENDPOINTS.Mercury,
    headers: () => ({
      ...HEADERS.Mercury,
      'user-agent': process.env.MERCURY_UA || HEADERS.DeepInfra['User-Agent'],
      // Captured session token. Never logged, never sent to the browser.
      ...(process.env.MERCURY_TOKEN ? { 'x-session-token': process.env.MERCURY_TOKEN } : {}),
    }),
    body: (req) => mercuryPayload(req),
    credentials: true,
  },

  Upstage: {
    wire: () => 'upstage-v3',
    url: () => ENDPOINTS.Upstage,
    headers: () => ({
      ...HEADERS.Upstage,
      ...(process.env.UPSTAGE_CSRF ? { 'x-csrf-token': process.env.UPSTAGE_CSRF } : {}),
      ...(process.env.UPSTAGE_COOKIE ? { cookie: process.env.UPSTAGE_COOKIE } : {}),
    }),
    body: (req) => upstagePayload(req),
    credentials: true,
  },
};

/** Generic streaming runner: POST, then pipe the response body verbatim. */
async function streamHttp(def, req, emit, signal) {
  const wire = def.wire(req);
  const url = def.url(req);
  const headers = def.headers(req);

  emit('meta', { provider: req.provider, wire, model: req.modelId, url });

  if (def.credentials) {
    const has = req.provider === 'Upstage'
      ? Boolean(process.env.UPSTAGE_COOKIE && process.env.UPSTAGE_CSRF)
      : Boolean(process.env.MERCURY_TOKEN);
    if (!has) {
      emit('error', {
        message:
          `${req.provider} needs captured session credentials. Supply them to the bridge as ` +
          (req.provider === 'Upstage' ? 'UPSTAGE_COOKIE + UPSTAGE_CSRF' : 'MERCURY_TOKEN') +
          ' environment variables. Credential capture is not ported yet (ARCHITECTURE.md §10).',
        retryable: false,
        code: 'missing_credentials',
      });
      return;
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(def.body(req)),
      signal,
      redirect: 'follow',
    });
  } catch (err) {
    emit('error', {
      message: `network failure contacting ${req.provider}: ${err?.message || err}`,
      retryable: true,
      code: 'network',
    });
    return;
  }

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* body already consumed or unavailable */
    }
    emit('error', {
      message: `${req.provider} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
      // 429/5xx are worth a retry; 401/403 usually mean credentials or blocking.
      retryable: res.status === 429 || res.status >= 500,
      code: `http_${res.status}`,
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) emit('raw', { chunk });
    }
    const tail = decoder.decode();
    if (tail) emit('raw', { chunk: tail });
  } catch (err) {
    if (signal?.aborted) return; // client went away — not an error
    emit('error', { message: `stream interrupted: ${err?.message || err}`, retryable: true, code: 'stream' });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

// ── HTTP plumbing ───────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (path === '/bridge/health' || path === '/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'aduskills-bridge',
      providers: Object.keys(PROVIDERS),
      // Report honestly which providers this bridge could actually reach.
      credentials: {
        Upstage: Boolean(process.env.UPSTAGE_COOKIE && process.env.UPSTAGE_CSRF),
        Mercury: Boolean(process.env.MERCURY_TOKEN),
      },
      node: process.version,
      pid: process.pid,
    });
  }

  if (req.method === 'GET' && path === '/bridge/providers') {
    return sendJson(res, 200, {
      providers: Object.entries(PROVIDERS).map(([id, def]) => ({
        id,
        wire: def.wire({}),
        endpoint: def.url ? def.url({ modelId: '', tag: '@cf' }) : 'local',
        credentials: Boolean(def.credentials),
      })),
    });
  }

  if (req.method === 'POST' && path === '/bridge/chat') {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      return sendJson(res, 400, { error: `invalid JSON body: ${err.message}` });
    }

    const providerId = payload.provider || 'mock';
    const def = PROVIDERS[providerId];
    if (!def) return sendJson(res, 404, { error: `unknown provider "${providerId}"` });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Let the browser read this even if the SPA is served from another origin.
      'access-control-allow-origin': process.env.BRIDGE_CORS_ORIGIN || '*',
      'x-accel-buffering': 'no',
    });

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const emit = (event, data) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(frame(event, data));
    };

    try {
      const reqObj = { provider: providerId, ...payload };
      if (def.run) {
        for await (const _ of def.run(reqObj, emit)) {
          /* generator drives emit() itself */
        }
      } else {
        await streamHttp(def, reqObj, emit, controller.signal);
      }
    } catch (err) {
      emit('error', { message: `bridge failure: ${err?.message || err}`, retryable: false, code: 'bridge' });
    } finally {
      if (!res.writableEnded) {
        res.write(frame('end', { ok: true }));
        res.end();
      }
    }
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': process.env.BRIDGE_CORS_ORIGIN || '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  return sendJson(res, 404, {
    error: 'not found',
    routes: ['GET /bridge/health', 'GET /bridge/providers', 'POST /bridge/chat'],
  });
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log(`[bridge] listening on http://${shown}:${PORT}`);
  console.log(`[bridge] providers: ${Object.keys(PROVIDERS).join(', ')}`);
  console.log('[bridge] this process runs on YOUR machine — provider calls leave from YOUR IP');
  if (!process.env.UPSTAGE_COOKIE) console.log('[bridge] UPSTAGE_COOKIE/UPSTAGE_CSRF not set — Upstage will report missing_credentials');
  if (!process.env.MERCURY_TOKEN) console.log('[bridge] MERCURY_TOKEN not set — Mercury will report missing_credentials');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[bridge] ${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
