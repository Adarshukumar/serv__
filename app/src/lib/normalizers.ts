// ══════════════════════════════════════════════════════════════
//  normalizers.ts — four provider wire formats → one StreamEvent model
//
//  Each normaliser below is a direct transcription of the corresponding Python
//  parser, with the source location recorded. Nothing is invented: where the
//  Python code ignores a field, this ignores it too.
//
//   A openai-delta     DeepInfra.py  _parse_sse (144-161)
//                      Dolphin.py    _parse_sse (228-250)
//   B workers-raw      mCloudFlare.py _parse_sse (88-100)
//   C reasoning-delta  LLmChat.py    _parse_sse (116-~200)
//   D typed-events     Inception.py  _SSE.parse (59-105)
//   E upstage-v3       upstage_provider.py _SSE.parse_line (237-300) + ThinkSplitter
// ══════════════════════════════════════════════════════════════

import type { Source, StreamEvent, Usage, WireFormat } from '../types';
import { ThinkSplitter } from './thinkSplitter';

export interface Normalizer {
  /** Handle one parsed JSON payload from an SSE `data:` line. */
  push(obj: unknown): StreamEvent[];
  /** Release anything buffered when the stream ends. */
  end(): StreamEvent[];
}

// ── small shared readers ────────────────────────────────────
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstChoice(obj: Record<string, unknown>): Record<string, unknown> | null {
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  return asRecord(choices[0]);
}

function deltaOf(choice: Record<string, unknown> | null): Record<string, unknown> {
  if (!choice) return {};
  return asRecord(choice.delta) ?? {};
}

function finishOf(choice: Record<string, unknown> | null): string | undefined {
  const f = choice?.finish_reason;
  return typeof f === 'string' && f ? f : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ══════════════════════════════════════════════════════════════
//  A — OpenAI delta: choices[0].delta.content
//  DeepInfra ignores finish_reason entirely; Dolphin honours it. The `honourFinish`
//  flag is the only difference between the two, so one normaliser serves both.
// ══════════════════════════════════════════════════════════════
function openAiDelta(honourFinish: boolean): Normalizer {
  return {
    push(obj) {
      const rec = asRecord(obj);
      if (!rec) return [];
      const choice = firstChoice(rec);
      if (!choice) return []; // DeepInfra: `if not choices: return "", False`
      const out: StreamEvent[] = [];
      const text = str(deltaOf(choice).content);
      if (text) out.push({ kind: 'content', text });
      const finish = finishOf(choice);
      if (honourFinish && finish) out.push({ kind: 'done', finishReason: finish });
      return out;
    },
    end: () => [],
  };
}

// ══════════════════════════════════════════════════════════════
//  B — Cloudflare Workers AI raw: {"response": "..."}
//  mCloudFlare.py: `tok = json.loads(data).get("response", "")`
// ══════════════════════════════════════════════════════════════
function workersRaw(): Normalizer {
  return {
    push(obj) {
      const rec = asRecord(obj);
      if (!rec) return [];
      const text = str(rec.response);
      return text ? [{ kind: 'content', text }] : [];
    },
    end: () => [],
  };
}

// ══════════════════════════════════════════════════════════════
//  C — OpenAI delta + reasoning_content (LLMChat)
//  LLmChat.py reads `delta.reasoning_content` and falls back to `delta.reasoning`.
//  A single chunk may carry BOTH reasoning and content, so both are emitted.
//  When neither is present it emits a "meta" event carrying only finish_reason.
//  LLMChat also accepts a bare {"response": "..."} payload as a fallback shape.
// ══════════════════════════════════════════════════════════════
function reasoningDelta(): Normalizer {
  return {
    push(obj) {
      const rec = asRecord(obj);
      if (!rec) return [];
      const out: StreamEvent[] = [];
      const choice = firstChoice(rec);

      if (choice) {
        const delta = deltaOf(choice);
        const finish = finishOf(choice);

        // `reasoning_content` first, then `reasoning` — exact Python order.
        let reasoning = delta.reasoning_content;
        if (reasoning === undefined || reasoning === null) reasoning = delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          out.push({ kind: 'thinking', text: reasoning });
        }

        const content = delta.content;
        if (typeof content === 'string' && content) {
          out.push({ kind: 'content', text: content });
        }

        // Python emits a "meta" event when neither appeared; the only information
        // it can carry is finish_reason, so surface that as done when present.
        if (out.length === 0 && finish) out.push({ kind: 'done', finishReason: finish });
        return out;
      }

      // Fallback shape used by some Workers-style backends behind LLMChat.
      const resp = rec.response;
      if (typeof resp === 'string' && resp) out.push({ kind: 'content', text: resp });
      return out;
    },
    end: () => [],
  };
}

