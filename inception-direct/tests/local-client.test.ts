import { afterEach, describe, expect, it, vi } from 'vitest';
import { InceptionError } from '../src/site';
import { LocalClient, PreviewOnlyError, readLocalStream } from '../src/app/localClient';
import { SiteBrowser } from '../local/site-browser';

const encode = (s: string) => new TextEncoder().encode(s);
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
function body(...pieces: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    for (const piece of pieces) controller.enqueue(piece);
    controller.close();
  } });
}

function mockStatus() {
  return { mode: 'local', status: 'live', csrf: 'local-secret-not-a-site-token',
    siteHost: 'chat.inceptionlabs.ai', browserOpen: true, fetchedAt: 123, issuedAt: 123,
    refreshCount: 1 };
}

afterEach(() => vi.unstubAllGlobals());

describe('local UI client', () => {
  it('labels an HTML-only hosted preview honestly and sends no chat request', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<html>design preview</html>', {
      headers: { 'content-type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = new LocalClient();
    await expect(client.status()).rejects.toBeInstanceOf(PreviewOnlyError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe('/_local/status');
  });

  it('uses only same-origin local routes with its local CSRF header, never a site token', async () => {
    const fetch = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/_local/status') return Response.json(mockStatus());
      if (path === '/_local/connect') return Response.json(mockStatus());
      return new Response('no route', { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    const client = new LocalClient();
    await expect(client.connect()).resolves.toMatchObject({ status: 'live' });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/_local/status', '/_local/connect']);
    const init = fetch.mock.calls[1]![1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>)['x-mercury-local']).toBe('local-secret-not-a-site-token');
  });

  it('preserves UTF-8 across arbitrary network chunk boundaries', async () => {
    const bytes = encode(sse({ type: 'text-delta', delta: 'नमस्ते 👋' }) + 'data: [DONE]\n\n');
    for (let i = 1; i < bytes.length; i++) {
      const events = [];
      for await (const event of readLocalStream(body(bytes.slice(0, i), bytes.slice(i)))) events.push(event);
      expect(events).toEqual([{ type: 'text-delta', delta: 'नमस्ते 👋' }]);
    }
  });

  it('turns a companion challenge error event into a typed error', async () => {
    const event = { type: 'error', kind: 'challenge', message: 'The site asks for a security check.' };
    const caught = await (async () => {
      for await (const _ of readLocalStream(body(encode(sse(event) + 'data: [DONE]\n\n')))) { /* read */ }
    })().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(InceptionError);
    expect((caught as InceptionError).kind).toBe('challenge');
  });

  it('does not present a cut-off local stream as a complete answer', async () => {
    const caught = await (async () => {
      for await (const _ of readLocalStream(body(encode(sse({ type: 'text-delta', delta: 'Half an answer' }))))) { /* read */ }
    })().catch((e: unknown) => e);
    expect((caught as InceptionError).kind).toBe('stream');
  });

  it('refuses to send a site fetch to any endpoint beyond the three protocol routes', async () => {
    const site = new SiteBrowser({ siteUrl: 'https://chat.inceptionlabs.ai' });
    await expect(site.fetch('https://attacker.example/api/session')).rejects.toThrow('three known');
    await expect(site.fetch('https://chat.inceptionlabs.ai/api/other')).rejects.toThrow('three known');
    await expect(site.fetch('https://chat.inceptionlabs.ai/api/chat?to=attacker')).rejects.toThrow('three known');
    await site.close();
  });
});
