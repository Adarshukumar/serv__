import {
  DEFAULT_EFFORT,
  ENDPOINTS,
  IDLE_TIMEOUT_MS,
  RESPONSE_TIMEOUT_MS,
  RETRY_ATTEMPTS,
  RETRY_BASE_MS,
  displayModelName,
  type ModelInfo,
  type ReasoningEffort,
} from './config';
import { abortedError, InceptionError, type InceptionErrorKind } from './errors';
import { parseChunk, type StreamEvent, type StreamMode } from './events';
import {
  defaultMessage,
  discard,
  errorFromResponse,
  hostOf,
  isRetryableStatus,
  kindForStatus,
  linkedController,
  retryDelay,
  sleep,
  type FetchLike,
} from './http';
import { buildChatRequest, buildFollowUpsRequest, buildHandshakeRequest, parseFollowUps, toApiMessages, type ChatTurn } from './messages';
import { SSEDecoder } from './sse';

export interface RetryInfo {
  attempt: number;
  of: number;
  delayMs: number;
  kind: InceptionErrorKind;
  status?: number;
}

export interface ClientOptions {
  /** e.g. https://api.inceptionlabs.ai */
  apiUrl: string;
  /** Read on every request, so a new key applies immediately. */
  getKey: () => string | null;
  fetch?: FetchLike;
  onRetry?: (info: RetryInfo) => void;
  retryAttempts?: number;
  retryBaseMs?: number;
  responseTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface ChatOptions {
  model: string;
  /** Full history, ending with the new user turn. */
  turns: readonly ChatTurn[];
  /** Custom instructions, sent as the system message. */
  system?: string;
  effort?: ReasoningEffort;
  diffusing?: boolean;
  maxTokens: number;
  reasoningSummary?: boolean;
  signal?: AbortSignal;
}

export interface Handshake {
  latencyMs: number;
  model: string;
}

interface SendOptions {
  method: 'GET' | 'POST';
  body?: string;
  accept: string;
  /** "none": don't send the key (public endpoints — also avoids a CORS preflight). */
  auth?: 'required' | 'none';
  retries?: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Talks to Inception's official API straight from the browser that runs it.
 * No proxy and no server of ours: requests leave from the user's own connection.
 */
export class InceptionClient {
  readonly apiUrl: string;

  constructor(private readonly options: ClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
  }

  get host(): string {
    return hostOf(this.apiUrl);
  }

  /**
   * Send the conversation and stream the answer as typed events.
   * 429/5xx before the first byte are retried with exponential backoff.
   */
  async *chat(options: ChatOptions): AsyncGenerator<StreamEvent, void, undefined> {
    const messages = toApiMessages(options.turns, options.system);
    if (messages[messages.length - 1]?.role !== 'user') {
      throw new InceptionError('protocol', 'There is no question to send.');
    }
    const body = JSON.stringify(
      buildChatRequest({
        model: options.model,
        messages,
        effort: options.effort ?? DEFAULT_EFFORT,
        diffusing: options.diffusing ?? false,
        maxTokens: options.maxTokens,
        reasoningSummary: options.reasoningSummary ?? false,
      }),
    );

    const { controller, unlink } = linkedController(options.signal);
    try {
      const res = await this.send(ENDPOINTS.chat, { method: 'POST', body, accept: 'text/event-stream' }, controller, options.signal);
      if (!res.body) {
        discard(res);
        throw new InceptionError('protocol', 'Inception returned an empty response.');
      }
      yield* readChatStream(res.body, options.diffusing ? 'replace' : 'append', {
        signal: options.signal,
        controller,
        idleTimeoutMs: this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
      });
    } finally {
      unlink();
    }
  }

  /**
   * The start-up handshake: one real, minimal completion (≈15 tokens). A 200 proves
   * the whole path at once — CORS, key, credit and model.
   */
  async verify(model: string, signal?: AbortSignal): Promise<Handshake> {
    const started = now();
    const { controller, unlink } = linkedController(signal);
    try {
      const res = await this.send(
        ENDPOINTS.chat,
        { method: 'POST', body: JSON.stringify(buildHandshakeRequest(model)), accept: 'application/json', retries: 2 },
        controller,
        signal,
      );
      const json = (await readJson(res)) as { choices?: unknown; model?: unknown } | null;
      if (!json || !Array.isArray(json.choices)) {
        throw new InceptionError('protocol', defaultMessage('protocol'));
      }
      return { latencyMs: Math.round(now() - started), model: typeof json.model === 'string' ? json.model : model };
    } finally {
      unlink();
    }
  }

  /** The live model list (a public endpoint — the key is not sent). */
  async models(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { controller, unlink } = linkedController(signal);
    try {
      const res = await this.send(ENDPOINTS.models, { method: 'GET', accept: 'application/json', auth: 'none', retries: 1 }, controller, signal);
      const models = parseModels(await readJson(res));
      if (models.length === 0) throw new InceptionError('protocol', 'The model list was empty.');
      return models;
    } finally {
      unlink();
    }
  }

  /** Three follow-up questions written by the model itself. Returns [] on any failure. */
  async followUps(model: string, turns: readonly ChatTurn[], signal?: AbortSignal): Promise<string[]> {
    const { controller, unlink } = linkedController(signal);
    try {
      const res = await this.send(
        ENDPOINTS.chat,
        { method: 'POST', body: JSON.stringify(buildFollowUpsRequest(model, turns)), accept: 'application/json', retries: 0 },
        controller,
        signal,
      );
      const json = (await readJson(res)) as { choices?: { message?: { content?: unknown } }[] } | null;
      const content = json?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? parseFollowUps(content) : [];
    } catch {
      return [];
    } finally {
      unlink();
    }
  }

