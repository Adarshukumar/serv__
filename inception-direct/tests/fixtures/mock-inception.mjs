// @ts-check
/**
 * TEST FIXTURE ONLY — a local simulator of Inception's official API (api.inceptionlabs.ai).
 *
 * The app never uses this. It lets the test-suite drive the real client, the real
 * streaming code and the real UI over a real socket, offline, with the wire format of
 * the live API (docs + OpenAPI spec, checked 2026-09-25):
 *
 *   GET  /v1/models            → public model list (same shape as the live one)
 *   POST /v1/chat/completions  → JSON, or an SSE stream of `chat.completion.chunk`s
 *                                ending in `data: [DONE]`; `diffusing: true` streams the
 *                                full text at every denoising step
 *
 * CORS behaves like the live API (FastAPI/Starlette): the Origin is reflected with
 * allow-credentials, real preflights get the allow lists, a bare OPTIONS is a 405.
 *
 * It is strict on purpose — unknown parameters, malformed messages or a missing key are
 * rejected — so the tests fail if the client drifts from the documented protocol.
 *
 * Keys: "test-key" works, "broke-key" → 402, anything else → 401.
 * Triggers in the last user message: #error (error payload mid-stream), #429 (two 429s
 * first), #503 (one 503 first), #slow, #drop (connection cut mid-stream), #length
 * (finish_reason "length"), #nosummary (no reasoning summary).
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

export const MODELS = [
  {
    id: 'mercury-2',
    name: 'Inception: Mercury 2',
    created: 1743465660,
    input_modalities: ['text'],
    output_modalities: ['text'],
    context_length: 128000,
    max_output_length: 50000,
    pricing: { prompt: '0.00000025', completion: '0.00000075', input_cache_reads: '0.000000025', input_cache_writes: '0' },
    supported_sampling_parameters: ['temperature', 'stop'],
    supported_features: ['tools', 'json_mode', 'structured_outputs'],
  },
  {
    id: 'mercury-2.5',
    name: 'Inception: Mercury 2.5',
    created: 1743465660,
    input_modalities: ['text'],
    output_modalities: ['text'],
    context_length: 260000,
    max_output_length: 65536,
    pricing: { prompt: '0.00000004', completion: '0.00000015', input_cache_reads: '0.000000004', input_cache_writes: '0' },
    supported_sampling_parameters: ['temperature', 'stop'],
    supported_features: ['tools', 'json_mode', 'structured_outputs'],
  },
];

const ALLOWED_PARAMS = new Set([
  'model', 'messages', 'max_tokens', 'max_completion_tokens', 'temperature', 'stop', 'tools', 'tool_choice',
  'stream', 'stream_options', 'diffusing', 'realtime', 'response_format', 'reasoning_summary',
  'reasoning_summary_wait', 'reasoning_effort',
]);

/**
 * @param {{ port?: number, host?: string, blockDelayMs?: number, cors?: boolean, steps?: number }} [options]
 */
