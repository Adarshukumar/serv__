// ══════════════════════════════════════════════════════════════
//  src/lib/bridge.ts — SPA ↔ local bridge client
//
//  POSTs a ChatRequest, decodes the outer envelope, feeds the relayed provider
//  bytes through SSEFramer + the right normaliser, and yields unified
//  StreamEvents. The UI consumes ONLY StreamEvent and never sees a wire format.
// ══════════════════════════════════════════════════════════════

import type { ChatRequest, StreamEvent, WireFormat } from '../types';
import { EnvelopeParser } from './envelope.ts';
import { SSEFramer, parseData } from './sse.ts';
import { createNormalizer, createDolphinNormalizer, type Normalizer } from './normalizers.ts';

/** Relative by default so the Vite dev-server proxy (or any static host) handles it. */
export const BRIDGE_URL = '/bridge/chat';

const WIRES: WireFormat[] = [
  'openai-delta',
  'workers-raw',
  'reasoning-delta',
  'typed-events',
  'upstage-v3',
];

function isWire(v: unknown): v is WireFormat {
  return typeof v === 'string' && (WIRES as string[]).includes(v);
}

export interface StreamMeta {
  provider: string;
  wire: WireFormat | null;
  model?: string;
  url?: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Invoked once when the bridge reports which wire format it is relaying. */
  onMeta?: (meta: StreamMeta) => void;
  /** Override the endpoint (tests, or a bridge on another port). */
  url?: string;
}

/**
 * Stream a chat completion as unified events.
 * Never throws for provider-side failures — those arrive as `{kind:'error'}`
 * events, so the UI can render them inline. Transport-level failures do throw.
 */
export async function* streamChat(
  request: ChatRequest,
  opts: StreamOptions = {},
): AsyncGenerator<StreamEvent, void, undefined> {
  const endpoint = opts.url ?? BRIDGE_URL;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(request),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    yield {
      kind: 'error',
      message: `cannot reach the local bridge at ${endpoint}. Start it with \`npm run bridge\`. (${(err as Error)?.message || err})`,
      retryable: true,
    };
    return;
  }

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* no body */
    }
    yield { kind: 'error', message: `bridge returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, retryable: res.status >= 500 };
    return;
  }

  const envelope = new EnvelopeParser();
  const framer = new SSEFramer();
  let normalizer: Normalizer | null = null;
  let sawDone = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!text) continue;

      for (const ev of envelope.push(text)) {
        if (ev.event === 'meta') {
          const d = ev.data as { provider?: string; wire?: string; model?: string; url?: string };
          const wire = isWire(d?.wire) ? d.wire : null;
          // Dolphin shares the openai-delta format but terminates on finish_reason.
          normalizer =
            wire === 'openai-delta' && d?.provider === 'Dolphin'
              ? createDolphinNormalizer()
              : wire
                ? createNormalizer(wire)
                : null;
          opts.onMeta?.({ provider: d?.provider ?? request.provider, wire, model: d?.model, url: d?.url });
          if (!wire) {
            yield { kind: 'error', message: `bridge reported unknown wire format "${d?.wire}"`, retryable: false };
          }
        } else if (ev.event === 'raw') {
          const chunk = (ev.data as { chunk?: string })?.chunk ?? '';
          if (!chunk || !normalizer) continue;
          for (const f of framer.push(chunk)) {
            if (f.type === 'done') {
              sawDone = true;
              yield { kind: 'done', finishReason: '[DONE]' };
              continue;
            }
            const parsed = parseData(f.payload);
            if (parsed === undefined) continue;
            for (const nev of normalizer.push(parsed)) {
              if (nev.kind === 'done') sawDone = true;
              yield nev;
            }
          }
        } else if (ev.event === 'error') {
          const d = ev.data as { message?: string; retryable?: boolean };
          yield { kind: 'error', message: d?.message ?? 'unknown bridge error', retryable: Boolean(d?.retryable) };
        } else if (ev.event === 'end') {
          // fall through to finalisation below
        }
      }
      if (sawDone) break;
    }

    // Flush any partial outer frame and any held-back inner content.
    for (const ev of envelope.end()) {
      if (ev.event === 'raw') {
        const chunk = (ev.data as { chunk?: string })?.chunk ?? '';
        if (chunk && normalizer) {
          for (const f of framer.push(chunk)) {
            if (f.type === 'data') {
              const parsed = parseData(f.payload);
              if (parsed !== undefined) for (const nev of normalizer.push(parsed)) yield nev;
            }
          }
        }
      } else if (ev.event === 'error') {
        const d = ev.data as { message?: string; retryable?: boolean };
        yield { kind: 'error', message: d?.message ?? 'unknown bridge error', retryable: Boolean(d?.retryable) };
      }
    }

    if (normalizer) {
      for (const f of framer.end()) {
        if (f.type === 'done') {
          sawDone = true;
          yield { kind: 'done', finishReason: '[DONE]' };
        } else {
          const parsed = parseData(f.payload);
          if (parsed !== undefined) for (const nev of normalizer.push(parsed)) yield nev;
        }
      }
      // Critical: releases text the ThinkSplitter held back as a possible
      // partial tag. Without this a short final token silently vanishes.
      for (const nev of normalizer.end()) yield nev;
    }

    if (!sawDone) yield { kind: 'done' };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      if (normalizer) for (const nev of normalizer.end()) yield nev;
      yield { kind: 'done', finishReason: 'aborted' };
      return;
    }
    yield { kind: 'error', message: `stream failure: ${(err as Error)?.message || err}`, retryable: true };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** Non-streaming probe so the UI can show whether the bridge is running. */
export async function bridgeHealth(base = '/bridge/health'): Promise<{ ok: boolean; providers?: string[]; error?: string }> {
  try {
    const res = await fetch(base, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { ok?: boolean; providers?: string[] };
    return { ok: Boolean(data.ok), providers: data.providers };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || String(err) };
  }
}
