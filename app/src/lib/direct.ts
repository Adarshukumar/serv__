// ══════════════════════════════════════════════════════════════
//  src/lib/direct.ts — BROWSER → PROVIDER, no relay
//
//  This is the default transport. The request is built client-side and sent
//  straight to the provider's real URL, so that URL is what appears in the
//  browser network log. There is no /bridge/chat hop and no Python.
//
//  What a browser cannot do (Fetch spec, enforced — see headers.ts):
//    · set Sec-Fetch-* , sec-ch-ua* , Origin, Referer, User-Agent, Cookie
//  The browser fills those in itself: Origin becomes this page's origin and
//  Sec-Fetch-Site becomes cross-site, because the provider is a different site.
//  That is reported honestly on every request rather than hidden.
//
//  Everything the provider actually needs in the BODY is sent exactly as the
//  Python client sent it, because payloads.ts is a line-referenced port of it.
// ══════════════════════════════════════════════════════════════

import type { ChatRequest, ProviderId, StreamEvent, WireFormat } from '../types';
import { providerMeta } from '../data/providers.ts';
import { SSEFramer, parseData } from './sse.ts';
import { createNormalizer, createDolphinNormalizer, type Normalizer } from './normalizers.ts';
import { ENDPOINTS, splitHeaders, MERCURY_HARDCODED_PROXY } from './headers.ts';
import { getCsrf, loadCreds as loadUpstageCreds } from './upstageSession.ts';
import {
  deepInfraPayload,
  mCloudFlarePayload,
  dolphinPayload,
  llmChatPayload,
  llmChatUrl,
  mercuryPayload,
  upstagePayload,
} from './payloads.ts';

// ── credentials the browser holds locally, never sent anywhere else ──────
const LS = {
  upstageCsrf: 'upstage.csrf',
  upstageSessionId: 'upstage.sessionId',
  mercuryToken: 'mercury.sessionToken',
  mercuryProxy: 'mercury.useHardcodedProxy',
} as const;

/**
 * localStorage is a browser API; under Node (tests, SSR, any non-DOM host) it
 * is a ReferenceError, not undefined. Guarding it keeps resolveRequest pure and
 * testable — the request shape must not depend on whether a DOM happens to
 * exist. Falls back to an in-memory map so behaviour stays coherent.
 */
const memStore = new Map<string, string>();
function store(): { get(k: string): string; set(k: string, v: string): void } {
  const g = globalThis as { localStorage?: Storage };
  if (typeof g.localStorage !== 'undefined' && g.localStorage) {
    return {
      get: (k) => {
        try {
          return g.localStorage!.getItem(k) ?? '';
        } catch {
          return '';
        } // private-mode / disabled storage
      },
      set: (k, v) => {
        try {
          g.localStorage!.setItem(k, v);
        } catch {
          memStore.set(k, v);
        }
      },
    };
  }
  return { get: (k) => memStore.get(k) ?? '', set: (k, v) => void memStore.set(k, v) };
}

export const getUpstageCsrf = () => store().get(LS.upstageCsrf);
export const setUpstageCsrf = (v: string) => store().set(LS.upstageCsrf, v.trim());
export const getMercuryToken = () => store().get(LS.mercuryToken);
export const setMercuryToken = (v: string) => store().set(LS.mercuryToken, v.trim());

/** Upstage's x-session-id: cookies.session_id from the captured creds, else a uuid. */
export function getUpstageSessionId(): string {
  const cached = loadUpstageCreds();
  if (cached?.sessionId) return cached.sessionId;
  const manual = store().get(LS.upstageSessionId);
  return manual;
}
export const setUpstageSessionId = (v: string) => store().set(LS.upstageSessionId, v.trim());

export interface ResolvedRequest {
  /** The real provider URL that will be hit. */
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  /** Headers the Python client sent but a browser forbids — reported, not sent. */
  forbidden: Record<string, string>;
  body?: string;
  wire: WireFormat;
  provider: string;
}

/** Credentials resolved before the request is built (see streamDirect). */
export interface ResolvedCreds {
  /** Upstage: the JWT from the RSC server action. */
  upstageCsrf?: string;
  /** Upstage: cookies.session_id, or a generated uuid — sent as x-session-id. */
  upstageSessionId?: string;
  /** Mercury: the token from GET /api/session. */
  mercuryToken?: string;
}

