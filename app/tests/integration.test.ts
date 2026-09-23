// ══════════════════════════════════════════════════════════════
//  tests/integration.test.ts — full pipeline, real bridge, no network
//
//  Spawns bridge/server.mjs on a free port, POSTs a ChatRequest for each wire
//  format, and pushes the bytes through the SAME code the browser uses:
//  EnvelopeParser → SSEFramer → normaliser. So this verifies the whole path
//  (bridge envelope, SSE relay, provider parsing, think-tag splitting, source
//  and usage extraction) end to end, with no provider host and no credentials.
//
//  Run: npm test
// ══════════════════════════════════════════════════════════════
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EnvelopeParser } from '../src/lib/envelope.ts';
import { SSEFramer, parseData } from '../src/lib/sse.ts';
import { createNormalizer, createDolphinNormalizer } from '../src/lib/normalizers.ts';
import type { StreamEvent, WireFormat } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, '..', 'bridge', 'server.mjs');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess | null = null;

async function waitForBridge(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/bridge/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('bridge did not become healthy in time');
}

before(async () => {
  proc = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (d) => process.stderr.write(`[bridge:err] ${d}`));
  await waitForBridge();
});

after(() => {
  proc?.kill('SIGTERM');
  proc = null;
});

/** Exactly what src/lib/bridge.ts does, minus the React plumbing. */
async function consume(wire: WireFormat, provider = 'mock'): Promise<{
  events: StreamEvent[];
  meta: { provider?: string; wire?: string } | null;
}> {
  const res = await fetch(`${BASE}/bridge/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider,
      model: 'integration-test',
      modelId: 'integration-test',
      messages: [{ role: 'user', content: 'hello' }],
      wire,
    }),
  });
  assert.equal(res.status, 200, `bridge returned ${res.status}`);
  assert.ok(res.body, 'no response body');

  const envelope = new EnvelopeParser();
  const framer = new SSEFramer();
  const normalizer =
    wire === 'openai-delta' && provider === 'Dolphin' ? createDolphinNormalizer() : createNormalizer(wire);

  const events: StreamEvent[] = [];
  let meta: { provider?: string; wire?: string } | null = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');

  const handleRaw = (chunk: string) => {
    for (const f of framer.push(chunk)) {
      if (f.type === 'done') {
        events.push({ kind: 'done', finishReason: '[DONE]' });
        continue;
      }
      const parsed = parseData(f.payload);
      if (parsed === undefined) continue;
      events.push(...normalizer.push(parsed));
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of envelope.push(decoder.decode(value, { stream: true }))) {
      if (ev.event === 'meta') meta = ev.data as typeof meta;
      else if (ev.event === 'raw') handleRaw((ev.data as { chunk?: string }).chunk ?? '');
      else if (ev.event === 'error') {
        const d = ev.data as { message?: string };
        events.push({ kind: 'error', message: d?.message ?? '?', retryable: false });
      }
    }
  }
  for (const ev of envelope.end()) {
    if (ev.event === 'raw') handleRaw((ev.data as { chunk?: string }).chunk ?? '');
  }
  for (const f of framer.end()) {
    if (f.type === 'data') {
      const parsed = parseData(f.payload);
      if (parsed !== undefined) events.push(...normalizer.push(parsed));
    }
  }
  events.push(...normalizer.end());
  return { events, meta };
}

const collect = (evs: StreamEvent[], kind: string) =>
  evs.filter((e) => e.kind === kind).map((e) => (e as { text?: string }).text ?? '').join('');

// ── health + discovery ──────────────────────────────────────
test('bridge: /bridge/health reports providers and credential state', async () => {
  const res = await fetch(`${BASE}/bridge/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    providers: string[];
    credentials: { Upstage: boolean; Mercury: boolean };
  };
  assert.equal(body.ok, true);
  for (const p of ['mock', 'DeepInfra', 'Dolphin', 'LLMChat', 'Mercury', 'Upstage', 'mCloudFlare']) {
    assert.ok(body.providers.includes(p), `missing provider ${p}`);
  }
  // DevsDo was removed by instruction.
  assert.ok(!body.providers.includes('DevsDo'), 'DevsDo should be gone');
  // No credentials are configured in this sandbox, and the bridge must say so.
  assert.deepEqual(body.credentials, { Upstage: false, Mercury: false });
});

