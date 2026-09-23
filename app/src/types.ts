// ══════════════════════════════════════════════════════════════
//  types.ts — the one contract every provider must satisfy
// ══════════════════════════════════════════════════════════════

/** Capability keys actually used by Models.py (verified by executing it). */
export type CapabilityKey = 'reasoning' | 'vision' | 'attachment' | 'search';

export type ProviderId =
  | 'DeepInfra'
  | 'Dolphin'
  | 'LLMChat'
  | 'Mercury'
  | 'Upstage'
  | 'mCloudFlare'
  | 'mock';

/** Shape emitted by scripts/dump_registry.py — mirrors the Python Model dataclass. */
export interface ModelRecord {
  name: string;
  display: string;
  family: string;
  providers: ProviderId[];
  /** provider → the id that provider's API actually wants */
  connection: Record<string, string>;
  /** provider → capability flags. Per-provider, because the same model can
   *  reason on one provider and not on another. */
  capabilities: Record<string, Partial<Record<CapabilityKey, boolean>>>;
  working: Record<string, boolean>;
  /** provider → context window. null means unknown from source — never invented. */
  maxTokens: Record<string, number | null>;
  aliases?: string[];
  description?: string;
  best?: ProviderId;
  provenance?: string;
  /** LLMChat only: the @cf / @hf routing tag required to build the request URL.
   *  Absent from Models.py; joined in from LLmChat.py by the generator. */
  tag?: string;
  /** Upstage only: reasoning effort levels this specific model accepts.
   *  Absent from Models.py; taken from upstage_provider.py _MODELS. */
  reasoningEfforts?: string[];
}

export interface Source {
  id?: string;
  url: string;
  title?: string;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** true when counted locally rather than reported by the provider */
  estimated?: boolean;
}

// ── The unified stream event ────────────────────────────────
// Every adapter, in every wire format, emits ONLY these. The UI renders only
// these. A new provider with a fifth wire format needs one normaliser and zero
// UI changes. (ARCHITECTURE.md §4)
export type StreamEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'content'; text: string }
  | { kind: 'source'; sources: Source[] }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'status'; phase: 'searching' | 'summarizing' | 'connecting'; detail?: string }
  | { kind: 'done'; finishReason?: string }
  | { kind: 'error'; message: string; retryable: boolean };

export type StreamEventKind = StreamEvent['kind'];

/**
 * The four wire formats found in the Python codebase, plus Upstage v3 which is
 * format C *and* inline <think> markup *and* search lifecycle events.
 *   A openai-delta     DeepInfra, Dolphin      choices[0].delta.content
 *   B workers-raw      mCloudFlare             {"response": "..."}
 *   C reasoning-delta  LLMChat                 delta.reasoning_content | .reasoning
 *   D typed-events     Mercury                 {type:"text-delta"|"reasoning-delta"|"source-url"}
 *   E upstage-v3       Upstage                 C + <think> splitting + search.* + usage
 */
export type WireFormat =
  | 'openai-delta'
  | 'workers-raw'
  | 'reasoning-delta'
  | 'typed-events'
  | 'upstage-v3';

/** How a provider is reached. 'direct' = browser→provider (only if that provider
 *  is ever confirmed to allow CORS and ignore Sec-Fetch-*); 'bridge' = via the
 *  local Node bridge, which is what the Python code effectively required. */
export type Transport = 'bridge' | 'direct';

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  blurb: string;
  wire: WireFormat;
  transport: Transport;
  /** Endpoint as lifted from the Python source. */
  endpoint: string;
  accent: string;
  supports: {
    thinking: boolean;
    search: boolean;
    attachments: boolean;
    usage: boolean;
    /** provider needs captured cookies / CSRF before it will answer */
    credentials: boolean;
  };
  /** reasoning effort levels this provider accepts, when it accepts any */
  reasoningEfforts?: string[];
}

// ── Chat state ──────────────────────────────────────────────
export type Role = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  thinking: string;
  sources: Source[];
  usage?: Usage;
  status?: string;
  error?: string;
  model?: string;
  provider?: ProviderId;
  createdAt: number;
  /** ms to first token, measured locally */
  ttftMs?: number;
  /** total ms for the turn */
  elapsedMs?: number;
  streaming?: boolean;
  finishReason?: string;
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  /** The id the provider's own API wants — from ModelRecord.connection[provider]. */
  modelId: string;
  messages: { role: Role; content: string }[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  search?: boolean;
  reasoning?: string;
  /** LLMChat only: @cf / @hf routing tag, joined in from LLmChat.py. */
  tag?: string;
  /** Offline simulator only: which wire format to imitate. */
  wire?: string;
}