// ══════════════════════════════════════════════════════════════
//  D — Typed events (Mercury / Inception)
//  Inception.py _SSE.parse switches on obj["type"]:
//    "reasoning-delta" → delta text     "text-delta" → delta text
//    "source-url"      → {id,url,title}, SKIPPING sourceId === "__searching__"
//  "__searching__" is a progress placeholder, not a real source, so it becomes a
//  status event instead of being silently dropped.
// ══════════════════════════════════════════════════════════════
function typedEvents(): Normalizer {
  return {
    push(obj) {
      const rec = asRecord(obj);
      if (!rec) return [];
      const type = str(rec.type);
      const delta = str(rec.delta);

      switch (type) {
        case 'reasoning-delta':
          return delta ? [{ kind: 'thinking', text: delta }] : [];
        case 'text-delta':
          return delta ? [{ kind: 'content', text: delta }] : [];
        case 'source-url': {
          const id = str(rec.sourceId);
          if (id === '__searching__') {
            return [{ kind: 'status', phase: 'searching' }];
          }
          const url = str(rec.url);
          if (!url) return [];
          const source: Source = { url };
          if (id) source.id = id;
          const title = str(rec.title);
          if (title) source.title = title;
          return [{ kind: 'source', sources: [source] }];
        }
        default:
          return [];
      }
    },
    end: () => [],
  };
}

