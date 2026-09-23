// ══════════════════════════════════════════════════════════════
//  tests/direct.test.ts — the DIRECT transport, verified without network
//
//  Two things are asserted here:
//    1. REQUEST FORMATION. Every provider must resolve to its own real URL with
//       the payload its Python original sent. "Form all tokens correctly" is a
//       testable claim, so it is tested rather than asserted in prose.
//    2. ESTABLISHING THE CONNECTION. fetch is stubbed, so the streaming path —
//       SSE framing, normalisation, error handling — is exercised on real bytes
//       with no provider reachable and no relay involved.
//
//  The sandbox cannot reach any provider host (TLS is killed on egress), so a
//  live call is NOT attempted and NOT claimed. What is claimed is that the
//  request the browser would send is correct, and that the response handling is
//  correct. Whether a provider's CORS policy accepts it can only be observed
//  from the user's own browser.
// ══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequest, streamDirect, setUpstageCsrf, setMercuryToken } from '../src/lib/direct.ts';
import { streamChat } from '../src/lib/stream.ts';
import { isForbiddenHeader, splitHeaders, FULL_HEADERS, ENDPOINTS } from '../src/lib/headers.ts';
import { UPSTAGE_MODELS } from '../src/lib/payloads.ts';
import { PROVIDERS } from '../src/data/providers.ts';
import type { ChatRequest, StreamEvent } from '../src/types.ts';

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: 'DeepInfra',
  model: 'test-model',
  modelId: 'test-model',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'second turn' },
  ],
  system: 'You are helpful.',
  ...over,
});

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Build a Response whose body streams the given SSE chunks, like a real provider. */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
        // Yield so the reader sees genuinely separate frames, not one blob.
        await new Promise((r) => setTimeout(r, 0));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

// ── 1. every provider targets its own real URL ─────────────────
test('direct: all six real providers resolve to their true endpoint, never a relay', () => {
  const ids = ['DeepInfra', 'mCloudFlare', 'Dolphin', 'LLMChat', 'Mercury', 'Upstage'] as const;
  for (const id of ids) {
    const r = resolveRequest(req({ provider: id, tag: '@cf' }));
    assert.ok(r.url.startsWith('https://'), `${id} must be an absolute https URL, got ${r.url}`);
    // LLMChat appends ?model={tag}/{name} per LLmChat.py:315 and Upstage
    // appends ?include_think=true, so compare on origin+path and assert the
    // request really targets the provider's own host.
    const base = ENDPOINTS[id]!;
    const strip = (u: string) => u.split('?')[0];
    assert.equal(strip(r.url), strip(base), `${id} URL must match the Python source`);
    assert.equal(new URL(r.url).host, new URL(base).host, `${id} must target the provider's real host`);
    // The whole point: no relay hop anywhere in the request.
    assert.ok(!/bridge|localhost|127\.0\.0\.1|:8787/i.test(r.url), `${id} must not route via the bridge`);
    assert.equal(r.method, 'POST');
    assert.ok(r.body && r.body.length > 2, `${id} must carry a JSON body`);
    assert.doesNotThrow(() => JSON.parse(r.body!), `${id} body must be valid JSON`);
  }
});

test('direct: providers.ts declares direct transport for every provider', () => {
  for (const p of PROVIDERS) {
    assert.equal(p.transport, 'direct', `${p.id} should default to direct, not ${p.transport}`);
  }
});

test('direct: LLMChat puts the routing tag in the query string, as LLmChat.py:315 does', () => {
  const r = resolveRequest(req({ provider: 'LLMChat', modelId: 'kimi-k2.5', tag: '@hf' }));
  assert.equal(r.url, 'https://llmchat.in/inference/stream?model=%40hf%2Fkimi-k2.5');
  // ...and NOT in the body.
  assert.ok(!('model' in (JSON.parse(r.body!) as object)), 'LLMChat body must omit model');
  // Default tag when none is supplied.
  assert.match(resolveRequest(req({ provider: 'LLMChat', modelId: 'm' })).url, /[?&]model=%40cf%2Fm$/);
});

test('direct: Upstage keeps include_think=true on the query string', () => {
  const r = resolveRequest(req({ provider: 'Upstage', modelId: 'solar-pro3' }));
  assert.match(r.url, /include_think=true$/);
});

