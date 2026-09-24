import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InceptionClient, InceptionError, SessionManager, SourceCollector, type FetchLike, type StreamEvent } from '../src/core';
// @ts-expect-error — plain-JS test fixture without type declarations
import { startMockInception } from './fixtures/mock-inception.mjs';

/**
 * End-to-end over a real socket against the local protocol simulator: real fetch,
 * real chunked transfer, real cookies (a tiny jar stands in for the browser's).
 */

interface Mock {
  url: string;
  setChallenge(on: boolean): void;
  close(): Promise<void>;
  state: { log: { path: string; status: number }[] };
}

function cookieJarFetch(): FetchLike & { jar: Map<string, string> } {
  const jar = new Map<string, string>();
  const fn: FetchLike = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(input, { ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
    return res;
  };
  return Object.assign(fn, { jar });
}

let mock: Mock;

beforeAll(async () => {
  mock = (await startMockInception({ deltaDelayMs: 2 })) as Mock;
});

afterAll(async () => {
  await mock.close();
});

function makeClient() {
  const fetchImpl = cookieJarFetch();
  const session = new SessionManager({ baseUrl: mock.url, fetch: fetchImpl });
  const client = new InceptionClient({ baseUrl: mock.url, session, getFetch: () => fetchImpl, rateLimitBackoffMs: 5 });
  return { client, session, fetchImpl };
}

async function run(client: InceptionClient, text: string, extra: Partial<Parameters<InceptionClient['chat']>[0]> = {}) {
  const events: StreamEvent[] = [];
  for await (const event of client.chat({ chatId: 'it-chat', turns: [{ role: 'user', text }], thinking: 'medium', webSearch: true, ...extra })) {
    events.push(event);
  }
  const text_ = events.filter((e) => e.type === 'text-delta').map((e) => (e as { delta: string }).delta).join('');
  const reasoning = events.filter((e) => e.type === 'reasoning-delta').map((e) => (e as { delta: string }).delta).join('');
  const sources = new SourceCollector();
  for (const e of events) if (e.type === 'source') sources.add(e.source);
  return { events, text: text_, reasoning, sources: sources.list() };
}

describe('client ↔ protocol simulator', () => {
  it('creates a session (token + cookie) and streams a full answer', async () => {
    const { client, session, fetchImpl } = makeClient();
    await session.refresh();
    expect(session.getState().token).toMatch(/^\d{10}\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(fetchImpl.jar.has('session')).toBe(true);

    const result = await run(client, 'Why is the sky blue?');
    expect(result.reasoning).toContain('Structuring a clear answer.');
    expect(result.text).toContain('## On “Why is the sky blue?”');
    expect(result.text).toContain('नमस्ते 👋 — café ✓');
    expect(result.text).toContain('thinking **medium**');
    expect(result.events.some((e) => e.type === 'searching')).toBe(true);
    expect(result.sources.map((s) => s.url)).toEqual([
      'https://example.org/physics/scattering',
      'https://example.net/atmosphere',
      'https://example.com/light',
    ]);
    expect(result.events.at(-1)).toEqual({ type: 'finish', finishReason: undefined });
  });

  it('honours thinking mode and web search settings', async () => {
    const { client } = makeClient();
    const result = await run(client, 'Quick one', { thinking: 'instant', webSearch: false });
    expect(result.reasoning).toBe('');
    expect(result.sources).toEqual([]);
    expect(result.text).toContain('web search **off**');
  });

  it('surfaces a mid-stream error event and keeps the partial text', async () => {
    const { client } = makeClient();
    const result = await run(client, 'Trigger #error please');
    const error = result.events.find((e) => e.type === 'error');
    expect(error).toEqual({ type: 'error', message: 'Simulated upstream failure' });
    expect(result.text.length).toBeGreaterThan(10);
  });

  it('recovers from 429s with backoff', async () => {
    const { client } = makeClient();
    const result = await run(client, 'Rate limit me #429', { chatId: 'rl-chat' } as never);
    expect(result.text).toContain('End of the simulated answer.');
  });

  it('re-creates the session when the token is rejected', async () => {
    const { client, session } = makeClient();
    await session.refresh();
    // Corrupt the cached token: the server answers 401, the client refreshes and retries.
    (session as unknown as { state: { token: string } }).state.token = '1790000000.deadbeefdeadbeefdeadbeefdeadbeef.x';
    const result = await run(client, 'Still there?');
    expect(result.text).toContain('End of the simulated answer.');
    expect(session.getState().refreshCount).toBe(2);
  });

  it('reports the checkpoint, then works once the site has been visited', async () => {
    mock.setChallenge(true);
    try {
      const { client, session, fetchImpl } = makeClient();
      const error = (await session.refresh().catch((e: unknown) => e)) as InceptionError;
      expect(error.kind).toBe('challenge');
      // "Visit the site" — in the extension this happens in a real tab.
      await fetchImpl(`${mock.url}/`);
      expect(fetchImpl.jar.get('_vcrcs')).toBe('cleared');
      const result = await run(client, 'After the check');
      expect(result.text).toContain('End of the simulated answer.');
    } finally {
      mock.setChallenge(false);
    }
  });

  it('fetches follow-up suggestions for a finished exchange', async () => {
    const { client } = makeClient();
    const result = await run(client, 'Tell me about tides');
    const list = await client.followUps([
      { role: 'user', text: 'Tell me about tides' },
      { role: 'assistant', text: result.text },
    ]);
    expect(list).toHaveLength(3);
    expect(list[0]).toContain('Tell me about tides');
  });

  it('can be stopped mid-answer', async () => {
    const { client } = makeClient();
    const controller = new AbortController();
    let deltas = 0;
    const error = await (async () => {
      for await (const event of client.chat({ chatId: 'stop', turns: [{ role: 'user', text: 'Long one #slow' }], signal: controller.signal, thinking: 'instant', webSearch: false })) {
        if (event.type === 'text-delta' && ++deltas === 2) controller.abort();
      }
    })().catch((e: unknown) => e);
    expect((error as InceptionError).kind).toBe('aborted');
    expect(deltas).toBe(2);
  });
});