export async function startMockInception(options = {}) {
  const state = {
    rateLimited: new Map(), // question → count
    overloaded: new Set(),
    /** @type {{ kind: 'chat' | 'handshake' | 'follow-ups', model: string, effort?: string, diffusing: boolean, stream: boolean, includeUsage: boolean, reasoningSummary: boolean, maxTokens?: number, roles: string[], question: string, origin?: string }[]} */
    requests: [],
    /** @type {{ method: string, path: string, status: number, origin?: string, key?: string }[]} */
    log: [],
  };
  const blockDelayMs = options.blockDelayMs ?? 14;
  const cors = options.cors ?? true;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    const key = bearer(req.headers.authorization);
    const done = (/** @type {number} */ status) => state.log.push({ method: req.method ?? 'GET', path: url.pathname, status, origin, key });
    const json = (/** @type {number} */ status, /** @type {unknown} */ body, /** @type {Record<string,string>} */ headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
      done(status);
    };
    const apiError = (/** @type {number} */ status, /** @type {string} */ message, /** @type {string} */ type, /** @type {string|null} */ code, /** @type {string|null} */ param = null) =>
      json(status, { error: { message, type, param, code } });

    if (cors && origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      if (cors && origin && req.headers['access-control-request-method']) {
        res.writeHead(200, {
          'access-control-allow-methods': 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT',
          'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? ''),
          'access-control-max-age': '600',
          'content-type': 'text/plain; charset=utf-8',
        });
        res.end('OK');
        return done(200);
      }
      return json(405, { detail: 'Method Not Allowed' }, { allow: url.pathname === '/v1/models' ? 'GET' : 'POST' });
    }

    if (url.pathname === '/v1/models' || url.pathname === '/v1/chat/completions/models') {
      if (req.method !== 'GET') return json(405, { detail: 'Method Not Allowed' }, { allow: 'GET' });
      return json(200, { data: MODELS }, { 'cache-control': 'public, max-age=60' });
    }

    if (url.pathname !== '/v1/chat/completions') return json(404, { detail: 'Not Found' });
    if (req.method !== 'POST') return json(405, { detail: 'Method Not Allowed' }, { allow: 'POST' });

    if (!key) return apiError(401, 'Missing API key. Send it as Authorization: Bearer <key>.', 'authentication_error', 'invalid_api_key');
    if (key === 'broke-key') return apiError(402, 'Account is inactive', 'account_error', 'account_error');
    if (key !== 'test-key') return apiError(401, 'Incorrect API key provided', 'authentication_error', 'invalid_api_key');
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      return apiError(400, 'Content-Type must be application/json', 'invalid_request_error', null);
    }

    const body = await readJson(req);
    const problem = validate(body);
    if (problem) return apiError(problem.status, problem.message, problem.status === 404 ? 'invalid_request_error' : 'invalid_request_error', problem.code, problem.param);

    const question = String(body.messages.at(-1)?.content ?? '');
    const followUps = body.response_format?.json_schema?.name === 'follow_ups';
    const kind = followUps ? 'follow-ups' : body.max_completion_tokens === 1 && !body.stream ? 'handshake' : 'chat';
    state.requests.push({
      kind,
      model: body.model,
      effort: body.reasoning_effort,
      diffusing: body.diffusing === true,
      stream: body.stream === true,
      includeUsage: body.stream_options?.include_usage === true,
      reasoningSummary: body.reasoning_summary === true,
      maxTokens: body.max_completion_tokens ?? body.max_tokens,
      roles: body.messages.map((/** @type {any} */ m) => m.role),
      question,
      origin,
    });

    // Triggers apply to answers only — not to follow-up requests whose transcript quotes them.
    if (kind === 'chat' && question.includes('#429')) {
      const n = (state.rateLimited.get(question) ?? 0) + 1;
      state.rateLimited.set(question, n);
      if (n <= 2) return apiError(429, 'Rate limit exceeded. Please try again later.', 'rate_limit_error', 'rate_limit_reached');
    }
    if (kind === 'chat' && question.includes('#503') && !state.overloaded.has(question)) {
      state.overloaded.add(question);
      return apiError(503, 'Engine overloaded', 'server_error', 'engine_overloaded');
    }

    const id = `chatcmpl-${randomBytes(6).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);

    if (!body.stream) {
      const content = followUps
        ? JSON.stringify({ follow_ups: [`What else should I know about ${topic(body)}?`, 'Can you give a concrete example?', 'What are common misconceptions?'] })
        : 'O';
      return json(200, {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [{ index: 0, finish_reason: kind === 'handshake' ? 'length' : 'stop', message: { role: 'assistant', content } }],
        usage: usage(12, kind === 'handshake' ? 1 : 40, 0),
      });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    done(200);
    await stream(res, body, question, { id, created, delay: question.includes('#slow') ? 110 : blockDelayMs, steps: options.steps ?? 10 });
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://${options.host ?? '127.0.0.1'}:${address.port}`;
  return {
    url,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

/** The simulated answer: markdown, maths, code and multi-byte text — every rendering path. */
export function answerFor(/** @type {any} */ body, /** @type {string} */ question) {
  const history = body.messages.filter((/** @type {any} */ m) => m.role !== 'system').length;
  return [
    `## On “${question.replace(/#\w+/g, '').trim().slice(0, 60)}”`,
    '',
    `This reply was streamed by the local API simulator from **${body.model}** with reasoning **${body.reasoning_effort ?? 'medium'}**, ` +
      `${history} message(s) of history${body.messages[0]?.role === 'system' ? ' and a system message' : ''}. ` +
      'It exists only for tests; the real app streams Mercury from api.inceptionlabs.ai.',
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
}

/**
 * @param {http.ServerResponse} res @param {any} body @param {string} question
 * @param {{ id: string, created: number, delay: number, steps: number }} o
 */
async function stream(res, body, question, o) {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  const chunk = (/** @type {any} */ extra) => ({ id: o.id, object: 'chat.completion.chunk', created: o.created, model: body.model, ...extra });
  const send = (/** @type {any} */ payload) => {
    if (!closed) res.write(`data: ${payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload)}\n\n`);
  };
  const choice = (/** @type {any} */ delta, /** @type {string|null} */ finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

  const effort = body.reasoning_effort ?? 'medium';
  const reasoningTokens = { instant: 0, low: 60, medium: 180, high: 420 }[/** @type {'instant'} */ (effort)] ?? 180;
  // Reasoning happens before the first block arrives.
  await sleep({ instant: 0, low: 60, medium: 160, high: 320 }[/** @type {'instant'} */ (effort)] ?? 160);
  if (closed) return;

  send(chunk(choice({ role: 'assistant', content: '' })));
  const answer = answerFor(body, question);
  const limited = question.includes('#length');
  const text = limited ? answer.slice(0, 180) : answer;

  if (body.diffusing) {
    // A fixed canvas, refined in place: masked words settle over a few steps.
    const tokens = text.split(/(\s+)/);
    const order = tokens.map((_, i) => i).filter((i) => /\S/.test(tokens[i] ?? '')).sort(() => Math.random() - 0.5);
    const settled = new Set();
    const perStep = Math.ceil(order.length / o.steps);
    for (let step = 0; step < o.steps; step++) {
      for (const i of order.slice(step * perStep, (step + 1) * perStep)) settled.add(i);
      const canvas = tokens.map((t, i) => (/\s/.test(t) || settled.has(i) ? t : noise(t))).join('');
      if (closed) return;
      send(chunk(choice({ content: canvas })));
      await sleep(o.delay * 2);
    }
    send(chunk(choice({ content: text })));
  } else {
    const blocks = toBlocks(text);
    for (let i = 0; i < blocks.length; i++) {
      if (closed) return;
      send(chunk(choice({ content: blocks[i] })));
      if (question.includes('#error') && i === Math.floor(blocks.length / 3)) {
        send({ error: { message: 'Simulated upstream failure', type: 'server_error', code: 'server_error' } });
        res.end();
        return;
      }
      if (question.includes('#drop') && i === Math.floor(blocks.length / 2)) {
        res.socket?.destroy();
        return;
      }
      await sleep(o.delay);
    }
  }

  const summary =
    body.reasoning_summary && effort !== 'instant' && !question.includes('#nosummary')
      ? { content: 'Weighed what the question asks, recalled the relevant facts, and chose a structure that answers it directly.', status: 'complete' }
      : null;
  send(chunk({ ...choice({}, limited ? 'length' : 'stop'), ...(summary ? { reasoning_summary: summary } : {}) }));
  if (body.stream_options?.include_usage) {
    send(chunk({ choices: [], usage: usage(countTokens(JSON.stringify(body.messages)), countTokens(text) + reasoningTokens, reasoningTokens) }));
  }
  send('[DONE]');
  res.end();
}

function usage(/** @type {number} */ prompt, /** @type {number} */ completion, /** @type {number} */ reasoning) {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

const countTokens = (/** @type {string} */ s) => Math.max(1, Math.round(s.length / 4));

/** Mercury emits blocks of refined text, not single tokens: a few words at a time. */
function toBlocks(/** @type {string} */ text) {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const out = [];
  for (let i = 0; i < words.length; ) {
    const size = 2 + (i % 4);
    out.push(words.slice(i, i + size).join(''));
    i += size;
  }
  return out;
}

function noise(/** @type {string} */ word) {
  const glyphs = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < Math.min(word.length, 12); i++) out += glyphs[Math.floor(Math.random() * glyphs.length)];
  return out;
}

function topic(/** @type {any} */ body) {
  const text = String(body.messages.at(-1)?.content ?? '');
  const match = /User: ([^\n]{1,40})/.exec(text);
  return match ? match[1].replace(/#\w+/g, '').trim() : 'this';
}

function bearer(/** @type {string | undefined} */ header) {
  const match = /^Bearer\s+(.+)$/.exec(header ?? '');
  return match ? match[1].trim() : null;
}

/** @returns {{ status: number, message: string, code: string | null, param: string | null } | null} */
function validate(/** @type {any} */ body) {
  const bad = (/** @type {string} */ message, /** @type {string|null} */ param = null, status = 400, /** @type {string|null} */ code = null) => ({ status, message, code, param });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Request body must be a JSON object.');
  for (const k of Object.keys(body)) if (!ALLOWED_PARAMS.has(k)) return bad(`Unrecognized request argument supplied: ${k}`, k);
  if (typeof body.model !== 'string') return bad('model is required', 'model');
  const model = MODELS.find((m) => m.id === body.model);
  if (!model) return bad(`model \`${body.model}\` not found`, 'model', 404, 'model_not_found');
  if (!Array.isArray(body.messages) || body.messages.length === 0) return bad('messages must be a non-empty array', 'messages');
  for (const [i, m] of body.messages.entries()) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role)) return bad(`messages[${i}].role is invalid`, 'messages');
    if (typeof m.content !== 'string' || !m.content.trim()) return bad(`messages[${i}].content must be a non-empty string`, 'messages');
    if (m.role === 'system' && i !== 0) return bad('the system message must come first', 'messages');
    if (i > 0 && m.role !== 'system' && body.messages[i - 1].role === m.role) return bad('messages must alternate between user and assistant', 'messages');
  }
  if (body.messages.at(-1).role !== 'user') return bad('the last message must come from the user', 'messages');
  if (body.reasoning_effort !== undefined && !['instant', 'low', 'medium', 'high'].includes(body.reasoning_effort)) return bad('invalid reasoning_effort', 'reasoning_effort');
  for (const flag of ['stream', 'diffusing', 'realtime', 'reasoning_summary', 'reasoning_summary_wait']) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') return bad(`${flag} must be a boolean`, flag);
  }
  if (body.stream_options !== undefined && (!body.stream || typeof body.stream_options !== 'object')) return bad('stream_options requires stream=true', 'stream_options');
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > model.max_output_length)) {
    return bad(`max_completion_tokens must be between 1 and ${model.max_output_length} for ${model.id}`, 'max_completion_tokens');
  }
  if (body.diffusing && !body.stream) return bad('diffusing requires stream=true', 'diffusing');
  return null;
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