  private async send(path: string, req: SendOptions, controller: AbortController, userSignal?: AbortSignal): Promise<Response> {
    const key = req.auth === 'none' ? null : this.options.getKey();
    if (req.auth !== 'none' && !key) throw new InceptionError('no-key', defaultMessage('no-key'));

    const headers: Record<string, string> = { Accept: req.accept };
    if (req.body) headers['Content-Type'] = 'application/json';
    if (key) headers.Authorization = `Bearer ${key}`;

    const retries = req.retries ?? this.options.retryAttempts ?? RETRY_ATTEMPTS;
    const fetchFn: FetchLike = this.options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    for (let attempt = 1; ; attempt++) {
      if (userSignal?.aborted) throw abortedError();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetchFn(this.apiUrl + path, {
          method: req.method,
          headers,
          body: req.body,
          signal: controller.signal,
          credentials: 'omit',
        });
      } catch (error) {
        clearTimeout(timer);
        if (userSignal?.aborted) throw abortedError(error);
        if (timedOut) throw new InceptionError('network', `${this.host} didn’t answer in time.`, { cause: error });
        const err = new InceptionError('network', `Couldn’t reach ${this.host}.`, { cause: error, detail: networkHint() });
        // One quick retry: transient DNS/TLS/Wi-Fi hiccups are common, real outages aren't.
        if (attempt === 1 && retries > 0) {
          const delayMs = retryDelay(1, Math.min(800, this.options.retryBaseMs ?? RETRY_BASE_MS));
          this.options.onRetry?.({ attempt, of: 1, delayMs, kind: 'network' });
          await sleep(delayMs, userSignal);
          continue;
        }
        throw err;
      }
      clearTimeout(timer);

      if (res.ok) return res;
      if (isRetryableStatus(res.status) && attempt <= retries) {
        discard(res);
        const delayMs = retryDelay(attempt, this.options.retryBaseMs ?? RETRY_BASE_MS);
        this.options.onRetry?.({ attempt, of: retries, delayMs, kind: kindForStatus(res.status), status: res.status });
        await sleep(delayMs, userSignal);
        continue;
      }
      throw await errorFromResponse(res);
    }
  }
}

function networkHint(): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'This device is offline.';
  return 'Check your connection. A firewall, VPN or content blocker can also stop the request.';
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (error) {
    throw new InceptionError('protocol', defaultMessage('protocol'), { cause: error });
  }
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** GET /v1/models → chat models, newest first (Mercury 2.5 before Mercury 2). */
export function parseModels(json: unknown): ModelInfo[] {
  const data = json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data) ? (json as { data: unknown[] }).data : [];
  const out: ModelInfo[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id || /edit|embed|fim/i.test(id)) continue;
    const outputs = Array.isArray(m.output_modalities) ? m.output_modalities : ['text'];
    if (!outputs.includes('text')) continue;
    const pricing = m.pricing && typeof m.pricing === 'object' ? (m.pricing as Record<string, unknown>) : null;
    out.push({
      id,
      name: displayModelName(typeof m.name === 'string' ? m.name : undefined, id),
      contextLength: positive(m.context_length),
      maxOutput: positive(m.max_output_length),
      pricing: pricing ? { prompt: Number(pricing.prompt) || 0, completion: Number(pricing.completion) || 0 } : undefined,
    });
  }
  return out.sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
}

export interface ReadStreamOptions {
  signal?: AbortSignal;
  /** Aborted (with the fetch) when the stream goes idle for too long. */
  controller?: AbortController;
  idleTimeoutMs?: number;
}

/**
 * Decode the SSE body into typed events. UTF-8 is decoded in streaming mode, so a
 * character split across network chunks survives intact. A stream that ends with
 * neither `finish_reason` nor `[DONE]` was cut off, and says so.
 */
export async function* readChatStream(
  body: ReadableStream<Uint8Array>,
  mode: StreamMode,
  options: ReadStreamOptions = {},
): AsyncGenerator<StreamEvent, void, undefined> {
  const { signal, controller, idleTimeoutMs } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const sse = new SSEDecoder();
  let ended = false;
  let sawDone = false;
  let sawFinish = false;
  let sawError = false;
  let sentMeta = false;
  let timedOut = false;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (!idleTimeoutMs) return;
    clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      controller?.abort();
      reader.cancel().catch(() => {});
    }, idleTimeoutMs);
  };
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  function* emit(payloads: string[]): Generator<StreamEvent, void, undefined> {
    for (const payload of payloads) {
      for (const event of parseChunk(payload, mode)) {
        if (event.type === 'done') {
          sawDone = true;
          return;
        }
        if (event.type === 'meta') {
          if (sentMeta) continue;
          sentMeta = true;
        }
        if (event.type === 'finish') sawFinish = true;
        if (event.type === 'error') sawError = true;
        yield event;
      }
    }
  }

  const timeoutError = () => new InceptionError('stream', 'Inception stopped sending — the answer timed out.');

  try {
    arm();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) throw abortedError(error);
        if (timedOut) throw timeoutError();
        throw new InceptionError('stream', 'The connection dropped while the answer was streaming.', { cause: error });
      }
      if (signal?.aborted) throw abortedError();
      if (timedOut) throw timeoutError();
      if (chunk.done) {
        ended = true;
        break;
      }
      arm();
      yield* emit(sse.push(decoder.decode(chunk.value, { stream: true })));
      if (sawDone) return; // finally{} releases the connection
    }

    yield* emit([...sse.push(decoder.decode()), ...sse.flush()]);
    if (!sawDone && !sawFinish && !sawError) {
      throw new InceptionError('stream', 'The answer was cut off — the connection closed early.');
    }
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
    if (!ended) reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