test('bridge: unknown provider returns 404, not a hang', async () => {
  const res = await fetch(`${BASE}/bridge/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'DevsDo', modelId: 'x', messages: [] }),
  });
  assert.equal(res.status, 404);
});

test('bridge: malformed JSON returns 400', async () => {
  const res = await fetch(`${BASE}/bridge/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

// ── every wire format, end to end ───────────────────────────
test('e2e/openai-delta: content assembles and terminates with done', async () => {
  const { events, meta } = await consume('openai-delta');
  assert.equal(meta?.wire, 'openai-delta');
  const content = collect(events, 'content');
  assert.ok(content.length > 100, `content too short: ${content.length}`);
  assert.match(content, /forbidden headers/);
  assert.equal(events.some((e) => e.kind === 'done'), true, 'no done event');
  assert.equal(events.filter((e) => e.kind === 'error').length, 0, 'unexpected error event');
});

test('e2e/workers-raw: bare {"response":…} chunks assemble', async () => {
  const { events, meta } = await consume('workers-raw');
  assert.equal(meta?.wire, 'workers-raw');
  const content = collect(events, 'content');
  assert.ok(content.length > 100, `content too short: ${content.length}`);
  assert.equal(events.filter((e) => e.kind === 'thinking').length, 0, 'workers-raw has no thinking');
  assert.equal(events.some((e) => e.kind === 'done'), true);
});

test('e2e/reasoning-delta: thinking and content arrive on separate channels', async () => {
  const { events, meta } = await consume('reasoning-delta');
  assert.equal(meta?.wire, 'reasoning-delta');
  const thinking = collect(events, 'thinking');
  const content = collect(events, 'content');
  assert.ok(thinking.length > 20, `thinking too short: ${thinking.length}`);
  assert.ok(content.length > 100, `content too short: ${content.length}`);
  // The mock emits one chunk carrying BOTH channels; reasoning must come first.
  const firstThink = events.findIndex((e) => e.kind === 'thinking');
  const firstContent = events.findIndex((e) => e.kind === 'content');
  assert.ok(firstThink < firstContent, 'thinking should start before content');
});

test('e2e/typed-events: Mercury sources arrive, __searching__ becomes a status', async () => {
  const { events, meta } = await consume('typed-events');
  assert.equal(meta?.wire, 'typed-events');
  assert.ok(collect(events, 'thinking').length > 20, 'no reasoning-delta decoded');
  assert.ok(collect(events, 'content').length > 100, 'no text-delta decoded');

  const sources = events.filter((e) => e.kind === 'source');
  assert.equal(sources.length, 2, `expected 2 source events, got ${sources.length}`);
  const urls = sources.flatMap((e) => (e as { sources: { url: string }[] }).sources.map((s) => s.url));
  assert.ok(urls.includes('https://www.w3.org/TR/fetch-metadata/'), 'W3C source missing');
  assert.ok(
    !urls.some((u) => u.includes('__searching__')),
    'the __searching__ placeholder must NOT become a source',
  );
  assert.equal(
    events.some((e) => e.kind === 'status' && e.phase === 'searching'),
    true,
    '__searching__ should surface as a status event',
  );
});

test('e2e/upstage-v3: search lifecycle, split think tags, and usage all survive', async () => {
  const { events, meta } = await consume('upstage-v3');
  assert.equal(meta?.wire, 'upstage-v3');

  // search lifecycle
  const statuses = events.filter((e) => e.kind === 'status') as { phase: string; detail?: string }[];
  assert.ok(statuses.some((s) => s.phase === 'searching'), 'no searching status');
  assert.ok(statuses.some((s) => s.phase === 'summarizing'), 'no summarizing status');
  const searching = statuses.find((s) => s.phase === 'searching');
  assert.ok(searching?.detail?.length, 'search query not carried through');

  // sources
  const sources = events.filter((e) => e.kind === 'source');
  assert.ok(sources.length >= 1, 'no source event');
  assert.ok(
    sources.flatMap((e) => (e as { sources: { url: string }[] }).sources).length >= 3,
    'expected the 3 mock sources',
  );

  // thinking: both the reasoning_content channel AND the inline <think> tags
  const thinking = collect(events, 'thinking');
  assert.ok(thinking.length > 20, `thinking too short: ${thinking.length}`);
  assert.match(thinking, /forbidden/, 'inline <think> content was lost');
  assert.ok(!thinking.includes('<think>'), 'raw <think> tag leaked into output');
  assert.ok(!thinking.includes('</think>'), 'raw </think> tag leaked into output');

  // content must NOT contain leaked markup either
  const content = collect(events, 'content');
  assert.ok(content.length > 100, `content too short: ${content.length}`);
  assert.ok(!content.includes('<think>'), 'raw <think> tag leaked into content');
  assert.match(content, /Short answer/, 'content start lost');
  assert.match(content, /your\* IP/, 'content tail lost — the final token was swallowed');

  // usage, and it must precede done
  const usage = events.find((e) => e.kind === 'usage') as { usage: { totalTokens?: number } } | undefined;
  assert.ok(usage, 'no usage event');
  assert.equal(usage.usage.totalTokens, 1601);
  const ui = events.findIndex((e) => e.kind === 'usage');
  const di = events.findIndex((e) => e.kind === 'done');
  assert.ok(ui < di, 'usage must arrive before done (Python: "done LAST")');
});

// ── abort / cleanup ─────────────────────────────────────────
test('e2e: aborting mid-stream does not wedge the bridge', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/bridge/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'mock', modelId: 'x', messages: [], wire: 'upstage-v3' }),
    signal: ctrl.signal,
  });
  const reader = res.body!.getReader();
  await reader.read(); // take the first chunk, then bail
  ctrl.abort();
  try {
    reader.releaseLock();
  } catch {
    /* fine */
  }

  // The bridge must still serve afterwards.
  await new Promise((r) => setTimeout(r, 250));
  const health = await fetch(`${BASE}/bridge/health`);
  assert.equal(health.status, 200, 'bridge died after an aborted stream');

  // And a subsequent stream must still work.
  const { events } = await consume('openai-delta');
  assert.ok(collect(events, 'content').length > 50, 'bridge broken after abort');
});

test('e2e: credential-gated providers fail loudly instead of hanging', async () => {
  for (const provider of ['Upstage', 'Mercury']) {
    const { events } = await consume('upstage-v3', provider);
    const err = events.find((e) => e.kind === 'error') as { message?: string; retryable?: boolean } | undefined;
    assert.ok(err, `${provider} should report an error without credentials`);
    assert.match(err.message ?? '', /credentials/i, `${provider} error should mention credentials`);
    assert.equal(err.retryable, false, 'a missing-credential error is not retryable');
  }
});
