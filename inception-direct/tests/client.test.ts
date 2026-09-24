import { describe, expect, it } from 'vitest';
import { InceptionClient } from '../src/core/client';
import { InceptionError } from '../src/core/errors';
import type { StreamEvent } from '../src/core/events';
import { SessionManager } from '../src/core/session';
import { TOKEN, byteChunks, checkpointResponse, collect, encoder, jsonResponse, mockFetch, sse, streamResponse } from './helpers';

const BASE = 'https://chat.inceptionlabs.ai';

function setup(chat: (init: RequestInit, call: number) => Response | Promise<Response>, options: { tokens?: string[] } = {}) {
  let sessionCalls = 0;
  let chatCalls = 0;
  const tokens = options.tokens ?? [TOKEN];
  const fetchImpl = mockFetch((url, init) => {
    if (url.pathname === '/api/session') {
      const token = tokens[Math.min(sessionCalls, tokens.length - 1)]!;
      sessionCalls++;
      return jsonResponse({ ok: true, token });
    }
    if (url.pathname === '/api/chat') return chat(init, ++chatCalls);
    if (url.pathname === '/api/follow-ups') return jsonResponse({ follow_ups: ['What next?', ' And then? ', '', 42] });
    return new Response('not found', { status: 404 });
  });
  const session = new SessionManager({ baseUrl: BASE, fetch: fetchImpl });
  const retries: unknown[] = [];
  const client = new InceptionClient({
    baseUrl: BASE,
    session,
    getFetch: () => fetchImpl,
    rateLimitBackoffMs: 5,
    onRetry: (info) => retries.push(info),
  });
  return { client, fetchImpl, session, retries, counts: () => ({ sessionCalls, chatCalls }) };
}

const TURNS = [{ id: 'u1', role: 'user' as const, text: 'Why is the sky blue?' }];

