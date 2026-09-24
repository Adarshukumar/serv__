import { SYSTEM_PREFIX } from './config';
import { createId } from './ids';

/** A finished turn of the conversation, as the app stores it. */
export interface ChatTurn {
  id?: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface WireTextPart {
  type: 'text';
  text: string;
  state?: 'done';
}

/** A UI message in the exact shape the web app's `useChat()` sends. */
export interface WireMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: WireTextPart[];
}

/**
 * Convert app turns into the web app's message list.
 *
 * - Empty turns are dropped.
 * - The site has no system role, so custom instructions are prepended to the first
 *   user turn as "[SYSTEM INSTRUCTION] …" (same approach as the Python provider).
 * - Consecutive turns with the same role are merged with a blank line, so the list
 *   always alternates (this happens e.g. after a failed answer).
 * - Assistant parts carry `state: "done"`, like finished messages in the web app.
 */
export function toWireMessages(turns: readonly ChatTurn[], system?: string): WireMessage[] {
  const cleaned = turns
    .map((t) => ({ ...t, text: (t.text ?? '').trim() }))
    .filter((t) => t.text.length > 0);

  const instruction = (system ?? '').trim();
  if (instruction) {
    const firstUser = cleaned.findIndex((t) => t.role === 'user');
    if (firstUser >= 0) {
      const turn = cleaned[firstUser]!;
      cleaned[firstUser] = { ...turn, text: `${SYSTEM_PREFIX} ${instruction}\n\n${turn.text}` };
    }
  }

  const merged: ChatTurn[] = [];
  for (const turn of cleaned) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      merged[merged.length - 1] = { ...last, text: `${last.text}\n\n${turn.text}` };
    } else {
      merged.push(turn);
    }
  }

  return merged.map((turn) => ({
    id: turn.id || createId(),
    role: turn.role,
    parts: [turn.role === 'assistant' ? { type: 'text', text: turn.text, state: 'done' } : { type: 'text', text: turn.text }],
  }));
}

export interface ChatRequestBody {
  reasoningEffort: string;
  webSearchEnabled: boolean;
  voiceMode: boolean;
  timezone: string;
  id: string;
  messages: WireMessage[];
  trigger: 'submit-message';
}

/** Build the /api/chat body exactly like the AI SDK transport does for the web app. */
export function buildChatBody(input: {
  chatId: string;
  messages: WireMessage[];
  thinking: string;
  webSearch: boolean;
  timezone?: string;
}): ChatRequestBody {
  return {
    reasoningEffort: input.thinking,
    webSearchEnabled: input.webSearch,
    voiceMode: false,
    timezone: input.timezone || detectTimezone(),
    id: input.chatId,
    messages: input.messages,
    trigger: 'submit-message',
  };
}

export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