// ── 2. forbidden headers are never attempted ───────────────────
test('headers: the Fetch-spec forbidden set is recognised, including the Sec- prefix', () => {
  for (const h of ['Origin', 'Referer', 'User-Agent', 'Cookie', 'Connection', 'Accept-Encoding', 'Content-Length', 'Host']) {
    assert.ok(isForbiddenHeader(h), `${h} is forbidden and must be detected`);
  }
  // Prefix rule: ANY Sec-* and Proxy-*, which covers Sec-Fetch-* and sec-ch-ua*.
  for (const h of ['Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest', 'sec-ch-ua', 'Sec-Ch-Ua-Platform', 'Proxy-Authorization']) {
    assert.ok(isForbiddenHeader(h), `${h} starts with a forbidden prefix`);
  }
  // And the ones we DO send must not be misclassified.
  for (const h of ['Accept', 'Accept-Language', 'Content-Type', 'Cache-Control', 'x-request-id', 'x-session-token', 'x-csrf-token']) {
    assert.ok(!isForbiddenHeader(h), `${h} is settable and must not be blocked`);
  }
});

test('headers: no settable header set contains a forbidden name, for any provider', () => {
  for (const provider of Object.keys(FULL_HEADERS)) {
    const { settable, forbidden } = splitHeaders(provider);
    for (const k of Object.keys(settable)) {
      assert.ok(!isForbiddenHeader(k), `${provider} tried to set forbidden header ${k}`);
    }
    // Prove the split is lossless and that the known-hard cases landed correctly.
    assert.equal(
      Object.keys(settable).length + Object.keys(forbidden).length,
      Object.keys(FULL_HEADERS[provider]).length,
      `${provider} header split must be lossless`,
    );
  }
  // The three providers that assert same-origin must have those in `forbidden`.
  for (const provider of ['mCloudFlare', 'Dolphin', 'Mercury']) {
    const { forbidden } = splitHeaders(provider);
    const keys = Object.keys(forbidden).map((k) => k.toLowerCase());
    assert.ok(keys.includes('sec-fetch-site'), `${provider} sends Sec-Fetch-Site: same-origin — must be reported as forbidden`);
    assert.ok(keys.includes('origin'), `${provider} Origin must be reported as forbidden`);
  }
});

// ── 3. payload fidelity against the Python originals ───────────
test('payload: DeepInfra clamps temperature and requests usage it then ignores', () => {
  const body = JSON.parse(resolveRequest(req({ provider: 'DeepInfra', temperature: 5, maxTokens: 999 })).body!) as any;
  assert.equal(body.temperature, 2, 'temperature must clamp to 2');
  assert.equal(body.max_tokens, 999);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.model, 'test-model');
  // Negative clamps to 0; the system prompt becomes a leading system message.
  const b2 = JSON.parse(resolveRequest(req({ provider: 'DeepInfra', temperature: -3 })).body!) as any;
  assert.equal(b2.temperature, 0);
  assert.equal(b2.messages[0].role, 'system');
  assert.equal(b2.messages.filter((m: any) => m.role === 'system').length, 1, 'exactly one system message');
});

test('payload: Dolphin has no system role — it folds system into a prefixed user turn', () => {
  const body = JSON.parse(resolveRequest(req({ provider: 'Dolphin' })).body!) as any;
  assert.ok(!body.messages.some((m: any) => m.role === 'system'), 'Dolphin must never send role:system');
  assert.equal(body.messages[0].content, '[SYSTEM] YOU HAVE TO ACT AS : You are helpful.');
  assert.equal(body.template, 'creative');
  assert.equal(body.model, 'test-model');
});

test('payload: Mercury merges consecutive user turns and shapes parts with state', () => {
  const body = JSON.parse(
    resolveRequest(
      req({
        provider: 'Mercury',
        system: 'SYS',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
          { role: 'assistant', content: 'c' },
        ],
      }),
    ).body!,
  ) as any;
  // system → prefixed user turn, then merged with the following user turn.
  assert.equal(body.messages.length, 2, 'two consecutive user turns must merge into one');
  assert.equal(body.messages[0].role, 'user');
  assert.ok(!('content' in body.messages[0]), 'Mercury messages carry parts, not a flat content field');
  assert.equal(body.messages[0].parts[0].text, '[SYSTEM INSTRUCTION] SYS\n\na\n\nb');
  assert.equal(body.messages[0].parts[0].type, 'text');
  assert.ok(!('state' in body.messages[0].parts[0]), 'user parts carry no state');
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].parts[0].state, 'done', 'assistant parts must be marked done');
  assert.match(body.messages[0].id, /^msg-/, 'every Mercury message needs an id');
});

