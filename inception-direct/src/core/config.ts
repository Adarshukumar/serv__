/**
 * Protocol constants for chat.inceptionlabs.ai.
 *
 * Verified against the live web app's own client bundle (Next.js + Vercel AI SDK)
 * on 2026-09-24:
 *   - SessionProvider:  fetch("/api/session") → { ok, token }, refreshed every 780 000 ms
 *   - sessionHeaders(): { "x-session-token": token }
 *   - DefaultChatTransport({ api: "/api/chat", headers: sessionHeaders, retry 429 ×3 })
 *   - sendMessage({ text }, { body: { reasoningEffort, webSearchEnabled, voiceMode, timezone } })
 *   - follow-ups:       POST /api/follow-ups { messages: [{ role, parts }] } → { follow_ups }
 */

export const DEFAULT_BASE_URL = 'https://chat.inceptionlabs.ai';

export const ENDPOINTS = {
  session: '/api/session',
  chat: '/api/chat',
  followUps: '/api/follow-ups',
} as const;

/** The site refreshes every 13 minutes; we refresh a little earlier to stay clear of expiry. */
export const SESSION_REFRESH_MS = 10 * 60_000;

/** Before sending, a token older than this is refreshed first. */
export const SESSION_MAX_AGE_MS = 12 * 60_000;

/** Header the web app uses to carry the session token. */
export const SESSION_HEADER = 'x-session-token';

/** "Thinking mode" values offered by the web app (value → label). Default is "medium". */
export const THINKING_MODES = ['instant', 'low', 'medium', 'high'] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];
export const DEFAULT_THINKING: ThinkingMode = 'medium';

export const THINKING_LABELS: Record<ThinkingMode, string> = {
  instant: 'Instant',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** The web app has no system role; instructions are prepended to the first user turn. */
export const SYSTEM_PREFIX = '[SYSTEM INSTRUCTION]';

/** Rate-limit retry schedule used by the web app's transport: 1.5 s, then 3 s. */
export const RATE_LIMIT_RETRIES = 2;
export const RATE_LIMIT_BACKOFF_MS = 1500;

/** Special source markers the server emits while (or instead of) searching. */
export const SEARCHING_MARKER = '__searching__';
export const SEARCH_ERROR_MARKER = '__search_error__';

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === 'string' && (THINKING_MODES as readonly string[]).includes(value);
}

/** Normalise a base URL: trim, drop trailing slashes. */
export function normaliseBaseUrl(url: string | undefined | null): string {
  const value = (url ?? '').trim() || DEFAULT_BASE_URL;
  return value.replace(/\/+$/, '');
}