// ══════════════════════════════════════════════════════════════
//  E — Upstage v3: the hard one
//
//  upstage_provider.py _SSE.parse_line, plus ThinkSplitter applied to content.
//  Three things happen on one line:
//    1. search lifecycle, but ONLY when `choices` is absent and `search` present
//    2. reasoning_content → thinking, content → <think>-split into thinking/content
//    3. usage, when any token count is non-zero
//  Then `done` is appended LAST so a same-line usage event is not skipped.
// ══════════════════════════════════════════════════════════════
function upstageV3(): Normalizer {
  const splitter = new ThinkSplitter();

  const toUsage = (raw: unknown): Usage | null => {
    const rec = asRecord(raw);
    if (!rec) return null;
    const num = (k: string): number | undefined => {
      const v = rec[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };
    const promptTokens = num('prompt_tokens');
    const completionTokens = num('completion_tokens');
    const totalTokens = num('total_tokens');
    // Python only emits usage when at least one count is truthy (non-zero).
    if (!promptTokens && !completionTokens && !totalTokens) return null;
    const usage: Usage = {};
    if (promptTokens !== undefined) usage.promptTokens = promptTokens;
    if (completionTokens !== undefined) usage.completionTokens = completionTokens;
    if (totalTokens !== undefined) usage.totalTokens = totalTokens;
    return usage;
  };

  return {
    push(obj) {
      const rec = asRecord(obj);
      if (!rec) return [];
      const out: StreamEvent[] = [];

      const hasChoices = rec.choices !== undefined && rec.choices !== null;
      const search = asRecord(rec.search);

      if (!hasChoices && search) {
        // ── search lifecycle ──
        const status = asRecord(search.status) ?? {};
        const action = str(status.action);
        const description = str(status.description);
        const rawQueries = search.search_queries;

        if (action === 'search_start') {
          let query = '';
          if (Array.isArray(rawQueries) && rawQueries.length) {
            query = str(asRecord(rawQueries[0])?.query);
          }
          out.push({ kind: 'status', phase: 'searching', detail: query || undefined });
        } else if (action === 'search_finish') {
          if (Array.isArray(rawQueries) && rawQueries.length) {
            // Python forwards json.dumps(search_queries) verbatim; the entries are
            // {query,url,title}-ish objects, so map them defensively.
            const sources: Source[] = [];
            for (const q of rawQueries) {
              const r = asRecord(q);
              if (!r) continue;
              const url = str(r.url);
              if (!url) continue;
              const s: Source = { url };
              const title = str(r.title);
              if (title) s.title = title;
              const id = str(r.id);
              if (id) s.id = id;
              sources.push(s);
            }
            if (sources.length) out.push({ kind: 'source', sources });
          }
        } else if (action === 'summarizing') {
          out.push({ kind: 'status', phase: 'summarizing', detail: description || undefined });
        }
      } else if (hasChoices) {
        // ── content / thinking ──
        const choice = firstChoice(rec);
        const delta = deltaOf(choice);

        const rc = str(delta.reasoning_content);
        if (rc) out.push({ kind: 'thinking', text: rc });

        const text = str(delta.content);
        if (text) {
          // <think> markup can straddle token boundaries — the splitter holds
          // back a trailing partial tag until the next chunk resolves it.
          for (const [kind, seg] of splitter.feed(text)) {
            if (!seg) continue;
            out.push(kind === 'thinking' ? { kind: 'thinking', text: seg } : { kind: 'content', text: seg });
          }
        }

        if (finishOf(choice) === 'stop') {
          // BUG FIX (found by test 26): the splitter holds back up to
          // len("</think>")-1 = 7 chars in case they begin a split tag, so a
          // short final token like "x" is still sitting in the buffer here.
          // Returning early would silently swallow it.
          //
          // The Python code avoids this differently: _SSE.parse_line emits the
          // RAW t-delta and does the <think> splitting "one level up", so its
          // consumer flushes at stream end. Since this normaliser folds the
          // splitting in, it must flush at the done boundary itself.
          for (const [kind, seg] of splitter.flush()) {
            if (!seg) continue;
            out.push(kind === 'thinking' ? { kind: 'thinking', text: seg } : { kind: 'content', text: seg });
          }
          // usage is pushed BEFORE the done marker, matching Python's
          // "done LAST so a same-line usage event is not skipped".
          const usage = toUsage(rec.usage);
          if (usage) out.push({ kind: 'usage', usage });
          out.push({ kind: 'done', finishReason: 'stop' });
          return out;
        }
      }

      const usage = toUsage(rec.usage);
      if (usage) out.push({ kind: 'usage', usage });
      return out;
    },

    end() {
      const out: StreamEvent[] = [];
      for (const [kind, seg] of splitter.flush()) {
        if (!seg) continue;
        out.push(kind === 'thinking' ? { kind: 'thinking', text: seg } : { kind: 'content', text: seg });
      }
      return out;
    },
  };
}

// ── factory ─────────────────────────────────────────────────
export function createNormalizer(wire: WireFormat): Normalizer {
  switch (wire) {
    case 'openai-delta':
      return openAiDelta(false); // DeepInfra ignores finish_reason
    case 'workers-raw':
      return workersRaw();
    case 'reasoning-delta':
      return reasoningDelta();
    case 'typed-events':
      return typedEvents();
    case 'upstage-v3':
      return upstageV3();
    default: {
      const exhaustive: never = wire;
      throw new Error(`unknown wire format: ${String(exhaustive)}`);
    }
  }
}

/** Dolphin is OpenAI-delta but honours finish_reason as the terminator. */
export function createDolphinNormalizer(): Normalizer {
  return openAiDelta(true);
}