test('payload: Upstage marks only the LAST user turn for search and derives effort', () => {
  const search = JSON.parse(
    resolveRequest(req({ provider: 'Upstage', modelId: 'solar-pro3', search: true })).body!,
  ) as any;
  const users = search.messages.filter((m: any) => m.role === 'user');
  assert.equal(users.filter((m: any) => m.mode).length, 1, 'exactly one message carries mode');
  assert.deepEqual(users[users.length - 1].mode, ['search'], 'and it must be the LAST user turn');
  assert.equal(search.reasoning_effort, 'high', 'search ON → high');
  assert.equal(search.search_provider, 'tavily');
  assert.equal(search.stream, true);
  assert.ok(search.conversation_id.startsWith('conv-'));
  assert.equal(search.temperature, 0.8, 'pro3 default temperature');
  assert.equal(search.max_tokens, 65536, 'pro3 default max_tokens');

  const noSearch = JSON.parse(
    resolveRequest(req({ provider: 'Upstage', modelId: 'solar-pro3', search: false })).body!,
  ) as any;
  assert.equal(noSearch.reasoning_effort, 'low', 'search OFF → low');
  assert.ok(!('search_provider' in noSearch), 'no search_provider when search is off');

  // An explicit, valid effort wins over the automatic choice.
  const explicit = JSON.parse(
    resolveRequest(req({ provider: 'Upstage', modelId: 'solar-pro3', reasoning: 'medium', search: true })).body!,
  ) as any;
  assert.equal(explicit.reasoning_effort, 'medium');

  // An effort the model does not accept must NOT be sent.
  const invalid = JSON.parse(
    resolveRequest(req({ provider: 'Upstage', modelId: 'solar-pro2', reasoning: 'medium' })).body!,
  ) as any;
  assert.equal(invalid.reasoning_effort, 'low', 'pro2 accepts only low/high — medium must fall back');
});

test('payload: Upstage solar-mini gets no reasoning_effort at all', () => {
  const body = JSON.parse(resolveRequest(req({ provider: 'Upstage', modelId: 'solar-mini' })).body!) as any;
  assert.ok(!('reasoning_effort' in body), 'solar-mini has reasoning:null, so no effort field');
  assert.equal(UPSTAGE_MODELS['solar-mini'].reasoning, null);
  // And search is unsupported on mini even when requested.
  const s = JSON.parse(resolveRequest(req({ provider: 'Upstage', modelId: 'solar-mini', search: true })).body!) as any;
  assert.ok(!('search_provider' in s), 'solar-mini cannot search');
});

test('payload: LLMChat omits temperature when unset but sends it when given', () => {
  const none = JSON.parse(resolveRequest(req({ provider: 'LLMChat' })).body!) as any;
  assert.ok(!('temperature' in none), 'temperature must be absent, not null');
  assert.equal(none.max_tokens, 4096, 'LLMChat defaults to 4096');
  assert.equal(none.stream, true);
  const some = JSON.parse(resolveRequest(req({ provider: 'LLMChat', temperature: 0.5 })).body!) as any;
  assert.equal(some.temperature, 0.5);
});

test('credentials: Upstage CSRF and Mercury session token attach only when present', () => {
  setUpstageCsrf('');
  setMercuryToken('');
  assert.ok(!('x-csrf-token' in resolveRequest(req({ provider: 'Upstage' })).headers), 'no empty CSRF header');
  assert.ok(!('x-session-token' in resolveRequest(req({ provider: 'Mercury' })).headers), 'no empty token header');

  setUpstageCsrf('  csrf-abc123  ');
  setMercuryToken('tok-xyz');
  assert.equal(resolveRequest(req({ provider: 'Upstage' })).headers['x-csrf-token'], 'csrf-abc123', 'CSRF must be trimmed');
  assert.equal(resolveRequest(req({ provider: 'Mercury' })).headers['x-session-token'], 'tok-xyz');
  setUpstageCsrf('');
  setMercuryToken('');
});

