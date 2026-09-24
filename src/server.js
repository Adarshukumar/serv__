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
import { egressIP, netLog, netLogTail, networkReport } from './network.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 8486);
/**
 * UI bind address.
 * - Arena preview: HOST=:: with ipv6Only:false → accepts IPv4 + IPv6
 *   (proxy may dial 127.0.0.1 OR ::1; missing one → Cloudflare 502).
 * - Local-only default: 127.0.0.1 (no LAN exposure).
 * Outbound to Upstage always opens from this process (user's IP),
 * independent of this bind address.
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

function sendJSON(res, status, obj, headOnly = false) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(body),
  });
  if (headOnly) res.end();
  else res.end(body);
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

/**
 * Python parity: data-mode multi-turn.
 * - default: KEEP provider history (like up.chat(data=…))
 * - body.reset=true → new_session first
 * - body.messages[] → messages mode (replaces history inside stream)
 * - body.fresh=true → clear history only (one-shot like old behavior)
 */
function prepareTurn(up, body) {
  if (body.reset) {
    up.newSession();
    netLog('session-reset', { via: 'reset flag' });
  } else if (body.fresh && !body.messages) {
    up.clearHistory();
  }
  // else: multi-turn — stream() appends user turn, history grows like Python
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
      'access-control-allow-methods': 'GET,POST,HEAD,OPTIONS',
      'access-control-allow-headers': 'content-type,x-session-key',
    });
    res.end();
    return;
  }

  // HEAD: same headers as GET, empty body (proxy health checks)
  const isHead = req.method === 'HEAD';

  // ── static UI ──
  if ((req.method === 'GET' || isHead) && (p === '/' || p === '/index.html')) {
    const file = path.join(PUBLIC_DIR, 'index.html');
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'cache-control': 'no-store',
      'content-length': stat.size,
    });
    if (isHead) res.end();
    else fs.createReadStream(file).pipe(res);
    return;
  }
  if ((req.method === 'GET' || isHead) && p.startsWith('/public/')) {
    const rel = path.normalize(p.slice('/public/'.length)).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file)) {
      const ext = path.extname(file);
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': stat.size,
      });
      if (isHead) res.end();
      else fs.createReadStream(file).pipe(res);
      return;
    }
  }

  // ── API ──
  if (p === '/api/health' && (req.method === 'GET' || isHead)) {
    sendJSON(res, 200, {
      ok: true,
      service: 'upstage-solar-npm',
      console: consoleUrl(),
      api_base: apiBase(),
      node: process.version,
      pid: process.pid,
      topology: {
        ui_bind: 'dual-stack loopback/LAN (same machine)',
        outbound: 'direct from this process = user public IP',
        relay: 'none',
        proxy: 'none',
      },
    }, isHead);
    return;
  }

  if (p === '/api/ip' && req.method === 'GET') {
    sendJSON(res, 200, await egressIP({ force: url.searchParams.get('force') === '1' }));
    return;
  }

  // ── network log: real IP + path, NO credential connect ──
  if (p === '/api/network' && (req.method === 'GET' || isHead)) {
    const report = await networkReport({
      force: url.searchParams.get('force') === '1',
    });
    sendJSON(res, 200, report, isHead);
    return;
  }

  if (p === '/api/models' && (req.method === 'GET' || isHead)) {
    const up = providerFor(sess);
    sendJSON(res, 200, {
      models: up.listModels(),
      info: UpstageProvider.modelInfo(),
      active: up.model,
    }, isHead);
    return;
  }

  if (p === '/api/status' && req.method === 'GET') {
    const up = providerFor(sess);
    // cheap status: only verify if we already have an action token; never auto-capture
    let token = null;
    let error = null;
    if (up._creds.actionToken) {
      try {
        token = await up._creds.verify();
      } catch (e) {
        error = String(e.message || e);
      }
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
      last_usage: up.last_usage ? up.last_usage.to_dict() : null,
      network_log: netLogTail(30),
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
        network_log: netLogTail(30),
      });
    } catch (e) {
      sendJSON(res, 502, {
        ok: false,
        error: String(e.message || e),
        hint: 'Real console.upstage.ai must be reachable from this machine.',
        network_log: netLogTail(30),
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
    prepareTurn(up, body);
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
        usage_line: up.last_usage ? up.last_usage.formatLine() : null,
        history: up.history,
        history_roles: up.history.map((m) => m.role),
      });
    } catch (e) {
      const status = e instanceof UpstageAuthError ? 401 : 502;
      sendJSON(res, status, {
        ok: false,
        error: String(e.message || e),
        type: e.constructor.name,
        network_log: netLogTail(20),
      });
    }
    return;
  }

  if (p === '/api/chat/stream' && req.method === 'POST') {
    const body = await readJSON(req);
    const up = providerFor(sess);
    prepareTurn(up, body);

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
      if (up.last_usage) {
        send('usage', {
          ...up.last_usage.to_dict(),
          format_line: up.last_usage.formatLine(),
        });
      }
      send('eof', {
        ok: true,
        history_roles: up.history.map((m) => m.role),
        turn: up.history.length,
      });
    } catch (e) {
      send('error', {
        error: String(e.message || e),
        type: e.constructor.name,
        auth: e instanceof UpstageAuthError,
        network_log: netLogTail(20),
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
    // log so we can see proxy traffic in process output
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} host=${req.headers.host || '-'}`);
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendJSON(res, 500, { ok: false, error: String(e.message || e) });
      else res.end();
    });
  });

  // SSE can run for minutes — never let Node kill long streams
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 65_000;
  server.setTimeout(0);

  // dual-stack when HOST is a wildcard / "::" so both 127.0.0.1 and ::1 work
  const wildcard = host === '0.0.0.0' || host === '::' || host === '';
  const listenHost = wildcard ? '::' : host;
  const listenOpts = wildcard
    ? { port, host: '::', ipv6Only: false }
    : { port, host: listenHost };

  server.listen(listenOpts, () => {
    const shown = wildcard ? 'localhost' : host;
    console.log(`☀️  upstage-solar-npm`);
    console.log(`   UI  http://${shown}:${port}  (dual-stack ${wildcard ? 'IPv4+IPv6' : listenHost})`);
    console.log(`   console  ${consoleUrl()}`);
    console.log(`   api      ${apiBase()}`);
    console.log(`   outbound DIRECT from this machine (your public IP)`);
    console.log(`   relay    none — no server IP in the path`);

    // kick off egress-IP probe immediately (network log, NO /connect)
    netLog('server-start', { port, host: shown });
    egressIP({ force: true }).catch(() => {});
  });

  server.on('error', (err) => {
    console.error('server error:', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${port} busy — set PORT=… and retry`);
      process.exit(1);
    }
  });

  return server;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  startServer();
}
