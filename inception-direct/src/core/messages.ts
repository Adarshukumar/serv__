import type { ReasoningEffort } from './config';

/** One finished turn of the conversation, as the app keeps it. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** A message in the API's (OpenAI-compatible) format. */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * History → API messages. Custom instructions become a real `system` message (the API
 * supports the role, unlike the chat site the Python version talked to). Empty turns
 * are dropped and consecutive turns from the same side are merged, so a failed answer
 * never leaves two user messages in a row.
 */
export function toApiMessages(turns: readonly ChatTurn[], system?: string): ApiMessage[] {
  const out: ApiMessage[] = [];
  const instructions = system?.trim();
  if (instructions) out.push({ role: 'system', content: instructions });
  for (const turn of turns) {
    if (!turn.text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.content += `\n\n${turn.text}`;
    else out.push({ role: turn.role, content: turn.text });
  }
  return out;
}

export interface ChatRequestOptions {
  model: string;
  messages: ApiMessage[];
  effort: ReasoningEffort;
  /** Stream the model's denoising steps (each chunk = full text so far). */
  diffusing: boolean;
  /** max_completion_tokens (includes reasoning tokens). */
  maxTokens: number;
  /** Ask for a summary of the reasoning (arrives with the final chunk). */
  reasoningSummary: boolean;
}

/** Body for POST /v1/chat/completions, streaming. Only documented parameters are sent. */
export function buildChatRequest(o: ChatRequestOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: o.model,
    messages: o.messages,
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: o.effort,
    max_completion_tokens: o.maxTokens,
  };
  if (o.diffusing) body.diffusing = true;
  // "instant" does no reasoning worth summarising.
  if (o.reasoningSummary && o.effort !== 'instant') body.reasoning_summary = true;
  return body;
}

/** The smallest real request: proves key, credit, model and CORS in one round trip (≈15 tokens). */
export function buildHandshakeRequest(model: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    max_completion_tokens: 1,
    reasoning_effort: 'instant',
    stream: false,
  };
}

const FOLLOW_UP_SYSTEM =
  'You suggest follow-up questions for a chat between a user and an AI assistant. ' +
  'Write exactly three short, specific questions the user is likely to ask next, ' +
  'in the same language the user writes in. Each under 14 words. No numbering, no quotes.';

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A small structured-output request that asks the model for follow-up questions. */
export function buildFollowUpsRequest(model: string, turns: readonly ChatTurn[]): Record<string, unknown> {
  const recent = turns.slice(-4);
  const transcript = recent
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${clip(t.text.trim(), t.role === 'user' ? 1_500 : 4_000)}`)
    .join('\n\n');
  return {
    model,
    messages: [
      { role: 'system', content: FOLLOW_UP_SYSTEM },
      { role: 'user', content: `Conversation so far:\n\n${transcript}\n\nSuggest the three follow-up questions.` },
    ],
    reasoning_effort: 'instant',
    max_completion_tokens: 300,
    stream: false,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'follow_ups',
        strict: true,
        schema: {
          type: 'object',
          properties: { follow_ups: { type: 'array', items: { type: 'string' } } },
          required: ['follow_ups'],
          additionalProperties: false,
        },
      },
    },
  };
}

/** Read follow-ups from the model's reply: JSON first, then a lenient line-by-line fallback. */
export function parseFollowUps(content: string): string[] {
  let items: unknown[] = [];
  const trimmed = content.trim();
  const json = trimmed.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) items = parsed;
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { follow_ups?: unknown }).follow_ups)) {
      items = (parsed as { follow_ups: unknown[] }).follow_ups;
    }
  } catch {
    items = trimmed.split('\n');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const text = item
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .replace(/^["“]|["”]$/g, '')
      .trim();
    if (text.length < 3 || text.length > 160) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === 3) break;
  }
  return out;
}
