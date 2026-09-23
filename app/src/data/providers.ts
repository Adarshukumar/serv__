// ══════════════════════════════════════════════════════════════
//  src/data/providers.ts — provider metadata for the UI
//
//  Every field here was read out of the Python provider source, not guessed.
//  DevsDo is absent by instruction. `mock` exists so the full pipeline is
//  demonstrable where no provider host is reachable.
//
//  transport: 'direct' is the DEFAULT and what the user asked for: the browser
//  builds the request (payloads.ts) and POSTs straight to the provider's real
//  URL, so that URL is what shows in the DevTools network log. No relay.
//
//  'bridge' remains available per-provider as a fallback ONLY, for the case
//  where a provider's CORS policy refuses to let a browser read the response.
//  Note that Origin / Referer / Sec-Fetch-* / User-Agent are FORBIDDEN header
//  names under the Fetch spec — no JavaScript can set them, in either mode. The
//  browser substitutes its own values. That is reported in the UI on every
//  request rather than hidden. See ARCHITECTURE.md §2–§3.
// ══════════════════════════════════════════════════════════════

import type { ProviderMeta, ProviderId, WireFormat } from '../types';

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'Upstage',
    label: 'Upstage Solar',
    blurb: 'Solar / Syn reasoning models with web search. v3 provider: pure async, no browser automation.',
    wire: 'upstage-v3',
    transport: 'direct',
    endpoint: 'https://ap-northeast-2.apistage.ai/v1/web/demo/chat/completions',
    accent: '#f5a524',
    supports: { thinking: true, search: true, attachments: false, usage: true, credentials: true },
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'LLMChat',
    label: 'LLMChat',
    blurb: 'Largest catalogue kept after removing DevsDo. Reasoning arrives as delta.reasoning_content.',
    wire: 'reasoning-delta',
    transport: 'direct',
    endpoint: 'https://llmchat.in/inference/stream',
    accent: '#5ac8fa',
    supports: { thinking: true, search: false, attachments: false, usage: false, credentials: false },
  },
  {
    id: 'DeepInfra',
    label: 'DeepInfra',
    blurb: 'Plain OpenAI-shaped deltas. Was orphaned in the old registry — 18 models recovered here.',
    wire: 'openai-delta',
    transport: 'direct',
    endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions',
    accent: '#a78bfa',
    supports: { thinking: false, search: false, attachments: false, usage: false, credentials: false },
  },
  {
    id: 'mCloudFlare',
    label: 'Cloudflare Multi-Modal',
    blurb: 'Workers AI raw shape: {"response":"…"} with no choices array. TLS-impersonated in Python.',
    wire: 'workers-raw',
    transport: 'direct',
    endpoint: 'https://multi-modal.ai.cloudflare.com/api/inference',
    accent: '#f97316',
    supports: { thinking: false, search: false, attachments: false, usage: false, credentials: false },
  },
  {
    id: 'Dolphin',
    label: 'Dolphin',
    blurb: 'Two models, image + text attachments, system prompt folded into a user turn. Ends on finish_reason.',
    wire: 'openai-delta',
    transport: 'direct',
    endpoint: 'https://chat.dphn.ai/api/chat',
    accent: '#34d399',
    supports: { thinking: false, search: false, attachments: true, usage: false, credentials: false },
  },
  {
    id: 'Mercury',
    label: 'Mercury (Inception)',
    blurb: 'Typed events: reasoning-delta / text-delta / source-url. Needs a captured session token.',
    wire: 'typed-events',
    transport: 'direct',
    endpoint: 'https://chat.inceptionlabs.ai/api/chat',
    accent: '#f472b6',
    supports: { thinking: true, search: true, attachments: false, usage: false, credentials: true },
  },
  {
    id: 'mock',
    label: 'Offline Simulator',
    blurb: 'Streams canned SSE in every wire format. No network, no credentials — for UI and parser work.',
    wire: 'upstage-v3',
    transport: 'direct',
    endpoint: 'local',
    accent: '#94a3b8',
    supports: { thinking: true, search: true, attachments: false, usage: true, credentials: false },
    reasoningEfforts: ['low', 'medium', 'high'],
  },
];

export const PROVIDER_BY_ID: Record<string, ProviderMeta> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
);

export function providerMeta(id: ProviderId | string): ProviderMeta {
  return PROVIDER_BY_ID[id] ?? PROVIDER_BY_ID['mock'];
}

/** Providers in the order the sidebar should show them: real ones first, mock last. */
export const REAL_PROVIDERS = PROVIDERS.filter((p) => p.id !== 'mock');

/** LLMChat encodes a routing tag (@cf / @hf) alongside the model name. */
export const LLMCHAT_TAGS = ['@cf', '@hf'] as const;

/**
 * The offline simulator has no entry in the real registry, so it gets one
 * synthetic "model" per wire format. `modelId` carries the format name, which
 * App passes through as ChatRequest.wire. This is what makes every normaliser
 * reachable from the UI with no network and no credentials.
 */
export const MOCK_MODELS: { name: string; display: string; wire: WireFormat; blurb: string }[] = [
  { name: 'mock-upstage', display: 'Upstage v3 (think + search + usage)', wire: 'upstage-v3',
    blurb: 'Hardest case: search lifecycle, reasoning_content, <think> tags split across chunks, usage on the finish line.' },
  { name: 'mock-llmchat', display: 'LLMChat (reasoning_content)', wire: 'reasoning-delta',
    blurb: 'OpenAI deltas plus a separate reasoning channel; one chunk can carry both.' },
  { name: 'mock-mercury', display: 'Mercury (typed events)', wire: 'typed-events',
    blurb: 'reasoning-delta / text-delta / source-url, including the __searching__ placeholder.' },
  { name: 'mock-cloudflare', display: 'Cloudflare Workers (raw)', wire: 'workers-raw',
    blurb: 'Bare {"response":"…"} chunks — no choices array at all.' },
  { name: 'mock-openai', display: 'OpenAI delta (DeepInfra / Dolphin)', wire: 'openai-delta',
    blurb: 'The common shape: choices[0].delta.content, terminated by [DONE].' },
];
