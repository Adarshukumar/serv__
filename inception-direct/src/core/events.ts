/**
 * Typed events from the API's server-sent `chat.completion.chunk` stream
 * (OpenAI-compatible, plus Inception's extensions):
 *
 *   data: {"id":…,"object":"chat.completion.chunk","model":"mercury-2.5",
 *          "choices":[{"index":0,"delta":{"content":"…"},"finish_reason":null}]}
 *   …
 *   data: {…,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
 *          "reasoning_summary":{"content":"…","status":"complete"}}
 *   data: {…,"choices":[],"usage":{…}}          ← with stream_options.include_usage
 *   data: [DONE]
 *
 * In diffusing mode (`diffusing: true`) every chunk's `delta.content` is the *whole*
 * text at that denoising step, so it replaces what came before instead of appending.
 */

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Part of completionTokens spent on reasoning. */
  reasoningTokens: number;
  /** Part of promptTokens served from the prefix cache. */
  cachedTokens: number;
}

export interface ReasoningSummary {
  content: string;
  status: 'complete' | 'unavailable' | 'skipped';
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | (string & {});

export type StreamEvent =
  /** Which response this is (sent once, from the first chunk). */
  | { type: 'meta'; id?: string; model?: string }
  /** Normal streaming: a block of new text to append. */
  | { type: 'delta'; text: string }
  /** Diffusing mode: the full text at this denoising step. */
  | { type: 'canvas'; text: string }
  | { type: 'reasoning-summary'; summary: ReasoningSummary }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason }
  /** e.g. "temperature reset to the model default". */
  | { type: 'warning'; message: string }
  /** An error object sent inside the stream. */
  | { type: 'error'; message: string; code?: string }
  /** The literal `[DONE]` terminator. */
  | { type: 'done' };

export type StreamMode = 'append' | 'replace';

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function parseUsage(value: unknown): Usage | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as Record<string, unknown>;
  if (typeof u.prompt_tokens !== 'number' && typeof u.completion_tokens !== 'number') return null;
  const completionDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const promptDetails = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: num(u.total_tokens) || promptTokens + completionTokens,
    reasoningTokens: num(completionDetails.reasoning_tokens) || num(u.reasoning_tokens),
    cachedTokens: num(promptDetails.cached_tokens) || num(u.cached_input_tokens),
  };
}

function parseSummary(value: unknown): ReasoningSummary | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  const content = typeof s.content === 'string' ? s.content : '';
  const status = s.status === 'complete' || s.status === 'skipped' ? s.status : content ? 'complete' : 'unavailable';
  return { content, status };
}

/** Map one SSE `data` payload to the events it carries (a chunk can carry several). */
export function parseChunk(data: string, mode: StreamMode): StreamEvent[] {
  const trimmed = data.trim();
  if (!trimmed) return [];
  if (trimmed === '[DONE]') return [{ type: 'done' }];

  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    obj = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  if (obj.error) {
    const e = obj.error as Record<string, unknown> | string;
    const message = typeof e === 'string' ? e : typeof e.message === 'string' && e.message ? e.message : 'The model reported an error.';
    const code = typeof e === 'object' && typeof e.code === 'string' ? e.code : undefined;
    return [{ type: 'error', message, code }];
  }

  const out: StreamEvent[] = [];
  if (typeof obj.id === 'string' || typeof obj.model === 'string') {
    out.push({ type: 'meta', id: typeof obj.id === 'string' ? obj.id : undefined, model: typeof obj.model === 'string' ? obj.model : undefined });
  }
  if (typeof obj.warning === 'string' && obj.warning.trim()) out.push({ type: 'warning', message: obj.warning.trim() });

  const choices = Array.isArray(obj.choices) ? (obj.choices as Record<string, unknown>[]) : [];
  const choice = choices.find((c) => c && (c.index ?? 0) === 0) ?? choices[0];
  if (choice && typeof choice === 'object') {
    const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
    const content = delta?.content;
    if (typeof content === 'string') {
      if (mode === 'replace') out.push({ type: 'canvas', text: content });
      else if (content) out.push({ type: 'delta', text: content });
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      out.push({ type: 'finish', reason: choice.finish_reason });
    }
  }

  const summary = parseSummary(obj.reasoning_summary);
  if (summary) out.push({ type: 'reasoning-summary', summary });
  const usage = parseUsage(obj.usage);
  if (usage) out.push({ type: 'usage', usage });
  return out;
}