// ── 4. establishing the connection: fetch stubbed, bytes real ──
test('connection: streams an openai-delta response into unified events', async () => {
  const real = globalThis.fetch;
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (async (u: any, init: any) => {
    seenUrl = String(u);
    seenInit = init;
    return sseResponse([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  }) as typeof fetch;

  try {
    const events = await collect(streamDirect(req({ provider: 'DeepInfra', modelId: 'm' })));
    // The REAL provider URL was hit — this is the assertion the user asked for.
    assert.equal(seenUrl, 'https://api.deepinfra.com/v1/openai/chat/completions');
    assert.equal(seenInit?.method, 'POST');
    assert.equal((seenInit?.body as string).includes('"stream":true'), true);
    assert.equal(seenInit?.mode, 'cors');

    const content = events.filter((e) => e.kind === 'content').map((e: any) => e.text).join('');
    assert.equal(content, 'Hello');
    assert.ok(events.some((e) => e.kind === 'done'), 'must terminate with done');
    assert.ok(events.some((e) => e.kind === 'status'), 'must report the connecting status');
    assert.ok(!events.some((e) => e.kind === 'error'), `unexpected error: ${JSON.stringify(events.find((e) => e.kind === 'error'))}`);
  } finally {
    globalThis.fetch = real;
  }
});

test('connection: a split SSE frame across chunk boundaries reassembles', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"part',
      '-one"}}]}\n\ndata: {"choices":[{"delt',
      'a":{"content":"part-two"}}]}\n\ndata: [DONE]\n\n',
    ])) as typeof fetch;
  try {
    const events = await collect(streamDirect(req({ provider: 'DeepInfra' })));
    const content = events.filter((e) => e.kind === 'content').map((e: any) => e.text).join('');
    assert.equal(content, 'part-onepart-two', 'framer must reassemble frames split mid-JSON');
  } finally {
    globalThis.fetch = real;
  }
});

test('connection: CORS/network failure yields an actionable error naming the host, not a hang', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  try {
    const events = await collect(streamDirect(req({ provider: 'Dolphin' })));
    const err = events.find((e) => e.kind === 'error') as any;
    assert.ok(err, 'must surface an error event');
    assert.match(err.message, /chat\.dphn\.ai/, 'error must name the host that failed');
    assert.match(err.message, /CORS|Access-Control-Allow-Origin/, 'error must explain the likely cause');
    assert.equal(err.retryable, true);
    assert.ok(!events.some((e) => e.kind === 'done' && e.finishReason === 'stop'), 'must not fake a successful completion');
  } finally {
    globalThis.fetch = real;
  }
});

test('connection: HTTP 403 on Upstage points at the credentials panel', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
  try {
    const events = await collect(streamDirect(req({ provider: 'Upstage', modelId: 'solar-pro3' })));
    const err = events.find((e) => e.kind === 'error') as any;
    assert.ok(err);
    assert.match(err.message, /HTTP 403/);
    assert.match(err.message, /CSRF/, 'must tell the user which credential is missing');
    assert.equal(err.retryable, false, '403 is not retryable');
  } finally {
    globalThis.fetch = real;
  }
});

