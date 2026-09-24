import { InceptionError } from '../core/errors';
import type { FetchLike } from '../core/http';
import { createId } from '../core/ids';
import { BRIDGE_PORT_NAME, type BridgeReply, type BridgeRequest } from './bridgeProtocol';
import { findSiteTabs, probeTab, waitUntilReady } from './siteTab';

interface Pending {
  onHead(reply: Extract<BridgeReply, { t: 'head' }>): void;
  onChunk(data: string): void;
  onEnd(): void;
  onFail(message: string, aborted: boolean): void;
}

/** Statuses that must not have a body when constructing a Response. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export interface BridgeOptions {
  /** Open the helper tab in the foreground (useful when a checkpoint needs attention). */
  activate?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fallback transport: runs each request *inside* a chat.inceptionlabs.ai tab via the
 * content script, so the request is genuinely same-origin (site cookies, Origin,
 * Referer, Sec-Fetch-* all exactly like the web app). The response streams back over
 * a runtime Port and is exposed as a normal `Response` with a streaming body.
 *
 * Used automatically when direct mode is refused, or when chosen in settings.
 */
export class SiteTabBridge {
  private port: chrome.runtime.Port | null = null;
  private tabId: number | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly baseUrl: string) {}

  get connectedTabId(): number | null {
    return this.tabId;
  }

  /** Find a usable site tab (or open one in the background) and connect to it. */
  connect(options: BridgeOptions = {}): Promise<void> {
    if (this.port) return Promise.resolve();
    this.connecting ??= this.openPort(options).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openPort(options: BridgeOptions): Promise<void> {
    let tabId: number | null = null;
    for (const tab of await findSiteTabs(this.baseUrl)) {
      if ((await probeTab(tab.id!))?.ready) {
        tabId = tab.id!;
        break;
      }
    }
    if (tabId === null) {
      const tab = await chrome.tabs.create({ url: `${this.baseUrl}/`, active: options.activate ?? false });
      if (tab.id === undefined) throw new InceptionError('network', 'Could not open a chat.inceptionlabs.ai tab.');
      tabId = tab.id;
      let activated = options.activate ?? false;
      await waitUntilReady(tabId, {
        timeoutMs: options.timeoutMs ?? 120_000,
        signal: options.signal,
        onProbe: (result, elapsed) => {
          // Background tabs are throttled; if the checkpoint lingers, bring it forward.
          if (!activated && result?.reason === 'checkpoint' && elapsed > 6000) {
            activated = true;
            void chrome.tabs.update(tabId!, { active: true }).catch(() => {});
          }
        },
      });
    }

    const port = chrome.tabs.connect(tabId, { name: BRIDGE_PORT_NAME });
    port.onMessage.addListener(this.handleMessage);
    port.onDisconnect.addListener(this.handleDisconnect);
    this.port = port;
    this.tabId = tabId;
  }

  readonly fetch: FetchLike = async (url, init = {}) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortError();
    await this.connect({ signal });
    const port = this.port;
    if (!port) throw new TypeError('Site-tab bridge is not connected.');

    const id = createId();
    const headers: [string, string][] = [...new Headers(init.headers).entries()];
    const body = typeof init.body === 'string' ? init.body : undefined;
    const encoder = new TextEncoder();

    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let headReceived = false;
      let settled = false;

      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
        cancel: () => {
          this.send({ t: 'abort', id });
          cleanup();
        },
      });

      const cleanup = () => {
        settled = true;
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };

      const fail = (error: Error) => {
        if (settled) return;
        if (!headReceived) reject(error);
        else controller?.error(error);
        cleanup();
      };

      const onAbort = () => {
        this.send({ t: 'abort', id });
        fail(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        onHead: (reply) => {
          headReceived = true;
          const nullBody = NULL_BODY_STATUS.has(reply.status);
          resolve(
            new Response(nullBody ? null : stream, {
              status: reply.status,
              statusText: reply.statusText,
              headers: reply.headers,
            }),
          );
          if (nullBody) cleanup();
        },
        onChunk: (data) => {
          if (!settled) controller?.enqueue(encoder.encode(data));
        },
        onEnd: () => {
          if (settled) return;
          controller?.close();
          cleanup();
        },
        onFail: (message, aborted) => fail(aborted ? abortError() : new TypeError(message)),
      });

      const request: BridgeRequest = { t: 'req', id, url, method: (init.method ?? 'GET').toUpperCase(), headers, body };
      if (!this.send(request)) fail(new TypeError('The chat.inceptionlabs.ai tab is not reachable.'));
    });
  };

  dispose(): void {
    this.port?.disconnect();
    this.handleDisconnect();
  }

  private send(message: BridgeRequest): boolean {
    try {
      this.port?.postMessage(message);
      return this.port !== null;
    } catch {
      return false;
    }
  }

  private readonly handleMessage = (reply: BridgeReply) => {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    switch (reply.t) {
      case 'head':
        pending.onHead(reply);
        break;
      case 'chunk':
        pending.onChunk(reply.data);
        break;
      case 'end':
        pending.onEnd();
        break;
      case 'fail':
        pending.onFail(reply.message, reply.aborted === true);
        break;
    }
  };

  private readonly handleDisconnect = () => {
    this.port = null;
    this.tabId = null;
    for (const pending of [...this.pending.values()]) {
      pending.onFail('The chat.inceptionlabs.ai tab was closed or navigated away.', false);
    }
    this.pending.clear();
  };
}

function abortError(): Error {
  const error = new Error('Request cancelled.');
  error.name = 'AbortError';
  return error;
}
