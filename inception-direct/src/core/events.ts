import { SEARCH_ERROR_MARKER, SEARCHING_MARKER } from './config';

export interface Source {
  id: string;
  url: string;
  title: string;
}

/**
 * Typed events produced from the server's UI-message stream (Vercel AI SDK v5 format).
 *
 * Python's `chat()` mixed reasoning, a JSON blob of sources and the answer into one
 * string stream with no markers, silently dropped `error` events, and kept only the
 * first source. Here every kind of data gets its own event.
 */
export type StreamEvent =
  | { type: 'start'; messageId?: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'source'; source: Source }
  /** The server is running a web search (the `__searching__` placeholder source). */
  | { type: 'searching' }
  /** Web search failed; the answer continues without it. */
  | { type: 'search-error' }
  | { type: 'error'; message: string }
  | { type: 'finish'; finishReason?: string }
  | { type: 'abort' }
  /** The literal `[DONE]` terminator. */
  | { type: 'done' };

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** Map one SSE `data` payload to a typed event, or `null` for events we don't need. */
export function parseStreamPayload(data: string): StreamEvent | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  if (trimmed === '[DONE]') return { type: 'done' };

  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  switch (obj.type) {
    case 'start':
      return { type: 'start', messageId: str(obj.messageId) || undefined };

    case 'reasoning-delta':
    case 'reasoning': {
      const delta = str(obj.delta ?? obj.text ?? obj.textDelta);
      return delta ? { type: 'reasoning-delta', delta } : null;
    }

    case 'text-delta':
    case 'text': {
      const delta = str(obj.delta ?? obj.text ?? obj.textDelta);
      return delta ? { type: 'text-delta', delta } : null;
    }

    case 'source-url':
    case 'source': {
      const id = str(obj.sourceId ?? obj.id);
      const title = str(obj.title);
      const url = str(obj.url);
      // The web app checks `title`; older builds used `sourceId`. Accept both.
      if (title === SEARCHING_MARKER || id === SEARCHING_MARKER) return { type: 'searching' };
      if (title === SEARCH_ERROR_MARKER || id === SEARCH_ERROR_MARKER) return { type: 'search-error' };
      if (!url) return null;
      return { type: 'source', source: { id: id || url, url, title } };
    }

    case 'error':
      return { type: 'error', message: str(obj.errorText ?? obj.error ?? obj.message) || 'The model reported an error.' };

    case 'finish':
      return { type: 'finish', finishReason: str(obj.finishReason) || undefined };

    case 'abort':
      return { type: 'abort' };

    default:
      // start-step, finish-step, text-start/end, reasoning-start/end, message-metadata,
      // data-*, tool-* … carry nothing the UI needs.
      return null;
  }
}

/** Keeps sources unique by URL, preserving arrival order. */
export class SourceCollector {
  private readonly byUrl = new Map<string, Source>();

  add(source: Source): boolean {
    const key = normaliseUrl(source.url);
    const existing = this.byUrl.get(key);
    if (existing) {
      if (!existing.title && source.title) existing.title = source.title;
      return false;
    }
    this.byUrl.set(key, { ...source });
    return true;
  }

  list(): Source[] {
    return [...this.byUrl.values()];
  }
}

function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}
