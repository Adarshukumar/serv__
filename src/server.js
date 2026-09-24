/**
 * server.js — local HTTP gateway + browser UI.
 *
 * Topology (all outbound from THIS machine = the user's IP):
 *
 *   Browser ──HTTP──▶ this server (localhost) ──HTTPS──▶ console.upstage.ai
 *                                                    └─▶ ap-northeast-2.apistage.ai
 *
 * There is NO mock and NO offline mode: /api/chat* always hits the
 * real Upstage API through UpstageProvider. Failures surface as real
 * HTTP/SSE errors.
 *
 * Endpoints:
 *   GET  /                     UI
 *   GET  /api/health           liveness + endpoints + egress probe
 *   GET  /api/models           model registry (all models, active flag)
 *   GET  /api/status           credential/connection status
 *   POST /api/connect          force credential capture (real HTTP)
 *   POST /api/chat             JSON full response
 *   POST /api/chat/stream      SSE of StreamEvents + usage trailer
 *   GET  /api/usage            session usage report (text + totals)
 *   POST /api/session/reset    clear history/state
 *   GET  /api/ip               egress IP as seen by the internet
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  UpstageAuthError,
  UpstageProvider,
  UpstageStreamError,
} from './provider.js';
import { apiBase, consoleUrl } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 8486);
/**
 * Loopback by default: the UI is same-machine only — no LAN/public
 * "server IP" is ever exposed. Outbound to Upstage always opens from
 * this process (the user's IP), independent of this bind address.
 * Set HOST=0.0.0.0 only if you deliberately need remote UI access.
 */
const HOST = process.env.HOST || '127.0.0.1';

