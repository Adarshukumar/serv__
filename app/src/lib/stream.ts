// ══════════════════════════════════════════════════════════════
//  src/lib/stream.ts — the ONE entry point the UI calls
//
//  Routing:
//    mock            → generated in-browser, zero network
//    transport:direct → browser → the provider's real URL   (DEFAULT)
//    transport:bridge → local Node relay                    (opt-in fallback)
//
//  The UI never knows which path ran; it only ever consumes StreamEvent.
// ══════════════════════════════════════════════════════════════

import type { ChatRequest, StreamEvent, WireFormat } from '../types';
import { providerMeta } from '../data/providers.ts';
import { SSEFramer, parseData } from './sse.ts';
import { createNormalizer, createDolphinNormalizer, type Normalizer } from './normalizers.ts';
import { mockStream } from './mock.ts';
import { streamDirect, type ResolvedRequest } from './direct.ts';
import { streamChat as streamViaBridge, type StreamMeta } from './bridge.ts';

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

export interface StreamOptions {
  signal?: AbortSignal;
  /**
   * Direct mode: the resolved request, carrying the REAL provider URL.
   * Bridge mode: the relay's own meta. Both let the UI show where bytes came from.
   */
  onMeta?: (info: {
    provider: string;
    wire: WireFormat | null;
    url?: string;
    /** Headers a browser is not permitted to set, reported not sent. */
    forbidden?: Record<string, string>;
    via: 'direct' | 'bridge' | 'mock';
  }) => void;
  /** Force a transport regardless of provider config. Tests use this. */
  force?: 'direct' | 'bridge';
  /** Bridge endpoint override. */
  bridgeUrl?: string;
}

function normalizerFor(wire: WireFormat, provider: string): Normalizer {
  return wire === 'openai-delta' && provider === 'Dolphin'
    ? createDolphinNormalizer()
    : createNormalizer(wire);
}

/** Offline simulator: canned SSE in a chosen wire format, no network at all. */
async function* streamMock(
  req: ChatRequest,
  opts: StreamOptions,
): AsyncGenerator<StreamEvent, void, undefined> {
  const wire = isWire(req.wire) ? req.wire : 'upstage-v3';
  opts.onMeta?.({ provider: 'mock', wire, url: 'generated in-browser (no network)', via: 'mock' });

  const framer = new SSEFramer();
  const normalizer = normalizerFor(wire, 'mock');
  let sawDone = false;

  try {
    for await (const chunk of mockStream(wire)) {
      if (opts.signal?.aborted) break;
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
      if (sawDone) break;
    }

    for (const f of framer.end()) {
      if (f.type === 'done') {
        sawDone = true;
        yield { kind: 'done', finishReason: '[DONE]' };
      } else {
        const parsed = parseData(f.payload);
        if (parsed !== undefined) for (const nev of normalizer.push(parsed)) yield nev;
      }
    }
    for (const nev of normalizer.end()) yield nev;
    if (!sawDone) yield { kind: 'done' };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      for (const nev of normalizer.end()) yield nev;
      yield { kind: 'done', finishReason: 'aborted' };
      return;
    }
    yield { kind: 'error', message: `simulator failure: ${(err as Error)?.message || err}`, retryable: false };
  }
}

/** Stream a chat completion. Provider-side failures arrive as events, not throws. */
export async function* streamChat(
  req: ChatRequest,
  opts: StreamOptions = {},
): AsyncGenerator<StreamEvent, void, undefined> {
  const meta = providerMeta(req.provider);

  if (req.provider === 'mock' && opts.force !== 'direct' && opts.force !== 'bridge') {
    yield* streamMock(req, opts);
    return;
  }

  const transport = opts.force ?? meta.transport;

  if (transport === 'direct') {
    yield* streamDirect(req, {
      signal: opts.signal,
      onMeta: (r: ResolvedRequest) =>
        opts.onMeta?.({
          provider: r.provider,
          wire: r.wire,
          url: r.url,
          forbidden: r.forbidden,
          via: 'direct',
        }),
    });
    return;
  }

  yield* streamViaBridge(req, {
    signal: opts.signal,
    url: opts.bridgeUrl,
    onMeta: (m: StreamMeta) =>
      opts.onMeta?.({ provider: m.provider, wire: m.wire, url: m.url, via: 'bridge' }),
  });
}

/**
 * Connectivity probe. Direct mode has no health endpoint of its own — the
 * provider IS the endpoint — so this reports the transport in use rather than
 * pretending to ping something.
 */
export async function connectivity(): Promise<{
  via: 'direct' | 'bridge';
  ok: boolean;
  detail: string;
}> {
  return {
    via: 'direct',
    ok: true,
    detail: 'Requests are built in the browser and sent straight to each provider\u2019s real URL. No relay is required.',
  };
}
