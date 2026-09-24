import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEventStream } from '../src/core/client';
import type { StreamEvent } from '../src/core/events';
import { PROBE_MESSAGE } from '../src/platform/bridgeProtocol';
import { createFakeChrome } from './fakeChrome';
import { byteChunks, encoder, jsonResponse, sse, streamResponse } from './helpers';

const SITE = 'https://chat.inceptionlabs.ai';

/**
 * Loads the real content script into a fake "chat.inceptionlabs.ai page" and the
 * real app-side bridge against the same fake chrome.* APIs, so both halves talk to
 * each other exactly as they would in the browser.
 */
async function setup(options: { title?: string; pageFetch?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  vi.resetModules();
  const fake = createFakeChrome();
  const page = { title: options.title ?? 'Inception Chat' };
  const pageFetch = vi.fn(
    options.pageFetch ??
      (async (url: string) => {
        if (url.endsWith('/api/session')) return jsonResponse({ ok: true, token: 'tok-123456789' });
        return new Response('nope', { status: 404 });
      }),
  );
  vi.stubGlobal('chrome', fake.chrome);
  vi.stubGlobal('location', new URL(`${SITE}/`));
  vi.stubGlobal('document', {
    get title() {
      return page.title;
    },
    querySelector: () => null,
  });
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => pageFetch(new URL(input, SITE).toString(), init));

  await import('../src/extension/content-bridge');
  const { SiteTabBridge } = await import('../src/platform/bridge');
  const siteTab = await import('../src/platform/siteTab');
  return { fake, page, pageFetch, SiteTabBridge, siteTab };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('content script probe', () => {
  it('reports ready when the site and /api/session respond', async () => {
    const { fake, siteTab } = await setup();
    fake.loadScript(1);
    await expect(siteTab.probeTab(1)).resolves.toMatchObject({ ready: true, reason: 'ok' });
  });

  it('reports the checkpoint page as not ready', async () => {
    const { fake, siteTab, pageFetch } = await setup({ title: 'Vercel Security Checkpoint' });
    fake.loadScript(1);
    await expect(siteTab.probeTab(1)).resolves.toMatchObject({ ready: false, reason: 'checkpoint' });
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it('reports a blocked session endpoint as not ready', async () => {
    const { fake, siteTab } = await setup({ pageFetch: async () => new Response('', { status: 429 }) });
    fake.loadScript(1);
    await expect(siteTab.probeTab(1)).resolves.toMatchObject({ ready: false, reason: 'session 429' });
  });

  it('returns null when no content script is loaded yet', async () => {
    const { siteTab } = await setup();
    await expect(siteTab.probeTab(1)).resolves.toBeNull();
  });

  it('ignores unrelated messages', async () => {
    const { fake } = await setup();
    fake.loadScript(1);
    await expect(fake.chrome.tabs.sendMessage(1, { t: 'something-else' })).resolves.toBeUndefined();
    await expect(fake.chrome.tabs.sendMessage(1, { t: PROBE_MESSAGE })).resolves.toMatchObject({ ready: true });
  });
});

describe('site-tab bridge', () => {
  it('opens a background site tab, waits for it, and streams a response through it', async () => {
    const stream = sse({ type: 'text-delta', delta: 'Through the tab — नमस्ते 👋' }) + sse({ type: 'finish' }) + sse('[DONE]');
    const { fake, SiteTabBridge } = await setup({
      pageFetch: async (url, init) => {
        if (url.endsWith('/api/session')) return jsonResponse({ ok: true, token: 'tok-123456789' });
        if (url.endsWith('/api/chat')) {
          expect(init.method).toBe('POST');
          expect(new Headers(init.headers).get('x-session-token')).toBe('tok-1');
          expect(init.credentials).toBe('same-origin');
          return streamResponse(byteChunks(stream, 3), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-test': 'yes' } });
        }
        return new Response('nope', { status: 404 });
      },
    });

    // The new tab's content script becomes available shortly after creation.
    const originalCreate = fake.chrome.tabs.create;
    fake.chrome.tabs.create = async (props) => {
      const tab = await originalCreate(props);
      setTimeout(() => fake.loadScript(tab.id), 30);
      return tab;
    };

    const bridge = new SiteTabBridge(SITE);
    const res = await bridge.fetch(`${SITE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': 'tok-1' },
      body: '{"hello":"world"}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-test')).toBe('yes');

    const events: StreamEvent[] = [];
    for await (const event of readEventStream(res.body!)) events.push(event);
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Through the tab — नमस्ते 👋' },
      { type: 'finish', finishReason: undefined },
    ]);
    expect(fake.log.some((l) => l.startsWith('create 100 https://chat.inceptionlabs.ai/ active=false'))).toBe(true);
    expect(fake.log).toContain('connect 100 inception-direct:bridge');
  });

  it('reuses an existing, ready site tab', async () => {
    const { fake, SiteTabBridge } = await setup();
    fake.tabs.set(55, { id: 55, url: `${SITE}/c/abc`, active: false, lastAccessed: 5 });
    fake.loadScript(55);
    const bridge = new SiteTabBridge(SITE);
    const res = await bridge.fetch(`${SITE}/api/session`);
    await expect(res.json()).resolves.toEqual({ ok: true, token: 'tok-123456789' });
    expect(fake.log.some((l) => l.startsWith('create'))).toBe(false);
    expect(bridge.connectedTabId).toBe(55);
  });

  it('refuses cross-origin requests (never an open proxy)', async () => {
    const { fake, SiteTabBridge, pageFetch } = await setup();
    fake.tabs.set(55, { id: 55, url: `${SITE}/`, active: false, lastAccessed: 5 });
    fake.loadScript(55);
    const bridge = new SiteTabBridge(SITE);
    await expect(bridge.fetch('https://evil.example/steal')).rejects.toThrow(/same-origin/);
    expect(pageFetch.mock.calls.some(([url]) => String(url).includes('evil.example'))).toBe(false);
  });

  it('propagates aborts to the page request', async () => {
    let pageSignal: AbortSignal | undefined;
    const { fake, SiteTabBridge } = await setup({
      pageFetch: async (url, init) => {
        if (url.endsWith('/api/session')) return jsonResponse({ ok: true, token: 't-123456789' });
        pageSignal = init.signal ?? undefined;
        const chunks = Array.from({ length: 100 }, (_, i) => encoder.encode(sse({ type: 'text-delta', delta: `${i} ` })));
        return streamResponse(chunks, { status: 200 }, { delayMs: 10 });
      },
    });
    fake.tabs.set(55, { id: 55, url: `${SITE}/`, active: false, lastAccessed: 5 });
    fake.loadScript(55);
    const bridge = new SiteTabBridge(SITE);
    const controller = new AbortController();
    const res = await bridge.fetch(`${SITE}/api/chat`, { method: 'POST', body: '{}', signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(pageSignal?.aborted).toBe(true));
  });

  it('fails pending requests when the site tab goes away', async () => {
    const { fake, SiteTabBridge } = await setup({
      pageFetch: async (url) => {
        if (url.endsWith('/api/session')) return jsonResponse({ ok: true, token: 't-123456789' });
        const chunks = Array.from({ length: 100 }, (_, i) => encoder.encode(`data: ${i}\n\n`));
        return streamResponse(chunks, { status: 200 }, { delayMs: 10 });
      },
    });
    fake.tabs.set(55, { id: 55, url: `${SITE}/`, active: false, lastAccessed: 5 });
    fake.loadScript(55);
    const bridge = new SiteTabBridge(SITE);
    const res = await bridge.fetch(`${SITE}/api/chat`, { method: 'POST', body: '{}' });
    const reader = res.body!.getReader();
    await reader.read();
    fake.lastContentPort!.disconnect();
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return 'ended';
        }
      })(),
    ).rejects.toThrow(/closed or navigated away/);
    expect(bridge.connectedTabId).toBeNull();
  });
});

describe('security check flow', () => {
  it('opens the site, waits through the checkpoint, then closes the tab and returns', async () => {
    const { fake, page, siteTab } = await setup({ title: 'Vercel Security Checkpoint' });
    const originalCreate = fake.chrome.tabs.create;
    fake.chrome.tabs.create = async (props) => {
      const tab = await originalCreate(props);
      fake.loadScript(tab.id);
      // The checkpoint "solves" itself after a moment, like Vercel's JS challenge.
      setTimeout(() => (page.title = 'Inception Chat'), 60);
      return tab;
    };
    const probes: string[] = [];
    await siteTab.runSecurityCheck(SITE, { onProbe: (r) => probes.push(r?.reason ?? 'none') });
    expect(probes[0]).toBe('checkpoint');
    expect(probes.at(-1)).toBe('ok');
    expect(fake.log).toContain('remove 100');
    expect(fake.log).toContain('update 1 {"active":true}');
  }, 15_000);

  it('stops when the user closes the tab', async () => {
    const { fake, siteTab } = await setup({ title: 'Vercel Security Checkpoint' });
    const originalCreate = fake.chrome.tabs.create;
    fake.chrome.tabs.create = async (props) => {
      const tab = await originalCreate(props);
      fake.loadScript(tab.id);
      setTimeout(() => fake.tabs.delete(tab.id), 50);
      return tab;
    };
    await expect(siteTab.runSecurityCheck(SITE)).rejects.toMatchObject({ kind: 'aborted' });
  }, 15_000);
});

describe('header rule', () => {
  beforeEach(() => vi.resetModules());

  it('targets only this extension’s requests to the site’s /api/', async () => {
    const { buildHeaderRule, HEADER_RULE_ID } = await import('../src/platform/headerRules');
    expect(buildHeaderRule(SITE, 'myextensionid')).toEqual({
      id: HEADER_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: SITE },
          { header: 'Referer', operation: 'set', value: `${SITE}/` },
        ],
      },
      condition: {
        urlFilter: `|${SITE}/api/`,
        initiatorDomains: ['myextensionid'],
        resourceTypes: ['xmlhttprequest'],
      },
    });
  });

  it('installs idempotently as a session rule using the runtime id', async () => {
    const fake = createFakeChrome({ extensionId: 'runtimeid123' });
    vi.stubGlobal('chrome', fake.chrome);
    const { installHeaderRules } = await import('../src/platform/headerRules');
    await expect(installHeaderRules(SITE)).resolves.toBe(true);
    await expect(installHeaderRules(SITE)).resolves.toBe(true);
    expect(fake.sessionRules).toHaveLength(1);
    expect((fake.sessionRules[0] as { condition: { initiatorDomains: string[] } }).condition.initiatorDomains).toEqual(['runtimeid123']);
    expect(fake.log.filter((l) => l.startsWith('rules'))).toEqual(['rules remove=[4201] add=1', 'rules remove=[4201] add=1']);
  });

  it('is a no-op outside an extension', async () => {
    const { installHeaderRules } = await import('../src/platform/headerRules');
    await expect(installHeaderRules(SITE)).resolves.toBe(false);
  });
});