/** Build the exact request for a provider. Exported so tests can assert on it. */
export function resolveRequest(req: ChatRequest, creds: ResolvedCreds = {}): ResolvedRequest {
  const meta = providerMeta(req.provider);
  const wire = meta.wire;
  const { settable, forbidden } = splitHeaders(req.provider);
  const headers: Record<string, string> = { ...settable };

  let url = ENDPOINTS[req.provider] ?? meta.endpoint;
  let body: unknown;

  switch (req.provider as ProviderId) {
    case 'DeepInfra':
      body = deepInfraPayload(req);
      break;

    case 'mCloudFlare':
      body = mCloudFlarePayload(req);
      break;

    case 'Dolphin':
      body = dolphinPayload(req);
      break;

    case 'LLMChat': {
      // The model travels in the query string as "{tag}/{name}".
      const tag = req.tag || '@cf';
      url = llmChatUrl(ENDPOINTS.LLMChat, tag, req.modelId);
      body = llmChatPayload(req);
      break;
    }

    case 'Mercury': {
      // Inception.py _hdrs(): "x-session-token": state["token"]. A pasted token
      // wins; otherwise use one captured from GET /api/session this session.
      const token = getMercuryToken() || creds.mercuryToken || '';
      if (token) headers['x-session-token'] = token;
      body = mercuryPayload(req);
      break;
    }

    case 'Upstage': {
      // upstage_provider.py _stream_events() — three x- headers, all required.
      // A pasted CSRF wins (manual override); otherwise use the captured one.
      const csrf = getUpstageCsrf() || creds.upstageCsrf || '';
      if (csrf) headers['x-csrf-token'] = csrf;
      const sid = creds.upstageSessionId || getUpstageSessionId();
      if (sid) headers['x-session-id'] = sid;
      // The Python client ALSO attaches the console's cookies manually, because
      // the API host (apistage.ai) is a different site from console.upstage.ai.
      // A browser cannot read another site's cookies, so this is the one part of
      // the Python flow that direct mode provably cannot reproduce. Reported to
      // the caller rather than hidden.
      body = upstagePayload(req);
      break;
    }

    default:
      body = { model: req.modelId, messages: req.messages, stream: true };
  }

  return {
    url,
    method: 'POST',
    headers,
    forbidden,
    body: JSON.stringify(body),
    wire,
    provider: req.provider,
  };
}

/**
 * Mercury mints its session token from a separate endpoint.
 *
 * Inception.py:385 — `self.scraper.get(self.session_url)`. It is a **GET** with
 * no body, and the token is `data["token"]`. An earlier revision of this file
 * sent a POST with a `"{}"` body, which was invented rather than read.
 *
 * Inception.py:382 also sleeps a random 1.5–4.0s before the call (rate-limit
 * etiquette against a Cloudflare-protected host). Preserved, and skippable in
 * tests via `opts.skipDelay`.
 */
export async function fetchMercurySession(
  opts: { signal?: AbortSignal; skipDelay?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ token?: string; error?: string }> {
  const url = ENDPOINTS.MercurySession;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    if (!opts.skipDelay) {
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2500));
    }
    const res = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: opts.signal,
      credentials: 'include',
    });
    if (res.status === 429) {
      return { error: `GET ${url} returned HTTP 429 — Mercury is rate-limiting. Wait a minute and retry.` };
    }
    if (!res.ok) return { error: `GET ${url} returned HTTP ${res.status}` };
    const data = (await res.json()) as { token?: string };
    // Inception.py:389 reads exactly `data.get("token")`. No fallback guessing.
    const token = data.token;
    if (!token) return { error: `${url} responded 200 but carried no "token" field` };
    setMercuryToken(token);
    return { token };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { error: 'aborted' };
    return { error: describeNetworkFailure(url, err) };
  }
}

/** Turn an opaque fetch TypeError into something the user can act on. */
function describeNetworkFailure(url: string, err: unknown): string {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  return (
    `The browser could not reach ${host} directly. This is almost always CORS: ` +
    `the provider did not return an Access-Control-Allow-Origin matching this page, ` +
    `so the browser blocked the response before JavaScript could read it. ` +
    `Open DevTools → Network → ${host} to see the real status. ` +
    `(fetch said: ${(err as Error)?.message || String(err)})`
  );
}

export interface DirectOptions {
  signal?: AbortSignal;
  /** Invoked once with the resolved request, so the UI can show the real URL. */
  onMeta?: (r: ResolvedRequest) => void;
}

