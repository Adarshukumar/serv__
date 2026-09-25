import { describe, expect, it, vi } from 'vitest';
import { InceptionClient, parseModels, type ClientOptions, type RetryInfo } from '../src/core/client';
import { InceptionError } from '../src/core/errors';
import type { StreamEvent } from '../src/core/events';
import {
  apiErrorResponse,
  bodyOf,
  byteChunks,
  chunk,
  collect,
  encoder,
  headersOf,
  jsonResponse,
  mockFetch,
  sse,
  streamResponse,
  usageChunk,
} from './helpers';

const API = 'https://api.example.test';

function client(fetch: ClientOptions['fetch'], extra: Partial<ClientOptions> = {}) {
  return new InceptionClient({ apiUrl: API, getKey: () => 'sk_test', fetch, retryBaseMs: 2, ...extra });
}

const turns = [{ role: 'user' as const, text: 'Why is the sky blue?' }];
const chatOptions = { model: 'mercury-2.5', turns, maxTokens: 16384 };

function answerStream(text: string, finish = 'stop'): string {
  const words = text.match(/\S+\s*/g) ?? [];
  return [
    sse(chunk('')),
    ...words.map((w) => sse(chunk(w))),
    sse(chunk(null, finish, { reasoning_summary: { content: 'Considered scattering.', status: 'complete' } })),
    sse(usageChunk(12, 30, 9)),
    sse('[DONE]'),
  ].join('');
}

const textOf = (events: StreamEvent[]) =>
  events
    .filter((e): e is Extract<StreamEvent, { type: 'delta' }> => e.type === 'delta')
    .map((e) => e.text)
    .join('');

async function failure(promise: Promise<unknown>): Promise<InceptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InceptionError);
    return error as InceptionError;
  }
  throw new Error('expected a failure');
}