const FULL_STREAM = [
  sse({ type: 'start', messageId: 'msg1' }),
  sse({ type: 'start-step' }),
  sse({ type: 'reasoning-start', id: 'r0' }),
  sse({ type: 'reasoning-delta', id: 'r0', delta: 'Rayleigh ' }),
  sse({ type: 'reasoning-delta', id: 'r0', delta: 'scattering.' }),
  sse({ type: 'reasoning-end', id: 'r0' }),
  sse({ type: 'source-url', sourceId: 's0', url: '', title: '__searching__' }),
  sse({ type: 'source-url', sourceId: 's1', url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering', title: 'Rayleigh scattering' }),
  sse({ type: 'source-url', sourceId: 's2', url: 'https://www.nasa.gov/sky', title: 'NASA' }),
  sse({ type: 'source-url', sourceId: 's3', url: 'https://www.weather.gov/sky', title: 'NWS' }),
  sse({ type: 'text-start', id: 't0' }),
  sse({ type: 'text-delta', id: 't0', delta: 'Short wavelengths ' }),
  sse({ type: 'text-delta', id: 't0', delta: 'scatter more. नमस्ते 👋' }),
  sse({ type: 'text-end', id: 't0' }),
  sse({ type: 'finish-step' }),
  sse({ type: 'finish' }),
  sse('[DONE]'),
].join('');

describe('InceptionClient.chat', () => {
  it('sends the web app’s request and streams typed events in order', async () => {
    const { client, fetchImpl } = setup(() => streamResponse([encoder.encode(FULL_STREAM)]));
    const events = await collect(client.chat({ chatId: 'chat1', turns: TURNS, thinking: 'high', webSearch: true, timezone: 'Asia/Calcutta' }));

    const chatCall = fetchImpl.calls.find((c) => c.url.endsWith('/api/chat'))!;
    expect(chatCall.init.method).toBe('POST');
    expect(chatCall.init.credentials).toBe('include');
    expect(chatCall.init.headers).toMatchObject({ 'Content-Type': 'application/json', 'x-session-token': TOKEN });
    expect(JSON.parse(chatCall.init.body as string)).toEqual({
      reasoningEffort: 'high',
      webSearchEnabled: true,
      voiceMode: false,
      timezone: 'Asia/Calcutta',
      id: 'chat1',
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Why is the sky blue?' }] }],
      trigger: 'submit-message',
    });

    expect(events).toEqual<StreamEvent[]>([
      { type: 'start', messageId: 'msg1' },
      { type: 'reasoning-delta', delta: 'Rayleigh ' },
      { type: 'reasoning-delta', delta: 'scattering.' },
      { type: 'searching' },
      { type: 'source', source: { id: 's1', url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering', title: 'Rayleigh scattering' } },
      { type: 'source', source: { id: 's2', url: 'https://www.nasa.gov/sky', title: 'NASA' } },
      { type: 'source', source: { id: 's3', url: 'https://www.weather.gov/sky', title: 'NWS' } },
      { type: 'text-delta', delta: 'Short wavelengths ' },
      { type: 'text-delta', delta: 'scatter more. नमस्ते 👋' },
      { type: 'finish', finishReason: undefined },
    ]);
  });

  it('keeps multi-byte characters intact when every network chunk is a single byte', async () => {
    const stream = sse({ type: 'text-delta', id: 't', delta: 'नमस्ते 👋 — café ✓' }) + sse('[DONE]');
    const { client } = setup(() => streamResponse(byteChunks(stream, 1)));
    const events = await collect(client.chat({ chatId: 'c', turns: TURNS }));
    expect(events).toEqual([{ type: 'text-delta', delta: 'नमस्ते 👋 — café ✓' }]);
  });

  it('streams incrementally (events arrive before the response finishes)', async () => {
    const chunks = [
      encoder.encode(sse({ type: 'text-delta', id: 't', delta: 'one ' })),
      encoder.encode(sse({ type: 'text-delta', id: 't', delta: 'two' })),
      encoder.encode(sse('[DONE]')),
    ];
    const { client } = setup(() => streamResponse(chunks, undefined, { delayMs: 30 }));
    const started = Date.now();
    const seenAt: number[] = [];
    for await (const event of client.chat({ chatId: 'c', turns: TURNS })) {
      if (event.type === 'text-delta') seenAt.push(Date.now() - started);
    }
    expect(seenAt).toHaveLength(2);
    expect(seenAt[1]! - seenAt[0]!).toBeGreaterThanOrEqual(20);
  });

  it('surfaces error events from the stream', async () => {
    const stream = sse({ type: 'text-delta', id: 't', delta: 'Partial' }) + sse({ type: 'error', errorText: 'Upstream model error' }) + sse('[DONE]');
    const { client } = setup(() => streamResponse([encoder.encode(stream)]));
    const events = await collect(client.chat({ chatId: 'c', turns: TURNS }));
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Partial' },
      { type: 'error', message: 'Upstream model error' },
    ]);
  });

  it('retries 429 with backoff, like the web app', async () => {
    const { client, retries, counts } = setup((_, call) =>
      call < 3 ? jsonResponse({ error: 'slow down' }, 429) : streamResponse([encoder.encode(sse({ type: 'text-delta', delta: 'ok' }) + sse('[DONE]'))]),
    );
    const events = await collect(client.chat({ chatId: 'c', turns: TURNS }));
    expect(events).toEqual([{ type: 'text-delta', delta: 'ok' }]);
    expect(counts().chatCalls).toBe(3);
    expect(retries).toEqual([
      { reason: 'rate-limit', attempt: 1, delayMs: 5 },
      { reason: 'rate-limit', attempt: 2, delayMs: 10 },
    ]);
  });

  it('gives up with a rate-limit error after the retries', async () => {
    const { client, counts } = setup(() => jsonResponse({ error: 'slow down' }, 429));
    const error = (await collect(client.chat({ chatId: 'c', turns: TURNS })).catch((e: unknown) => e)) as InceptionError;
    expect(error.kind).toBe('rate-limit');
    expect(counts().chatCalls).toBe(3);
  });

  it('re-creates the session once on 401 and retries with the new token', async () => {
    const seenTokens: string[] = [];
    const { client, counts } = setup(
      (init, call) => {
        seenTokens.push((init.headers as Record<string, string>)['x-session-token']!);
        return call === 1 ? jsonResponse({ error: 'expired' }, 401) : streamResponse([encoder.encode(sse({ type: 'text-delta', delta: 'fresh' }) + sse('[DONE]'))]);
      },
      { tokens: ['first-token-aaaa', 'second-token-bbbb'] },
    );
    const events = await collect(client.chat({ chatId: 'c', turns: TURNS }));
    expect(events).toEqual([{ type: 'text-delta', delta: 'fresh' }]);
    expect(seenTokens).toEqual(['first-token-aaaa', 'second-token-bbbb']);
    expect(counts().sessionCalls).toBe(2);
  });

  it('reports auth failure when the retry is refused too', async () => {
    const { client } = setup(() => jsonResponse({ error: 'forbidden' }, 403));
    const error = (await collect(client.chat({ chatId: 'c', turns: TURNS })).catch((e: unknown) => e)) as InceptionError;
    expect(error.kind).toBe('auth');
    expect(error.status).toBe(403);
  });

  it('throws a challenge error when the checkpoint answers the chat request', async () => {
    const { client } = setup(() => checkpointResponse());
    const error = (await collect(client.chat({ chatId: 'c', turns: TURNS })).catch((e: unknown) => e)) as InceptionError;
    expect(error).toBeInstanceOf(InceptionError);
    expect(error.kind).toBe('challenge');
  });

  it('includes the server’s message for other HTTP errors', async () => {
    const { client } = setup(() => jsonResponse({ error: 'Invalid request body' }, 400));
    const error = (await collect(client.chat({ chatId: 'c', turns: TURNS })).catch((e: unknown) => e)) as InceptionError;
    expect(error.kind).toBe('http');
    expect(error.message).toContain('400');
    expect(error.message).toContain('Invalid request body');
  });

  it('stops promptly and cancels the body when aborted mid-stream', async () => {
    let cancelled = false;
    const chunks = Array.from({ length: 50 }, (_, i) => encoder.encode(sse({ type: 'text-delta', delta: `w${i} ` })));
    const { client } = setup(() => streamResponse(chunks, undefined, { delayMs: 10, onCancel: () => (cancelled = true) }));
    const controller = new AbortController();
    const seen: string[] = [];
    const error = await (async () => {
      for await (const event of client.chat({ chatId: 'c', turns: TURNS, signal: controller.signal })) {
        if (event.type === 'text-delta') seen.push(event.delta);
        if (seen.length === 3) controller.abort();
      }
    })().catch((e: unknown) => e);
    expect((error as InceptionError).kind).toBe('aborted');
    expect(seen.length).toBeLessThan(6);
    expect(cancelled).toBe(true);
  });

  it('treats a connection that drops mid-answer as a retryable stream error, keeping what arrived', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode(sse({ type: 'text-delta', delta: 'Half an ans' })));
        } else controller.error(new TypeError('network error'));
      },
    });
    const { client } = setup(() => new Response(body, { status: 200 }));
    const seen: StreamEvent[] = [];
    const error = await (async () => {
      for await (const event of client.chat({ chatId: 'c', turns: TURNS })) seen.push(event);
    })().catch((e: unknown) => e);
    expect(seen).toEqual([{ type: 'text-delta', delta: 'Half an ans' }]);
    expect((error as InceptionError).kind).toBe('stream');
  });

  it('maps fetch failures to a network error', async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.pathname === '/api/session') return jsonResponse({ ok: true, token: TOKEN });
      throw new TypeError('Failed to fetch');
    });
    const session = new SessionManager({ baseUrl: BASE, fetch: fetchImpl });
    const client = new InceptionClient({ baseUrl: BASE, session, getFetch: () => fetchImpl });
    const error = (await collect(client.chat({ chatId: 'c', turns: TURNS })).catch((e: unknown) => e)) as InceptionError;
    expect(error.kind).toBe('network');
  });

  it('refuses to send when the last turn is not from the user', async () => {
    const { client } = setup(() => streamResponse([]));
    const error = (await collect(client.chat({ chatId: 'c', turns: [{ role: 'assistant', text: 'hi' }] })).catch((e: unknown) => e)) as InceptionError;
    expect(error.kind).toBe('protocol');
  });
});

describe('InceptionClient.followUps', () => {
  it('posts the exchange and returns clean suggestions', async () => {
    const { client, fetchImpl } = setup(() => streamResponse([]));
    const list = await client.followUps([
      { role: 'user', text: 'Q' },
      { role: 'assistant', text: 'A' },
    ]);
    expect(list).toEqual(['What next?', 'And then?']);
    const call = fetchImpl.calls.find((c) => c.url.endsWith('/api/follow-ups'))!;
    expect(JSON.parse(call.init.body as string)).toEqual({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Q' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'A', state: 'done' }] },
      ],
    });
  });

  it('returns [] on failure', async () => {
    const fetchImpl = mockFetch((url) => (url.pathname === '/api/session' ? jsonResponse({ ok: true, token: TOKEN }) : jsonResponse({}, 500)));
    const session = new SessionManager({ baseUrl: BASE, fetch: fetchImpl });
    const client = new InceptionClient({ baseUrl: BASE, session, getFetch: () => fetchImpl });
    await expect(
      client.followUps([
        { role: 'user', text: 'Q' },
        { role: 'assistant', text: 'A' },
      ]),
    ).resolves.toEqual([]);
  });
});
