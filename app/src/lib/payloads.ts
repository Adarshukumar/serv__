// ══════════════════════════════════════════════════════════════
//  src/lib/payloads.ts — request bodies, built IN THE BROWSER
//
//  Direct-transport port of bridge/payloads.mjs, which was itself a port of the
//  Python providers. The providers do NOT share a payload shape; each builder
//  below mirrors its Python original and names the source lines so any change
//  can be diffed against the thing it was ported from.
//
//  This file exists so a request can be formed entirely client-side and sent
//  straight to the provider's real URL — no relay, no /bridge/chat.
// ══════════════════════════════════════════════════════════════

import type { ChatRequest } from '../types';

/** System-prompt prefixes differ per provider and are load-bearing. */
export const SYS_PREFIX = {
  Upstage: '[SYSTEM INSTRUCTION]',
  Mercury: '[SYSTEM INSTRUCTION]',
  Dolphin: '[SYSTEM] YOU HAVE TO ACT AS :',
} as const;

const rid = (p = 'id') =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type Msg = { role: string; content: string; mode?: string[] };

/** Drop empty/unknown roles the way DeepInfra._build_msgs does. */
function cleanMessages(
  messages: ChatRequest['messages'],
  system: string | undefined,
  { systemRole = 'system' }: { systemRole?: string } = {},
): Msg[] {
  const clean: Msg[] = [];
  let useSystem: string | null = system ?? null;
  for (const m of messages ?? []) {
    const role = m?.role ?? '';
    const content = typeof m?.content === 'string' ? m.content : '';
    if (role === 'user' || role === 'assistant') clean.push({ role, content });
    else if (role === 'system' && system == null) useSystem = content;
  }
  const out: Msg[] = [];
  if (useSystem) out.push({ role: systemRole, content: useSystem });
  out.push(...clean);
  return out;
}

const clampTemp = (t: number | undefined): number | undefined =>
  typeof t === 'number' ? Math.max(0, Math.min(2, t)) : undefined;

// ── DeepInfra.py chat() lines 314-323 ───────────────────────
// stream_options.include_usage is requested but the Python parser ignores it
// (_parse_sse reads only delta.content). Preserved as-is for fidelity.
export function deepInfraPayload(req: ChatRequest) {
  return {
    model: req.modelId,
    messages: cleanMessages(req.messages, req.system),
    temperature: clampTemp(req.temperature ?? 1.0),
    max_tokens: req.maxTokens ?? 2048,
    stream: true,
    stream_options: { include_usage: true },
  };
}

// ── mCloudFlare.py chat() lines 316-322 ─────────────────────
export function mCloudFlarePayload(req: ChatRequest) {
  return {
    model: req.modelId,
    messages: cleanMessages(req.messages, req.system),
    max_tokens: req.maxTokens ?? 2048,
    temperature: clampTemp(req.temperature ?? 1.0),
    stream: true,
  };
}

// ── Dolphin.py _payload() lines 345-357 ─────────────────────
// Dolphin has no system role: SystemConverter.wrap_system folds the system
// prompt into a user turn using _SYS_PREFIX. Template defaults to "creative".
export function dolphinPayload(req: ChatRequest) {
  const messages: Msg[] = [];
  const sys = req.system?.trim();
  if (sys) messages.push({ role: 'user', content: `${SYS_PREFIX.Dolphin} ${sys}` });
  for (const m of req.messages ?? []) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    } else if (m.role === 'system') {
      messages.push({ role: 'user', content: `${SYS_PREFIX.Dolphin} ${m.content}` });
    }
  }
  return { messages, model: req.modelId, template: 'creative' };
}

// ── LLmChat.py _payload() lines 289-297 ─────────────────────
// temperature is OMITTED when null; model travels in the query string, not the body.
export function llmChatPayload(req: ChatRequest) {
  const payload: Record<string, unknown> = {
    messages: cleanMessages(req.messages, req.system),
    max_tokens: req.maxTokens ?? 4096,
    stream: true,
  };
  const t = clampTemp(req.temperature);
  if (t !== undefined) payload.temperature = t;
  return payload;
}