/** One provider per browser session key (default conversation). */
const providers = new Map();
function providerFor(key = 'default') {
  if (!providers.has(key)) providers.set(key, new UpstageProvider());
  return providers.get(key);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

function chatOptsFrom(body) {
  return {
    data: body.prompt ?? (body.messages ? undefined : undefined),
    messages: Array.isArray(body.messages) && body.messages.length
      ? body.messages
      : undefined,
    model: body.model || undefined,
    system: body.system || undefined,
    reasoning: body.reasoning || undefined,
    search: body.search ? true : undefined,
    maxTokens: body.max_tokens ?? body.maxTokens ?? 256,
    temperature: body.temperature ?? undefined,
  };
}

// ── egress IP (proves outbound = this machine / user's IP) ──
async function egressIP() {
  const endpoints = [
    'https://api.ipify.org?format=json',
    'https://icanhazip.com/',
    'https://checkip.amazonaws.com/',
  ];
  for (const url of endpoints) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const text = (await r.text()).trim();
      try {
        const j = JSON.parse(text);
        if (j.ip) return { ip: j.ip, via: url };
      } catch {
        if (/^\d{1,3}(\.\d{1,3}){3}$|:/.test(text)) return { ip: text, via: url };
      }
    } catch {
      /* try next */
    }
  }
  return { ip: null, via: null, error: 'egress probe unreachable' };
}

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const sess = req.headers['x-session-key'] || url.searchParams.get('session') || 'default';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-session-key',
    });
    res.end();
    return;
  }

  // ── static UI ──
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const file = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (req.method === 'GET' && p.startsWith('/public/')) {
    const rel = path.normalize(p.slice('/public/'.length)).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file)) {
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }

  // ── API ──
  if (p === '/api/health' && req.method === 'GET') {
    sendJSON(res, 200, {
      ok: true,
      service: 'upstage-solar-npm',
      console: consoleUrl(),
      api_base: apiBase(),
      node: process.version,
      pid: process.pid,
      topology: {
        ui_bind: 'loopback (same machine)',
        outbound: 'direct from this process = user public IP',
        relay: 'none',
        proxy: 'none',
      },
    });
    return;
  }

  if (p === '/api/ip' && req.method === 'GET') {
    sendJSON(res, 200, await egressIP());
    return;
  }

  if (p === '/api/models' && req.method === 'GET') {
    const up = providerFor(sess);
    sendJSON(res, 200, {
      models: up.listModels(),
      info: UpstageProvider.modelInfo(),
      active: up.model,
    });
    return;
  }

  if (p === '/api/status' && req.method === 'GET') {
    const up = providerFor(sess);
    let token = null;
    let error = null;
    try {
      token = await up._creds.verify();
    } catch (e) {
      error = String(e.message || e);
    }
    sendJSON(res, 200, {
      connected: Boolean(token),
      model: up.model,
      search: up.search,
      history: up.history.length,
      turns: up.session_usage.totals().turns,
      action_token: up._creds.actionToken
        ? up._creds.actionToken.slice(0, 12) + '…'
        : null,
      session_id: up._creds.sessionId,
      csrf_valid: Boolean(token),
      error,
      console: consoleUrl(),
      api_base: apiBase(),
      usage: up.session_usage.totals(),
    });
    return;
  }

  if (p === '/api/connect' && req.method === 'POST') {
    const up = providerFor(sess);
    try {
      await up.connect();
      const token = await up._creds.verify();
      sendJSON(res, 200, {
        ok: true,
        csrf_valid: Boolean(token),
        action_token: up._creds.actionToken,
        session_id: up._creds.sessionId,
      });
    } catch (e) {
      sendJSON(res, 502, {
        ok: false,
        error: String(e.message || e),
        hint: 'Real console.upstage.ai must be reachable from this machine.',
      });
    }
    return;
  }

  if (p === '/api/usage' && req.method === 'GET') {
    const up = providerFor(sess);
    sendJSON(res, 200, {
      totals: up.session_usage.totals(),
      report: up.session_usage.formatReport(),
      last: up.last_usage ? up.last_usage.to_dict() : null,
    });
    return;
  }

  if (p === '/api/session/reset' && req.method === 'POST') {
    const up = providerFor(sess);
    up.newSession();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readJSON(req);
    const up = providerFor(sess);
    up.clearHistory(); // stateless JSON mode unless messages[] provided
    try {
      for await (const _ of up.chat(chatOptsFrom(body))) {
        /* drain */
      }
      sendJSON(res, 200, {
        ok: true,
        model: up.last_usage?.model || up.model,
        response: up.last_response,
        reasoning: up.last_reasoning,
        sources: up.last_sources,
        sources_text: up.last_sources_text,
        usage: up.last_usage ? up.last_usage.to_dict() : null,
        history_roles: up.history.map((m) => m.role),
      });
    } catch (e) {
      const status = e instanceof UpstageAuthError ? 401 : 502;
      sendJSON(res, status, {
        ok: false,
        error: String(e.message || e),
        type: e.constructor.name,
      });
    }
    return;
  }

  if (p === '/api/chat/stream' && req.method === 'POST') {
    const body = await readJSON(req);
    const up = providerFor(sess);
    up.clearHistory();

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const ev of up.stream(chatOptsFrom(body))) {
        send(ev.kind, ev);
      }
      if (up.last_usage) send('usage', up.last_usage.to_dict());
      send('eof', { ok: true });
    } catch (e) {
      send('error', {
        error: String(e.message || e),
        type: e.constructor.name,
        auth: e instanceof UpstageAuthError,
      });
    } finally {
      res.end();
    }
    return;
  }

  sendJSON(res, 404, { ok: false, error: `no route ${req.method} ${p}` });
}

export function startServer(port = PORT, host = HOST) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendJSON(res, 500, { ok: false, error: String(e.message || e) });
      else res.end();
    });
  });
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`☀️  upstage-solar-npm`);
    console.log(`   UI (loopback only)  http://${shown}:${port}`);
    console.log(`   console             ${consoleUrl()}`);
    console.log(`   api                 ${apiBase()}`);
    console.log(`   outbound            DIRECT from this machine (your public IP)`);
    console.log(`   relay / proxy       none — no server IP in the path`);
  });
  return server;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  startServer();
}