describe('InceptionClient.chat', () => {
  it('posts the documented request straight to the API, with the key, and streams the answer', async () => {
    const fetch = mockFetch(() => streamResponse([encoder.encode(answerStream('Rayleigh scattering, mostly.'))]));
    const events = await collect(client(fetch).chat({ ...chatOptions, system: 'Be brief.', effort: 'high', reasoningSummary: true }));

    expect(fetch.calls).toHaveLength(1);
    const { url, init } = fetch.calls[0]!;
    expect(url).toBe(`${API}/v1/chat/completions`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(headersOf(init)).toEqual({ accept: 'text/event-stream', 'content-type': 'application/json', authorization: 'Bearer sk_test' });
    expect(bodyOf(init)).toEqual({
      model: 'mercury-2.5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Why is the sky blue?' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
      max_completion_tokens: 16384,
      reasoning_summary: true,
    });

    expect(textOf(events)).toBe('Rayleigh scattering, mostly.');
    expect(events.filter((e) => e.type === 'meta')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'finish', reason: 'stop' });
    expect(events).toContainEqual({ type: 'reasoning-summary', summary: { content: 'Considered scattering.', status: 'complete' } });
    expect(events).toContainEqual({ type: 'usage', usage: { promptTokens: 12, completionTokens: 30, totalTokens: 42, reasoningTokens: 9, cachedTokens: 0 } });
  });

  it('survives any chunking: one byte at a time, multi-byte characters split', async () => {
    const text = 'नमस्ते 👋 — café ✓ and $e^{i\\pi}$';
    const fetch = mockFetch(() => streamResponse(byteChunks(answerStream(text), 1)));
    expect(textOf(await collect(client(fetch).chat(chatOptions)))).toBe(text);
  });

  it('diffusing: every chunk is the whole canvas', async () => {
    const body = [sse(chunk('Tqe skq is blze')), sse(chunk('The sky is blze')), sse(chunk('The sky is blue.')), sse(chunk(null, 'stop')), sse('[DONE]')].join('');
    const fetch = mockFetch(() => streamResponse([encoder.encode(body)]));
    const events = await collect(client(fetch).chat({ ...chatOptions, diffusing: true }));
    expect(bodyOf(fetch.calls[0]!.init).diffusing).toBe(true);
    expect(events.filter((e) => e.type === 'canvas').map((e) => (e as { text: string }).text)).toEqual(['Tqe skq is blze', 'The sky is blze', 'The sky is blue.']);
  });

  it('retries 429 and 503 with backoff, then streams', async () => {
    const retries: RetryInfo[] = [];
    const fetch = mockFetch((_, __, call) =>
      call === 1
        ? apiErrorResponse(429, 'Rate limit exceeded. Please try again later.', 'rate_limit_reached', 'rate_limit_error')
        : call === 2
          ? apiErrorResponse(503, 'Engine overloaded', 'engine_overloaded', 'server_error')
          : streamResponse([encoder.encode(answerStream('ok'))]),
    );
    const events = await collect(client(fetch, { onRetry: (info) => retries.push(info) }).chat(chatOptions));
    expect(textOf(events)).toBe('ok');
    expect(fetch.calls).toHaveLength(3);
    expect(retries.map((r) => [r.attempt, r.kind, r.status])).toEqual([
      [1, 'rate-limit', 429],
      [2, 'overloaded', 503],
    ]);
  });

  it('gives up after the retry budget with a rate-limit error', async () => {
    const fetch = mockFetch(() => apiErrorResponse(429, 'Rate limit exceeded. Please try again later.', 'rate_limit_reached', 'rate_limit_error'));
    const err = await failure(collect(client(fetch, { retryAttempts: 2 }).chat(chatOptions)));
    expect(err.kind).toBe('rate-limit');
    expect(err.retryable).toBe(true);
    expect(fetch.calls).toHaveLength(3);
  });

  it.each([
    [401, 'Incorrect API key provided', 'invalid_api_key', 'auth'],
    [402, 'Account is inactive', 'account_error', 'billing'],
    [404, 'model `jupyter-2` not found', 'model_not_found', 'model'],
  ] as const)('%i is final (no retry) → %s', async (status, message, code, kind) => {
    const fetch = mockFetch(() => apiErrorResponse(status, message, code));
    const err = await failure(collect(client(fetch).chat(chatOptions)));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.detail).toContain(message);
    expect(fetch.calls).toHaveLength(1);
  });

  it('400 carries the API’s own explanation as the message', async () => {
    const msg = 'You exceeded the maximum context length for this model of 128000. Please reduce the length of the messages or completion.';
    const fetch = mockFetch(() => apiErrorResponse(400, msg, 'context_length_exceeded'));
    const err = await failure(collect(client(fetch).chat(chatOptions)));
    expect(err.kind).toBe('invalid');
    expect(err.message).toBe(msg);
    expect(err.code).toBe('context_length_exceeded');
  });

  it('a network failure is retried once, then reported with a hint', async () => {
    const fetch = mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const err = await failure(collect(client(fetch).chat(chatOptions)));
    expect(err.kind).toBe('network');
    expect(err.message).toBe('Couldn’t reach api.example.test.');
    expect(err.detail).toMatch(/connection|offline/i);
    expect(fetch.calls).toHaveLength(2);
  });

  it('needs a key — and sends nothing without one', async () => {
    const fetch = mockFetch(() => jsonResponse({}));
    const err = await failure(collect(new InceptionClient({ apiUrl: API, getKey: () => null, fetch }).chat(chatOptions)));
    expect(err.kind).toBe('no-key');
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses to send a conversation that does not end with a question', async () => {
    const fetch = mockFetch(() => jsonResponse({}));
    const err = await failure(collect(client(fetch).chat({ ...chatOptions, turns: [{ role: 'assistant', text: 'hi' }] })));
    expect(err.kind).toBe('protocol');
    expect(fetch.calls).toHaveLength(0);
  });

  it('stops promptly when aborted mid-stream and releases the connection', async () => {
    const onCancel = vi.fn();
    const frames = Array.from({ length: 50 }, (_, i) => encoder.encode(sse(chunk(`w${i} `))));
    const fetch = mockFetch(() => streamResponse(frames, undefined, { delayMs: 5, onCancel }));
    const controller = new AbortController();
    const seen: string[] = [];
    const err = await failure(
      (async () => {
        for await (const e of client(fetch).chat({ ...chatOptions, signal: controller.signal })) {
          if (e.type === 'delta') seen.push(e.text);
          if (seen.length === 3) controller.abort();
        }
      })(),
    );
    expect(err.kind).toBe('aborted');
    expect(seen).toHaveLength(3);
    expect(onCancel).toHaveBeenCalled();
  });

  it('a connection that drops mid-answer is a stream error (retryable)', async () => {
    const fetch = mockFetch(() => streamResponse([encoder.encode(sse(chunk('Half ')))], undefined, { failAfter: 1 }));
    const seen: StreamEvent[] = [];
    const err = await failure(
      (async () => {
        for await (const e of client(fetch).chat(chatOptions)) seen.push(e);
      })(),
    );
    expect(textOf(seen)).toBe('Half ');
    expect(err.kind).toBe('stream');
    expect(err.retryable).toBe(true);
  });

  it('a stream that ends without finish_reason or [DONE] was cut off', async () => {
    const fetch = mockFetch(() => streamResponse([encoder.encode(sse(chunk('Partial answer')))]));
    const err = await failure(collect(client(fetch).chat(chatOptions)));
    expect(err.kind).toBe('stream');
    expect(err.message).toMatch(/cut off/);
  });

  it('an in-stream error is an event, not a cut-off', async () => {
    const body = sse(chunk('Some ')) + sse({ error: { message: 'Simulated upstream failure', type: 'server_error', code: 'server_error' } });
    const fetch = mockFetch(() => streamResponse([encoder.encode(body)]));
    const events = await collect(client(fetch).chat(chatOptions));
    expect(events).toContainEqual({ type: 'error', message: 'Simulated upstream failure', code: 'server_error' });
  });

  it('a stream that goes silent times out', async () => {
    const fetch = mockFetch(() => streamResponse([encoder.encode(sse(chunk('Hello ')))], undefined, { stallAfter: 1 }));
    const err = await failure(collect(client(fetch, { idleTimeoutMs: 60 }).chat(chatOptions)));
    expect(err.kind).toBe('stream');
    expect(err.message).toMatch(/timed out/);
  });

  it('a request whose headers never arrive times out', async () => {
    const fetch = mockFetch(
      (_, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const err = await failure(collect(client(fetch, { responseTimeoutMs: 50 }).chat(chatOptions)));
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/in time/);
  });
});

