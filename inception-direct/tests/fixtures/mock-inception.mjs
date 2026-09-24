// @ts-check
/**
 * TEST FIXTURE ONLY — a local protocol simulator for chat.inceptionlabs.ai.
 *
 * The app never uses this. It exists so the test-suite can exercise the real client,
 * the real streaming code and the real UI over a real socket, offline, with the same
 * wire protocol the live site speaks (verified 2026-09-24):
 *
 *   GET  /api/session     → { ok, token: "<unix>.<32hex>.<64hex>" } + session cookie
 *   POST /api/chat        → text/event-stream, Vercel AI SDK UI-message stream
 *   POST /api/follow-ups  → { follow_ups: string[] }
 *
 * It is strict on purpose (validates token, cookie and body shape) so the tests fail
 * if the client drifts from the protocol. Test controls:
 *   - options.challenge / POST /__control { challenge: true } → Vercel checkpoint on /api/*
 *     until GET / is visited (which sets the clearance cookie, like a real browser would)
 *   - message text containing "#error" → error event mid-stream
 *   - "#429"   → two 429 responses before succeeding
 *   - "#slow"  → slow deltas (for stop/abort tests)
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

const REASONING = ['Considering what is being asked.', 'Recalling the relevant facts.', 'Structuring a clear answer.'];

/**
 * @param {{ port?: number, host?: string, cors?: boolean, challenge?: boolean, deltaDelayMs?: number, tokenTtlMs?: number }} [options]
 */
