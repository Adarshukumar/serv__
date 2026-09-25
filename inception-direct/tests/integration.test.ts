import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InceptionClient } from '../src/core/client';
import { InceptionError } from '../src/core/errors';
import type { StreamEvent } from '../src/core/events';
// @ts-expect-error — plain JS test fixture
import { answerFor, startMockInception } from './fixtures/mock-inception.mjs';
import { collect } from './helpers';

interface Mock {
  url: string;
  state: {
    requests: { kind: string; model: string; effort?: string; diffusing: boolean; includeUsage: boolean; reasoningSummary: boolean; maxTokens?: number; roles: string[] }[];
    log: { method: string; path: string; status: number }[];
  };
  close(): Promise<void>;
}

let mock: Mock;
beforeAll(async () => {
  mock = (await startMockInception({ blockDelayMs: 1 })) as Mock;
});
afterAll(async () => {
  await mock.close();
});

const make = (key: string | null = 'test-key') => new InceptionClient({ apiUrl: mock.url, getKey: () => key, retryBaseMs: 5 });
const text = (events: StreamEvent[]) => events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');

async function failure(promise: Promise<unknown>): Promise<InceptionError> {
  try {
    await promise;
  } catch (error) {
    return error as InceptionError;
  }
  throw new Error('expected a failure');
}

describe('client ↔ API simulator, over a real socket', () => {
  it('lists models', async () => {
    const models = await make(null).models();
    expect(models.map((m) => m.id)).toEqual(['mercury-2.5', 'mercury-2']);
  });

  it('handshake: good key → ok; wrong key → auth; broke key → billing', async () => {
    await expect(make().verify('mercury-2.5')).resolves.toMatchObject({ model: 'mercury-2.5' });
    expect((await failure(make('wrong').verify('mercury-2.5'))).kind).toBe('auth');
    expect((await failure(make('broke-key').verify('mercury-2.5'))).kind).toBe('billing');
    expect((await failure(make().verify('mercury-9'))).kind).toBe('model');
  });

  it('streams a full answer with history + system, and the request is exactly as documented', async () => {
    const turns = [
      { role: 'user' as const, text: 'Earlier question' },
      { role: 'assistant' as const, text: 'Earlier answer' },
      { role: 'user' as const, text: 'Why is the sky blue?' },
    ];
    const events = await collect(
      make().chat({ model: 'mercury-2.5', turns, system: 'Be concise.', effort: 'low', maxTokens: 16384, reasoningSummary: true }),
    );
    const request = mock.state.requests.at(-1)!;
    expect(request).toMatchObject({ kind: 'chat', model: 'mercury-2.5', effort: 'low', includeUsage: true, reasoningSummary: true, maxTokens: 16384 });
    expect(request.roles).toEqual(['system', 'user', 'assistant', 'user']);

    const expected = answerFor(
      { model: 'mercury-2.5', reasoning_effort: 'low', messages: [{ role: 'system' }, {}, {}, {}] },
      'Why is the sky blue?',
    ) as string;
    expect(text(events)).toBe(expected);
    expect(text(events)).toContain('नमस्ते 👋 — café ✓');
    expect(events).toContainEqual({ type: 'finish', reason: 'stop' });
    expect(events.some((e) => e.type === 'reasoning-summary')).toBe(true);
    const usage = events.find((e) => e.type === 'usage') as { usage: { reasoningTokens: number } } | undefined;
    expect(usage?.usage.reasoningTokens).toBe(60);
  });

  it('diffusing: canvases converge on the final answer', async () => {
    const events = await collect(make().chat({ model: 'mercury-2', turns: [{ role: 'user', text: 'Diffuse please' }], effort: 'instant', diffusing: true, maxTokens: 4096 }));
    const canvases = events.filter((e) => e.type === 'canvas').map((e) => (e as { text: string }).text);
    expect(canvases.length).toBeGreaterThan(5);
    expect(canvases.at(-1)).toContain('End of the simulated answer.');
    expect(canvases[1]).not.toBe(canvases.at(-1)); // early steps are still noisy
    expect(mock.state.requests.at(-1)).toMatchObject({ diffusing: true, effort: 'instant', reasoningSummary: false });
  });

  it('recovers from 429 ×2 and a 503 on its own', async () => {
    const limited = await collect(make().chat({ model: 'mercury-2.5', turns: [{ role: 'user', text: 'Busy #429' }], maxTokens: 4096 }));
    expect(text(limited)).toContain('End of the simulated answer.');
    const overloaded = await collect(make().chat({ model: 'mercury-2.5', turns: [{ role: 'user', text: 'Busy #503' }], maxTokens: 4096 }));
    expect(text(overloaded)).toContain('End of the simulated answer.');
    const statuses = mock.state.log.filter((l) => l.path === '/v1/chat/completions').map((l) => l.status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    expect(statuses.filter((s) => s === 503)).toHaveLength(1);
  });

  it('reports an error sent inside the stream, a dropped connection, and a length stop', async () => {
    const errored = await collect(make().chat({ model: 'mercury-2.5', turns: [{ role: 'user', text: 'Fail #error' }], maxTokens: 4096 }));
    expect(errored).toContainEqual({ type: 'error', message: 'Simulated upstream failure', code: 'server_error' });

    const dropped = await failure(collect(make().chat({ model: 'mercury-2.5', turns: [{ role: 'user', text: 'Cut #drop' }], maxTokens: 4096 })));
    expect(dropped.kind).toBe('stream');

    const long = await collect(make().chat({ model: 'mercury-2.5', turns: [{ role: 'user', text: 'Long #length' }], maxTokens: 4096 }));
    expect(long).toContainEqual({ type: 'finish', reason: 'length' });
  });

  it('stops a slow stream on abort', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const err = await failure(
      (async () => {
        let n = 0;
        for await (const e of make().chat({ model: 'mercury-2.5', turns: [{ role: 'user', text: 'Slow #slow' }], maxTokens: 4096, signal: controller.signal })) {
          if (e.type === 'delta' && ++n === 2) controller.abort();
        }
      })(),
    );
    expect(err.kind).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('follow-ups via structured output', async () => {
    const list = await make().followUps('mercury-2.5', [
      { role: 'user', text: 'Why is the sky blue?' },
      { role: 'assistant', text: 'Scattering.' },
    ]);
    expect(list).toHaveLength(3);
    expect(mock.state.requests.at(-1)!.kind).toBe('follow-ups');
  });

  it('the simulator is strict: unknown parameters are refused (catches client drift)', async () => {
    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'mercury-2.5', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'high' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/reasoningEffort/);
  });
});

describe('CORS, as the live API answers it', () => {
  const origin = 'https://4173-example.e2b.app';

  it('a real preflight for Authorization + Content-Type is allowed', async () => {
    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('a bare OPTIONS is a 405 — but still carries the reflected origin (seen live)', async () => {
    const res = await fetch(`${mock.url}/v1/chat/completions`, { method: 'OPTIONS', headers: { origin } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('responses reflect the page origin', async () => {
    const res = await fetch(`${mock.url}/v1/models`, { headers: { origin } });
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