/** LLmChat.py line 315: url = f"{_API}?model={model.endpoint}" where endpoint = f"{tag}/{name}" */
export function llmChatUrl(base: string, tag: string, name: string): string {
  return `${base}?model=${encodeURIComponent(`${tag}/${name}`)}`;
}

// ── Inception.py _Conv.to_mercury() lines 112-163 ───────────
// Mercury's shape is unlike the others: system becomes a prefixed USER turn,
// consecutive user turns are MERGED with "\n\n", and every message becomes
// {id, role, parts:[{type:"text", text, state?}]} with state:"done" on assistant.
export function mercuryPayload(req: ChatRequest) {
  const flat: Msg[] = [];
  if (req.system) flat.push({ role: 'user', content: `${SYS_PREFIX.Mercury} ${req.system}` });

  for (const msg of req.messages ?? []) {
    const content = msg.content ?? '';
    if (msg.role === 'system') flat.push({ role: 'user', content: `${SYS_PREFIX.Mercury} ${content}` });
    else if (msg.role === 'user' || msg.role === 'assistant') flat.push({ role: msg.role, content });
  }

  const merged: Msg[] = [];
  for (const msg of flat) {
    const last = merged[merged.length - 1];
    if (last && msg.role === 'user' && last.role === 'user') last.content += `\n\n${msg.content}`;
    else merged.push({ ...msg });
  }

  return {
    messages: merged.map((msg) => {
      const part: { type: 'text'; text: string; state?: 'done' } = { type: 'text', text: msg.content };
      if (msg.role === 'assistant') part.state = 'done';
      return { id: rid('msg'), role: msg.role, parts: [part] };
    }),
    model: req.modelId,
  };
}

// ── Upstage v3 _build_payload() lines 893-957 ───────────────
// Per-model config from upstage_provider.py _MODELS (lines 152-206).
export interface UpstageModelCfg {
  reasoning: string[] | null;
  search: boolean;
  system: string;
  temperature: number;
  max_tokens: number;
  metadata: Record<string, unknown> | null;
}

export const UPSTAGE_MODELS: Record<string, UpstageModelCfg> = {
  'solar-pro3': { reasoning: ['low', 'medium', 'high'], search: true, system: '', temperature: 0.8, max_tokens: 65536, metadata: null },
  'solar-pro2': { reasoning: ['low', 'high'], search: true, system: '', temperature: 0.8, max_tokens: 16383, metadata: null },
  'syn-pro': { reasoning: ['low', 'high'], search: true, system: '', temperature: 0.7, max_tokens: 16384, metadata: null },
  'solar-mini': { reasoning: null, search: false, system: '', temperature: 0.7, max_tokens: 32768, metadata: null },
};

export function upstagePayload(req: ChatRequest) {
  const cfg = UPSTAGE_MODELS[req.modelId] ?? UPSTAGE_MODELS['solar-pro3'];
  const temp = req.temperature ?? cfg.temperature;
  const tok = req.maxTokens ?? cfg.max_tokens;

  const msgs: Msg[] = (req.messages ?? []).map((m) => ({ ...m }));
  if (!msgs.length || msgs[0].role !== 'system') {
    const sysContent = req.system || cfg.system || '';
    if (sysContent) msgs.unshift({ role: 'system', content: sysContent });
  }

  const search = Boolean(req.search) && Boolean(cfg.search);
  if (search) {
    // Python marks only the LAST user message with mode:["search"].
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        msgs[i].mode = ['search'];
        break;
      }
    }
  }

  const payload: Record<string, unknown> = {
    conversation_id: rid('conv'),
    stream: true,
    log_enabled: true,
    messages: msgs,
    model: req.modelId,
    temperature: temp,
    max_tokens: tok,
  };

  // Auto reasoning: search ON → high, search OFF → low; explicit request wins.
  if (cfg.reasoning) {
    const valid = cfg.reasoning;
    let effort: string;
    if (search) effort = valid.includes('high') ? 'high' : valid[valid.length - 1];
    else effort = valid.includes('low') ? 'low' : valid[0];
    if (req.reasoning && valid.includes(req.reasoning)) effort = req.reasoning;
    payload.reasoning_effort = effort;
  }

  if (cfg.metadata) payload.metadata = cfg.metadata;
  if (search) payload.search_provider = 'tavily';
  return payload;
}