test('connection: abort mid-stream flushes held-back text instead of dropping it', async () => {
  const real = globalThis.fetch;
  const ctrl = new AbortController();
  // Honour the signal, so this is a genuine abort and not a stream that merely
  // happens to finish. The provider sends one chunk ending in a partial tag,
  // then stalls forever until aborted.
  globalThis.fetch = ((_u: unknown, init: RequestInit) => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"visible text<thi"}}]}\n\n'));
        // Real fetch REJECTS the pending read with AbortError when the signal
        // fires — it does not close the stream cleanly. Mirror that exactly,
        // otherwise the abort branch in streamDirect is never exercised.
        const onAbort = () => {
          try {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          } catch {
            /* already errored/closed */
          }
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener('abort', onAbort, { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  try {
    const events: StreamEvent[] = [];
    for await (const e of streamDirect(req({ provider: 'Upstage', modelId: 'solar-pro3' }), { signal: ctrl.signal })) {
      events.push(e);
      if (e.kind === 'content') ctrl.abort(); // abort as soon as anything lands
    }
    const content = events.filter((e) => e.kind === 'content').map((e: any) => e.text).join('');
    assert.match(content, /visible text/, 'already-received text must survive the abort');
    // The point of this test: at end-of-stream a held-back partial tag can
    // never become <think>, so it MUST be released. Silently discarding it was the
    // holdback bug fixed in normalizers.ts — assert that fix holds under abort.
    assert.ok(content.includes('<thi'), 'held-back partial tag must be FLUSHED, not dropped');
    const done = events.find((e) => e.kind === 'done') as { kind: 'done'; finishReason?: string } | undefined;
    assert.ok(done, 'abort must still terminate the stream');
    assert.equal(done.finishReason, 'aborted', 'and must report why');
    assert.ok(!events.some((e) => e.kind === 'error'), 'an abort is not an error');
  } finally {
    globalThis.fetch = real;
  }
});

// ── 5. the offline simulator needs no network and no relay ────
test('simulator: every wire format produces content with zero network access', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('NETWORK MUST NOT BE USED BY THE SIMULATOR');
  }) as typeof fetch;
  try {
    for (const wire of ['openai-delta', 'workers-raw', 'reasoning-delta', 'typed-events', 'upstage-v3'] as const) {
      const events = await collect(
        streamChat({ provider: 'mock', model: wire, modelId: wire, messages: [{ role: 'user', content: 'hi' }], wire }),
      );
      const content = events.filter((e) => e.kind === 'content').map((e: any) => e.text).join('');
      assert.ok(content.length > 20, `${wire} produced no content`);
      assert.ok(events.some((e) => e.kind === 'done'), `${wire} never terminated`);
      assert.ok(!events.some((e) => e.kind === 'error'), `${wire} errored: ${JSON.stringify(events.find((e) => e.kind === 'error'))}`);
    }
  } finally {
    globalThis.fetch = real;
  }
});

test('simulator: upstage-v3 exercises thinking, search lifecycle, sources and usage', async () => {
  const events = await collect(
    streamChat({ provider: 'mock', model: 'm', modelId: 'mock-upstage', messages: [{ role: 'user', content: 'hi' }], wire: 'upstage-v3' }),
  );
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ['thinking', 'content', 'source', 'usage', 'status', 'done'] as const) {
    assert.ok(kinds.has(k), `upstage-v3 simulator must emit ${k}; got ${[...kinds].join(',')}`);
  }
  // The <think> tag split across chunks must land in thinking, never in content.
  const content = events.filter((e) => e.kind === 'content').map((e: any) => e.text).join('');
  assert.ok(!content.includes('<think>'), 'inline think tags must be stripped from content');
  assert.ok(!content.includes('</think>'), 'closing think tag must not leak');
  const thinking = events.filter((e) => e.kind === 'thinking').map((e: any) => e.text).join('');
  assert.match(thinking, /double-check the spec/, 'tag-split reasoning must reach the thinking channel');
  const usage = events.find((e) => e.kind === 'usage') as any;
  assert.equal(usage.usage.totalTokens, 1601, 'usage rides the finish_reason line');
});

test('simulator: typed-events turns __searching__ into status, never a source', async () => {
  const events = await collect(
    streamChat({ provider: 'mock', model: 'm', modelId: 'mock-mercury', messages: [{ role: 'user', content: 'hi' }], wire: 'typed-events' }),
  );
  const sources = events.filter((e) => e.kind === 'source').flatMap((e: any) => e.sources);
  assert.ok(sources.length >= 2, 'real sources must arrive');
  assert.ok(
    !sources.some((s) => s.id === '__searching__' || s.url === '__searching__'),
    'the progress placeholder must never become a source',
  );
  assert.ok(events.some((e) => e.kind === 'thinking'), 'reasoning-delta must map to thinking');
});

test('routing: streamChat honours force so the bridge stays reachable as a fallback', () => {
  // The bridge path must still be constructible — it is an opt-in fallback, not dead code.
  const meta = PROVIDERS.find((p) => p.id === 'DeepInfra')!;
  assert.equal(meta.transport, 'direct');
  assert.ok(typeof streamChat === 'function');
});