describe('InceptionClient.verify (start-up handshake)', () => {
  it('sends one tiny real completion and measures the round trip', async () => {
    const fetch = mockFetch(() =>
      jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'mercury-2.5', choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'H' } }], usage: {} }),
    );
    const result = await client(fetch).verify('mercury-2.5');
    expect(result.model).toBe('mercury-2.5');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const { init } = fetch.calls[0]!;
    expect(headersOf(init).accept).toBe('application/json');
    expect(bodyOf(init)).toMatchObject({ max_completion_tokens: 1, reasoning_effort: 'instant', stream: false });
  });

  it('reports a rejected key as auth', async () => {
    const fetch = mockFetch(() => apiErrorResponse(401, 'Incorrect API key provided', 'invalid_api_key', 'authentication_error'));
    expect((await failure(client(fetch).verify('mercury-2.5'))).kind).toBe('auth');
  });

  it('treats a non-completion 200 as a protocol error', async () => {
    const fetch = mockFetch(() => new Response('<html>captive portal</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect((await failure(client(fetch).verify('mercury-2.5'))).kind).toBe('protocol');
  });
});

describe('models and follow-ups', () => {
  it('lists chat models newest first, without sending the key', async () => {
    const fetch = mockFetch(() =>
      jsonResponse({
        data: [
          { id: 'mercury-2', name: 'Inception: Mercury 2', context_length: 128000, max_output_length: 50000, pricing: { prompt: '0.00000025', completion: '0.00000075' }, output_modalities: ['text'] },
          { id: 'mercury-edit-2', name: 'Inception: Mercury Edit 2', output_modalities: ['text'] },
          { id: 'mercury-2.5', name: 'Inception: Mercury 2.5', context_length: 260000, max_output_length: 65536, pricing: { prompt: '0.00000004', completion: '0.00000015' } },
        ],
      }),
    );
    const models = await client(fetch).models();
    expect(models.map((m) => [m.id, m.name])).toEqual([
      ['mercury-2.5', 'Mercury 2.5'],
      ['mercury-2', 'Mercury 2'],
    ]);
    expect(models[0]).toMatchObject({ contextLength: 260000, maxOutput: 65536, pricing: { prompt: 0.00000004, completion: 0.00000015 } });
    expect(fetch.calls[0]!.url).toBe(`${API}/v1/models`);
    expect(headersOf(fetch.calls[0]!.init).authorization).toBeUndefined();
  });

  it('an empty or broken list is an error (the app keeps its built-in list)', async () => {
    await failure(client(mockFetch(() => jsonResponse({ data: [] }))).models());
    expect(parseModels({ nope: true })).toEqual([]);
  });

  it('follow-ups come from a structured-output request; failures give []', async () => {
    const fetch = mockFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: '{"follow_ups":["What about Mars?","Why red at sunset?","Same on the Moon?"]}' }, finish_reason: 'stop' }] }),
    );
    const list = await client(fetch).followUps('mercury-2.5', [
      { role: 'user', text: 'Q' },
      { role: 'assistant', text: 'A' },
    ]);
    expect(list).toEqual(['What about Mars?', 'Why red at sunset?', 'Same on the Moon?']);
    expect((bodyOf(fetch.calls[0]!.init).response_format as { type: string }).type).toBe('json_schema');

    const broken = mockFetch(() => apiErrorResponse(500, 'boom', 'server_error', 'server_error'));
    expect(await client(broken).followUps('mercury-2.5', [{ role: 'user', text: 'Q' }])).toEqual([]);
    expect(broken.calls).toHaveLength(1); // no retries for a nice-to-have
  });
});
