/**
 * Protocol constants for Inception's official API (api.inceptionlabs.ai).
 *
 * Why this API: it is the OpenAI-compatible endpoint Inception built for apps, and it
 * answers cross-origin requests — it reflects the page's Origin in
 * `Access-Control-Allow-Origin` (FastAPI/Starlette CORS), and Inception's own
 * TypeScript SDK lists web browsers as a supported runtime. So a plain web page can
 * call it straight from the user's browser: no extension, no proxy, no server of ours.
 * (chat.inceptionlabs.ai, the private backend of Inception's own chat site, rejects
 * other origins and sits behind a bot checkpoint, so a website can't use it.)
 *
 * Verified 2026-09-25 against the docs (docs.inceptionlabs.ai), the OpenAPI spec,
 * the public model list and the live CORS headers.
 */

export const DEFAULT_API_URL = 'https://api.inceptionlabs.ai';

export const ENDPOINTS = {
  chat: '/v1/chat/completions',
  models: '/v1/models',
} as const;

export const LINKS = {
  keys: 'https://platform.inceptionlabs.ai/dashboard/api-keys',
  billing: 'https://platform.inceptionlabs.ai/dashboard/billing',
  platform: 'https://platform.inceptionlabs.ai',
  docs: 'https://docs.inceptionlabs.ai',
} as const;

/** New Inception accounts get this many free tokens, no card needed (docs, Quick Start). */
export const FREE_TOKENS_LABEL = '100 million';

/** `reasoning_effort` values. The API default is "medium". */
export const REASONING_EFFORTS = ['instant', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_EFFORT: ReasoningEffort = 'medium';

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  instant: 'Instant',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export interface ModelInfo {
  id: string;
  /** Display name, e.g. "Mercury 2.5". */
  name: string;
  contextLength?: number;
  /** Largest `max_completion_tokens` the model accepts. */
  maxOutput?: number;
  /** US dollars per token. */
  pricing?: { prompt: number; completion: number };
}

/** Shown until the live list (GET /v1/models) arrives, or if it never does. Mirrors it on 2026-09-25. */
export const FALLBACK_MODELS: readonly ModelInfo[] = [
  { id: 'mercury-2.5', name: 'Mercury 2.5', contextLength: 260_000, maxOutput: 65_536, pricing: { prompt: 0.00000004, completion: 0.00000015 } },
  { id: 'mercury-2', name: 'Mercury 2', contextLength: 128_000, maxOutput: 50_000, pricing: { prompt: 0.00000025, completion: 0.00000075 } },
];

export const DEFAULT_MODEL = 'mercury-2.5';

/**
 * Answer length budgets (`max_completion_tokens`, which also covers reasoning tokens).
 * Clamped to the model's own maximum when sent.
 */
export const LENGTH_LIMITS = [4_096, 16_384, 65_536] as const;
export const DEFAULT_LENGTH_LIMIT = 16_384;

/** 429 and 5xx before the first byte: retry with exponential backoff (the docs recommend it). */
export const RETRY_ATTEMPTS = 3;
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 8_000;

/** Give up on a request whose response headers take longer than this. */
export const RESPONSE_TIMEOUT_MS = 120_000;
/** Give up on a stream that goes silent for longer than this. */
export const IDLE_TIMEOUT_MS = 90_000;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Normalise an API base URL: trim, drop trailing slashes and a trailing `/v1`. */
export function normaliseApiUrl(url: string | undefined | null): string {
  const value = (url ?? '').trim() || DEFAULT_API_URL;
  return value.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** "Inception: Mercury 2.5" → "Mercury 2.5". */
export function displayModelName(name: string | undefined, id: string): string {
  const cleaned = (name ?? '').replace(/^Inception:\s*/i, '').trim();
  if (cleaned) return cleaned;
  return id.replace(/^mercury/i, 'Mercury').replace(/-/g, ' ');
}
