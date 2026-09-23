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
// The RSC credential pipeline lives in TypeScript and is environment-agnostic
// (it only uses fetch + regexes), so the relay imports it directly rather than
// duplicating it. This is why `bridge:fallback` runs under tsx.
import { captureCreds } from '../src/lib/upstageSession.ts';
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
    // The three x- headers from upstage_provider.py _stream_events(). An earlier
    // revision sent only x-csrf-token, so x-session-id was missing and the API
    // could not authenticate the request.
    headers: () => ({
      ...HEADERS.Upstage,
      ...(upstageCsrf() ? { 'x-csrf-token': upstageCsrf() } : {}),
      ...(upstageSessionId() ? { 'x-session-id': upstageSessionId() } : {}),
      ...(upstageCookieHeader() ? { cookie: upstageCookieHeader() } : {}),
    }),
    body: (req) => upstagePayload(req),
    credentials: true,
  },
};

// ── Upstage session state, captured at runtime ─────────────────
// Node holds a real cookie jar, which is the one thing a browser cannot do:
// the console (console.upstage.ai) and the API (ap-northeast-2.apistage.ai)
// are different registrable domains, and the Python client forwards the
// console's cookies to the API manually.
const upstageState = { csrf: null, sessionId: null, cookies: {}, capturedAt: null, error: null };

/** Wrap fetch with a persistent cookie jar, the way curl_cffi's session does. */
function createCookieJarFetch() {
  const jar = new Map();
  const impl = async (url, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(url, { ...init, headers });
    // Node 18.14+ exposes the full Set-Cookie list; the browser API does not.
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return res;
  };
  return { impl, jar };
}

/** Run the same capture flow the Python client runs, with a real cookie jar. */
async function establishUpstageSession() {
  const { impl, jar } = createCookieJarFetch();
  const r = await captureCreds({ fetchImpl: impl });
  if (r.creds.csrf) {
    // The jar now holds the console's session cookies — the part a browser can
    // never obtain. Merge them into the creds forwarded to the API.
    const cookies = { ...Object.fromEntries(jar), ...r.creds.cookies };
    upstageState.csrf = r.creds.csrf;
    upstageState.sessionId = cookies.session_id || r.creds.sessionId;
    upstageState.cookies = cookies;
    upstageState.capturedAt = new Date().toISOString();
    upstageState.error = null;
    return { ok: true, csrf: upstageState.csrf, sessionId: upstageState.sessionId,
             cookies, capturedAt: upstageState.capturedAt, chunksScanned: r.chunksScanned };
  }
  upstageState.error = `failed at step: ${r.failedStep ?? 'unknown'} — ${r.error ?? ''}`;
  return { ok: false, error: upstageState.error, cookies: {}, chunksScanned: r.chunksScanned };
}

/** Env vars still win, so an existing manual setup keeps working. */
const upstageCsrf = () => process.env.UPSTAGE_CSRF || upstageState.csrf || null;
const upstageSessionId = () => process.env.UPSTAGE_SESSION_ID || upstageState.sessionId || null;
const upstageCookieHeader = () => {
  if (process.env.UPSTAGE_COOKIE) return process.env.UPSTAGE_COOKIE;
  const s = Object.entries(upstageState.cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  return s || null;
};
const upstageReady = () => Boolean(upstageCsrf() && upstageCookieHeader());

/** Generic streaming runner: POST, then pipe the response body verbatim. */
async function streamHttp(def, req, emit, signal) {
  const wire = def.wire(req);
  const url = def.url(req);
  const headers = def.headers(req);

  emit('meta', { provider: req.provider, wire, model: req.modelId, url });

  if (def.credentials) {
    // Upstage: try to establish the session automatically first, exactly as
    // UpstageProvider.connect() does, before reporting a credential failure.
    if (req.provider === 'Upstage' && !upstageReady()) {
      emit('status', { phase: 'connecting', detail: 'Establishing Upstage session (RSC capture)…' });
      await establishUpstageSession();
    }

    const has = req.provider === 'Upstage' ? upstageReady() : Boolean(process.env.MERCURY_TOKEN);
    if (!has) {
      emit('error', {
        message:
          req.provider === 'Upstage'
            ? `Upstage needs captured session credentials. Automatic capture ${upstageState.error ? `failed (${upstageState.error})` : 'has not run'}. ` +
              `POST /bridge/upstage/session to retry, or supply UPSTAGE_CSRF + UPSTAGE_COOKIE + UPSTAGE_SESSION_ID as environment variables.`
            : `Mercury needs captured session credentials (a session token). Supply MERCURY_TOKEN as an environment variable.`,
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
        Upstage: upstageReady(),
        UpstageSession: upstageState.capturedAt
          ? { capturedAt: upstageState.capturedAt, sessionId: upstageState.sessionId, cookieNames: Object.keys(upstageState.cookies) }
          : upstageState.error ? { error: upstageState.error } : null,
        Mercury: Boolean(process.env.MERCURY_TOKEN),
      },
      node: process.version,
      pid: process.pid,
    });
  }

  // Establish (or re-establish) the Upstage session on demand.
  if (req.method === 'POST' && path === '/bridge/upstage/session') {
    const out = await establishUpstageSession();
    // Never echo cookie VALUES back to the browser — names only.
    const { cookies, ...safe } = out;
    json(res, out.ok ? 200 : 502, { ...safe, cookieNames: Object.keys(cookies || {}) });
    return;
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
    routes: [
      'GET /bridge/health',
      'GET /bridge/providers',
      'POST /bridge/chat',
      'POST /bridge/upstage/session',
    ],
  });
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log(`[bridge] listening on http://${shown}:${PORT}`);
  console.log(`[bridge] providers: ${Object.keys(PROVIDERS).join(', ')}`);
  console.log('[bridge] this process runs on YOUR machine — provider calls leave from YOUR IP');
  if (!process.env.UPSTAGE_COOKIE) {
    console.log('[bridge] UPSTAGE_COOKIE/UPSTAGE_CSRF not set — Upstage will attempt automatic RSC capture on first use');
    console.log('[bridge]   (or POST /bridge/upstage/session to capture it now)');
  }
  if (!process.env.MERCURY_TOKEN) console.log('[bridge] MERCURY_TOKEN not set — Mercury will report missing_credentials');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[bridge] ${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