/**
 * Stream a chat completion straight from the provider.
 * Provider-side failures arrive as {kind:'error'} events so the UI can render
 * them inline; nothing is swallowed.
 */
export async function* streamDirect(
  req: ChatRequest,
  opts: DirectOptions = {},
): AsyncGenerator<StreamEvent, void, undefined> {
  // ── provider initialisation, mirroring the Python connect() flow ──
  // Upstage and Mercury both mint a credential before the chat request; the
  // other four providers are anonymous and need nothing.
  const creds: ResolvedCreds = {};

  if (req.provider === 'Upstage' && !getUpstageCsrf()) {
    yield { kind: 'status', phase: 'connecting', detail: 'Establishing Upstage session (RSC credential pipeline)…' };
    const r = await getCsrf({ signal: opts.signal });
    if ('error' in r) {
      yield {
        kind: 'error',
        retryable: false,
        message:
          `${r.error}  ·  Upstage's flow needs the console's session cookies attached to a request to a ` +
          `DIFFERENT site (ap-northeast-2.apistage.ai), which a browser cannot do — it will not let ` +
          `JavaScript read another site's cookies. Paste a CSRF token in the ⚿ keys panel to override, ` +
          `or set Upstage's transport to 'bridge' so the local relay can run this identical capture ` +
          `with a real cookie jar.`,
      };
      return;
    }
    creds.upstageCsrf = r.csrf;
    creds.upstageSessionId = r.sessionId;
  }

  if (req.provider === 'Mercury' && !getMercuryToken()) {
    yield { kind: 'status', phase: 'connecting', detail: 'Establishing Mercury session (GET /api/session)…' };
    const r = await fetchMercurySession({ signal: opts.signal });
    if (!r.token) {
      yield {
        kind: 'error',
        retryable: true,
        message:
          `Could not establish a Mercury session: ${r.error}  ·  Paste a token in the ⚿ keys panel, ` +
          `or set Mercury's transport to 'bridge'.`,
      };
      return;
    }
    creds.mercuryToken = r.token;
  }

  const resolved = resolveRequest(req, creds);
  opts.onMeta?.(resolved);

  yield { kind: 'status', phase: 'connecting', detail: resolved.url };

  let res: Response;
  try {
    res = await fetch(resolved.url, {
      method: resolved.method,
      headers: resolved.headers,
      body: resolved.body,
      signal: opts.signal,
      mode: 'cors',
      // Upstage/Mercury rely on a logged-in session; the rest are anonymous.
      credentials: req.provider === 'Upstage' || req.provider === 'Mercury' ? 'include' : 'same-origin',
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    yield { kind: 'error', message: describeNetworkFailure(resolved.url, err), retryable: true };
    return;
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* no body */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? req.provider === 'Upstage'
          ? ' Upstage needs a valid CSRF token plus a signed-in console session — paste the token in the Credentials panel.'
          : req.provider === 'Mercury'
            ? ' Mercury needs a session token — use "Fetch session" in the Credentials panel.'
            : ''
        : '';
    yield {
      kind: 'error',
      message: `${resolved.url} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}.${hint}`,
      retryable: res.status >= 500 || res.status === 429,
    };
    return;
  }

  if (!res.body) {
    yield { kind: 'error', message: `${resolved.url} returned 200 with no readable body`, retryable: true };
    return;
  }

  const framer = new SSEFramer();
  const normalizer: Normalizer =
    resolved.wire === 'openai-delta' && req.provider === 'Dolphin'
      ? createDolphinNormalizer()
      : createNormalizer(resolved.wire);

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let sawDone = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!text) continue;

      for (const f of framer.push(text)) {
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
        yield { kind: 'done', finishReason: '[DONE]' }
      } else {
        const parsed = parseData(f.payload);
        if (parsed !== undefined) for (const nev of normalizer.push(parsed)) yield nev;
      }
    }
    // Critical: releases text the ThinkSplitter held back as a possible partial
    // tag. Without this a short final token silently vanishes.
    for (const nev of normalizer.end()) yield nev;

    if (!sawDone) yield { kind: 'done' };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      for (const nev of normalizer.end()) yield nev;
      yield { kind: 'done', finishReason: 'aborted' };
      return;
    }
    yield { kind: 'error', message: `stream failure from ${resolved.url}: ${(err as Error)?.message || err}`, retryable: true };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** Surfaced in the UI so the plaintext-proxy risk is never silently inherited. */
export const mercuryProxyNotice = MERCURY_HARDCODED_PROXY;