export async function startMockInception(options = {}) {
  const state = {
    challenge: options.challenge ?? false,
    tokens: new Map(), // token → { sid, issuedAt }
    sessions: new Set(),
    rateLimited: new Map(), // chat id → count
    chats: /** @type {{ id: string, messages: number, reasoningEffort: string, webSearchEnabled: boolean, question: string, origin?: string }[]} */ ([]),
    log: /** @type {{ method: string, path: string, status: number, origin?: string, cookie?: string }[]} */ ([]),
  };
  const deltaDelayMs = options.deltaDelayMs ?? 12;
  const tokenTtlMs = options.tokenTtlMs ?? 13 * 60_000;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    const cookies = parseCookies(req.headers.cookie);
    const done = (/** @type {number} */ status) =>
      state.log.push({ method: req.method ?? 'GET', path: url.pathname, status, origin, cookie: req.headers.cookie });

    if (options.cors && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-session-token');
      res.writeHead(204).end();
      return done(204);
    }

    if (url.pathname === '/__control' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body?.challenge === 'boolean') state.challenge = body.challenge;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, challenge: state.challenge }));
      return done(200);
    }

    if (url.pathname === '/') {
      // Visiting the site "passes" the checkpoint, like the real JS challenge does in a browser.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': '_vcrcs=cleared; Path=/; HttpOnly; SameSite=Lax',
      });
      res.end('<!doctype html><title>Inception Chat</title><p>mock site</p>');
      return done(200);
    }

    if (url.pathname.startsWith('/api/') && state.challenge && cookies._vcrcs !== 'cleared') {
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'x-vercel-mitigated': 'challenge', server: 'Vercel' });
      res.end('<!doctype html><title>Vercel Security Checkpoint</title><script src="/.well-known/vercel/security/static/challenge.v2.min.js"></script>');
      return done(429);
    }

    if (url.pathname === '/api/session' && req.method === 'GET') {
      const sid = cookies.session && state.sessions.has(cookies.session) ? cookies.session : randomBytes(12).toString('hex');
      state.sessions.add(sid);
      const issuedAt = Math.floor(Date.now() / 1000);
      const nonce = randomBytes(16).toString('hex');
      const sig = createHash('sha256').update(`${issuedAt}.${nonce}.${sid}`).digest('hex');
      const token = `${issuedAt}.${nonce}.${sig}`;
      state.tokens.set(token, { sid, issuedAt: Date.now() });
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
        'set-cookie': `session=${sid}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(JSON.stringify({ ok: true, token }));
      return done(200);
    }

    if ((url.pathname === '/api/chat' || url.pathname === '/api/follow-ups') && req.method === 'POST') {
      const auth = checkAuth(req, cookies, state, tokenTtlMs);
      if (auth) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: auth }));
        return done(401);
      }
      const body = await readJson(req);

      if (url.pathname === '/api/follow-ups') {
        if (!Array.isArray(body?.messages) || body.messages.length < 2) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'messages required' }));
          return done(400);
        }
        const last = textOf(body.messages.at(-2));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            follow_ups: [`Can you go deeper on “${last.slice(0, 40)}”?`, 'What are the common misconceptions?', 'Give me a concrete example.'],
          }),
        );
        return done(200);
      }

      const problem = validateChatBody(body);
      if (problem) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: problem }));
        return done(400);
      }
      const question = textOf(body.messages.at(-1));
      state.chats.push({
        id: body.id,
        messages: body.messages.length,
        reasoningEffort: body.reasoningEffort,
        webSearchEnabled: body.webSearchEnabled,
        question,
        origin,
      });

      if (question.includes('#429')) {
        const n = (state.rateLimited.get(body.id) ?? 0) + 1;
        state.rateLimited.set(body.id, n);
        if (n <= 2) {
          res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Too many requests' }));
          return done(429);
        }
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-vercel-ai-ui-message-stream': 'v1',
      });
      done(200);
      await streamAnswer(res, body, question, question.includes('#slow') ? 120 : deltaDelayMs);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
    done(404);
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://${options.host ?? '127.0.0.1'}:${address.port}`;
  return {
    url,
    state,
    setChallenge: (/** @type {boolean} */ on) => {
      state.challenge = on;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

/** @param {http.ServerResponse} res @param {any} body @param {string} question @param {number} delay */
async function streamAnswer(res, body, question, delay) {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const send = (/** @type {any} */ event) => {
    if (!closed) res.write(`data: ${event === '[DONE]' ? '[DONE]' : JSON.stringify(event)}\n\n`);
  };
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

  send({ type: 'start', messageId: randomBytes(8).toString('hex') });
  send({ type: 'start-step' });

  if (body.reasoningEffort !== 'instant') {
    send({ type: 'reasoning-start', id: 'r0' });
    for (const line of REASONING) {
      for (const piece of chunkWords(`${line}\n`)) {
        if (closed) return;
        send({ type: 'reasoning-delta', id: 'r0', delta: piece });
        await sleep(delay);
      }
    }
    send({ type: 'reasoning-end', id: 'r0' });
  }

  if (body.webSearchEnabled) {
    send({ type: 'source-url', sourceId: 'search', url: '', title: '__searching__' });
    await sleep(delay * 3);
    send({ type: 'source-url', sourceId: 's1', url: 'https://example.org/physics/scattering', title: 'Scattering, explained' });
    send({ type: 'source-url', sourceId: 's2', url: 'https://example.net/atmosphere', title: 'The atmosphere' });
    send({ type: 'source-url', sourceId: 's3', url: 'https://example.org/physics/scattering#intro', title: 'Scattering, explained (duplicate)' });
    send({ type: 'source-url', sourceId: 's4', url: 'https://example.com/light', title: 'Light and colour' });
  }

  const answer = [
    `## On “${question.replace(/#\w+/g, '').trim().slice(0, 60)}”`,
    '',
    `This reply was streamed by the local protocol simulator with thinking **${body.reasoningEffort}**, ` +
      `web search **${body.webSearchEnabled ? 'on' : 'off'}**, ${body.messages.length} message(s) of history and timezone ${body.timezone}. ` +
      'It exists only for tests; the real app streams Mercury from chat.inceptionlabs.ai.',
    '',
    '- Multi-byte text survives chunking: नमस्ते 👋 — café ✓',
    '- Inline math renders: $e^{i\\pi} + 1 = 0$, prices do not: $5 and $10.',
    '',
    '```python',
    'def greet(name: str) -> str:',
    '    return f"Hello, {name}!"',
    '```',
    '',
    '$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$',
    '',
    'End of the simulated answer.',
  ].join('\n');

  send({ type: 'text-start', id: 't0' });
  const pieces = chunkWords(answer);
  for (let i = 0; i < pieces.length; i++) {
    if (closed) return;
    send({ type: 'text-delta', id: 't0', delta: pieces[i] });
    if (question.includes('#error') && i === Math.floor(pieces.length / 3)) {
      send({ type: 'error', errorText: 'Simulated upstream failure' });
      send('[DONE]');
      res.end();
      return;
    }
    await sleep(delay);
  }
  send({ type: 'text-end', id: 't0' });
  send({ type: 'finish-step' });
  send({ type: 'finish' });
  send('[DONE]');
  res.end();
}

/** Split into word-ish pieces, deliberately cutting some words, like token deltas. */
function chunkWords(/** @type {string} */ text) {
  const out = [];
  const re = /\S+\s*|\s+/g;
  let m;
  while ((m = re.exec(text))) {
    const piece = m[0];
    if (piece.length > 7) {
      out.push(piece.slice(0, 4), piece.slice(4));
    } else out.push(piece);
  }
  return out;
}

function parseCookies(/** @type {string | undefined} */ header) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** @param {http.IncomingMessage} req @param {Record<string,string>} cookies @param {any} state @param {number} ttl */
function checkAuth(req, cookies, state, ttl) {
  const token = req.headers['x-session-token'];
  if (typeof token !== 'string' || !token) return 'missing x-session-token';
  const entry = state.tokens.get(token);
  if (!entry) return 'unknown session token';
  if (Date.now() - entry.issuedAt > ttl) return 'session token expired';
  if (cookies.session !== entry.sid) return 'session cookie missing or mismatched';
  return null;
}

function validateChatBody(/** @type {any} */ body) {
  if (!body || typeof body !== 'object') return 'body must be JSON';
  if (!['instant', 'low', 'medium', 'high'].includes(body.reasoningEffort)) return 'invalid reasoningEffort';
  if (typeof body.webSearchEnabled !== 'boolean') return 'webSearchEnabled must be boolean';
  if (body.voiceMode !== false) return 'voiceMode must be false';
  if (typeof body.timezone !== 'string' || !body.timezone) return 'timezone required';
  if (typeof body.id !== 'string' || !body.id) return 'id required';
  if (body.trigger !== 'submit-message') return 'trigger must be submit-message';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages required';
  for (const m of body.messages) {
    if (typeof m?.id !== 'string' || !['user', 'assistant'].includes(m.role) || !Array.isArray(m.parts)) return 'malformed message';
    for (const part of m.parts) if (part?.type !== 'text' || typeof part.text !== 'string') return 'malformed part';
  }
  if (body.messages.at(-1).role !== 'user') return 'last message must be from the user';
  return null;
}

function textOf(/** @type {any} */ message) {
  return (message?.parts ?? []).filter((/** @type {any} */ p) => p?.type === 'text').map((/** @type {any} */ p) => p.text).join('');
}

/** @param {http.IncomingMessage} req */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    return null;
  }
}
