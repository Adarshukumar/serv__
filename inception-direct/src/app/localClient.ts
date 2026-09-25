import { InceptionError, isAbortError, SSEDecoder, type ChatTurn, type StreamEvent, type ThinkingMode } from '../site';

export interface CompanionStatus {
  mode: 'local';
  status: 'connecting' | 'live' | 'challenge' | 'offline' | 'error';
  siteHost: string;
  message?: string;
  detail?: string;
  browserOpen: boolean;
  fetchedAt: number | null;
  issuedAt: number | null;
  refreshCount: number;
}

type LocalStatusResponse = CompanionStatus & { csrf: string };

export class PreviewOnlyError extends Error {
  constructor() {
    super('This hosted page is a visual preview. To chat from your own IP, run `npm start` on your computer and open http://127.0.0.1:4173.');
    this.name = 'PreviewOnlyError';
  }
}

export interface LocalChatOptions {
  chatId: string;
  turns: readonly ChatTurn[];
  thinking: ThinkingMode;
  webSearch: boolean;
  system: string;
  signal?: AbortSignal;
}

/**
 * The UI talks only to localhost. The Node companion talks to the site's /api/*
 * from a dedicated browser *on this same computer*. The site's session token and
 * cookies never pass through this client, nor do we load any official API SDK.
 */
export class LocalClient {
  private csrf: string | null = null;

  async status(): Promise<CompanionStatus> {
    let res: Response;
    try {
      res = await fetch('/_local/status', { cache: 'no-store', credentials: 'omit' });
    } catch (error) {
      throw new InceptionError('network', 'The local companion is not reachable.', { cause: error });
    }
    if (!res.headers.get('content-type')?.includes('application/json')) throw new PreviewOnlyError();
    const status = await res.json() as Partial<LocalStatusResponse>;
    if (!res.ok || status.mode !== 'local' || typeof status.csrf !== 'string') throw new PreviewOnlyError();
    this.csrf = status.csrf;
    return status as CompanionStatus;
  }

  async connect(): Promise<CompanionStatus> {
    const res = await this.post('/_local/connect', {});
    const data = await res.json() as CompanionStatus;
    return data;
  }

  async showSite(): Promise<void> {
    const res = await this.post('/_local/open-site', {});
    if (!res.ok) throw await localError(res);
  }

  async *chat(options: LocalChatOptions): AsyncGenerator<StreamEvent, void, undefined> {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const res = await this.post('/_local/chat', {
      chatId: options.chatId,
      turns: options.turns,
      thinking: options.thinking,
      webSearch: options.webSearch,
      system: options.system,
      timezone,
    }, options.signal);
    if (!res.ok) throw await localError(res);
    if (!res.body) throw new InceptionError('protocol', 'The local companion returned no answer stream.');
    yield* readLocalStream(res.body, options.signal);
  }

  async followUps(turns: readonly ChatTurn[], signal?: AbortSignal): Promise<string[]> {
    try {
      const res = await this.post('/_local/follow-ups', { turns }, signal);
      if (!res.ok) return [];
      const data = await res.json() as { follow_ups?: unknown };
      return Array.isArray(data.follow_ups)
        ? data.follow_ups.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 5)
        : [];
    } catch { return []; }
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    if (!this.csrf) await this.status();
    try {
      return await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mercury-local': this.csrf! },
        body: JSON.stringify(body), cache: 'no-store', credentials: 'omit', signal,
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw new InceptionError('aborted', 'Request cancelled.', { cause: error });
      throw new InceptionError('network', 'The local companion disconnected.', { cause: error });
    }
  }
}

async function localError(res: Response): Promise<InceptionError> {
  let payload: unknown;
  try { payload = await res.json(); } catch { /* no JSON */ }
  const error = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
  const e = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const kind = typeof e.kind === 'string' && ['network', 'challenge', 'auth', 'rate-limit', 'http', 'protocol', 'stream', 'aborted'].includes(e.kind)
    ? e.kind as InceptionError['kind']
    : res.status === 503 ? 'network' : 'http';
  return new InceptionError(kind, typeof e.message === 'string' ? e.message : `Local request failed (${res.status}).`, {
    status: res.status, detail: typeof e.detail === 'string' ? e.detail : undefined,
  });
}

/** Decode the companion's typed SSE. A lost HTTP stream is not a successful answer. */
export async function* readLocalStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const sse = new SSEDecoder();
  let done = false;
  let ended = false;
  const emit = function* (payloads: string[]): Generator<StreamEvent> {
    for (const data of payloads) {
      if (data === '[DONE]') { done = true; return; }
      let event: StreamEvent & { kind?: string; detail?: string };
      try { event = JSON.parse(data) as typeof event; } catch { continue; }
      if (!event || typeof event.type !== 'string') continue;
      if (event.type === 'error' && event.kind) {
        throw new InceptionError(event.kind as InceptionError['kind'], event.message, { detail: event.detail });
      }
      yield event;
    }
  };
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (error) {
        if (signal?.aborted) throw new InceptionError('aborted', 'Request cancelled.', { cause: error });
        throw new InceptionError('stream', 'The local connection dropped while the answer was streaming.', { cause: error });
      }
      if (signal?.aborted) throw new InceptionError('aborted', 'Request cancelled.');
      if (chunk.done) { ended = true; break; }
      yield* emit(sse.push(decoder.decode(chunk.value, { stream: true })));
      if (done) return;
    }
    yield* emit([...sse.push(decoder.decode()), ...sse.flush()]);
    if (!done) throw new InceptionError('stream', 'The answer was cut off — the local connection closed early.');
  } finally {
    if (!ended) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
