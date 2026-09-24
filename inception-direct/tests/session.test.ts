import { describe, expect, it } from 'vitest';
import { InceptionError } from '../src/core/errors';
import { SessionManager, parseIssuedAt } from '../src/core/session';
import { TOKEN, checkpointResponse, jsonResponse, mockFetch } from './helpers';

const BASE = 'https://chat.inceptionlabs.ai';

function manager(fetchImpl: ReturnType<typeof mockFetch>, now = () => 1_000_000) {
  return new SessionManager({ baseUrl: BASE, fetch: fetchImpl, now, maxAgeMs: 12 * 60_000 });
}

describe('SessionManager', () => {
  it('creates a session with GET /api/session and exposes the token', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ ok: true, token: TOKEN }));
    const session = manager(fetchImpl);
    await expect(session.refresh()).resolves.toBe(TOKEN);
    expect(fetchImpl.calls[0]!.url).toBe(`${BASE}/api/session`);
    expect(fetchImpl.calls[0]!.init.method).toBe('GET');
    expect(fetchImpl.calls[0]!.init.credentials).toBe('include');
    const state = session.getState();
    expect(state.status).toBe('live');
    expect(state.token).toBe(TOKEN);
    expect(state.issuedAt).toBe(1790265903 * 1000);
    expect(state.refreshCount).toBe(1);
  });

  it('is single-flight: concurrent callers share one request', async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = mockFetch(() => new Promise<Response>((r) => (resolve = r)));
    const session = manager(fetchImpl);
    const all = Promise.all([session.ensure(), session.ensure(), session.refresh()]);
    await Promise.resolve();
    resolve(jsonResponse({ ok: true, token: TOKEN }));
    await expect(all).resolves.toEqual([TOKEN, TOKEN, TOKEN]);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('reuses a fresh token and refreshes a stale one', async () => {
    let now = 0;
    let n = 0;
    const fetchImpl = mockFetch(() => jsonResponse({ ok: true, token: `${TOKEN}-${++n}` }));
    const session = manager(fetchImpl, () => now);
    await session.ensure();
    now = 11 * 60_000;
    await expect(session.ensure()).resolves.toBe(`${TOKEN}-1`);
    now = 12 * 60_000 + 1;
    await expect(session.ensure()).resolves.toBe(`${TOKEN}-2`);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('invalidate() forces the next ensure() to fetch a new token', async () => {
    let n = 0;
    const fetchImpl = mockFetch(() => jsonResponse({ ok: true, token: `${TOKEN}-${++n}` }));
    const session = manager(fetchImpl);
    await session.ensure();
    session.invalidate();
    await expect(session.ensure()).resolves.toBe(`${TOKEN}-2`);
  });

  it('recognises the Vercel security checkpoint', async () => {
    const session = manager(mockFetch(() => checkpointResponse()));
    const error = await session.refresh().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InceptionError);
    expect((error as InceptionError).kind).toBe('challenge');
    expect(session.getState().status).toBe('error');
  });

  it('recognises a checkpoint by its HTML even without the header', async () => {
    const res = () =>
      new Response('<html><title>Vercel Security Checkpoint</title></html>', { status: 429, headers: { 'content-type': 'text/html' } });
    const error = (await manager(mockFetch(res)).refresh().catch((e: unknown) => e)) as InceptionError;
    expect(error.kind).toBe('challenge');
  });

  it('classifies HTTP, protocol and network failures', async () => {
    const http = (await manager(mockFetch(() => jsonResponse({ error: 'boom' }, 500))).refresh().catch((e: unknown) => e)) as InceptionError;
    expect(http.kind).toBe('http');
    expect(http.status).toBe(500);
    expect(http.message).toContain('boom');

    const limited = (await manager(mockFetch(() => jsonResponse({}, 429))).refresh().catch((e: unknown) => e)) as InceptionError;
    expect(limited.kind).toBe('rate-limit');

    const noToken = (await manager(mockFetch(() => jsonResponse({ ok: true }))).refresh().catch((e: unknown) => e)) as InceptionError;
    expect(noToken.kind).toBe('protocol');

    const notJson = (await manager(mockFetch(() => new Response('<html>hi</html>', { status: 200 }))).refresh().catch((e: unknown) => e)) as InceptionError;
    expect(notJson.kind).toBe('protocol');

    const offline = (await manager(
      mockFetch(() => {
        throw new TypeError('Failed to fetch');
      }),
    )
      .refresh()
      .catch((e: unknown) => e)) as InceptionError;
    expect(offline.kind).toBe('network');
    expect(offline.message).toContain('chat.inceptionlabs.ai');
    expect(offline.detail).toBe('Failed to fetch');
  });

  it('ignores a response that arrives after the transport was swapped', async () => {
    let resolve!: (r: Response) => void;
    const slow = mockFetch(() => new Promise<Response>((r) => (resolve = r)));
    const session = manager(slow);
    const pending = session.refresh();
    session.setFetch(mockFetch(() => jsonResponse({ ok: true, token: 'fresh-token-123' })));
    resolve(jsonResponse({ ok: true, token: 'stale-token-123' }));
    await pending;
    expect(session.getState().token).toBeNull();
    await expect(session.ensure()).resolves.toBe('fresh-token-123');
  });

  it('notifies subscribers', async () => {
    const session = manager(mockFetch(() => jsonResponse({ ok: true, token: TOKEN })));
    const statuses: string[] = [];
    session.subscribe((s) => statuses.push(s.status));
    await session.refresh();
    expect(statuses).toEqual(['connecting', 'live']);
  });
});

describe('parseIssuedAt', () => {
  it('reads the unix-seconds prefix', () => {
    expect(parseIssuedAt(TOKEN)).toBe(1790265903000);
    expect(parseIssuedAt('abc.def')).toBeNull();
  });
});
