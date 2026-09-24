/**
 * protocol.js — pure logic: SSE parser, think-tag splitter, source
 * formatter, stream events, usage department. No I/O.
 *
 * Direct port of New Upstage Change Logs upstage_provider.py §4–§8.
 */
import { MODELS, resolveModel } from './config.js';

export const OPEN_THINK = '<' + 'think' + '>';
export const CLOSE_THINK = '</' + 'think' + '>';

// ═══════════════════════════════════════════════════════════
// SSE PARSER
// ═══════════════════════════════════════════════════════════
/**
 * Parse one Upstage SSE line → array of [event_type, content].
 *   r-delta | t-delta | source | s-start | s-summary | usage | done
 * A single line can yield several events (final chunk: usage + stop).
 */
export function parseSSELine(line) {
  if (!line || !line.startsWith('data: ')) return [];

  const data = line.slice(6).trim();
  if (data === '[DONE]') return [['done', '']];

  let obj;
  try {
    obj = JSON.parse(data);
  } catch {
    return [];
  }

  const events = [];

  // ── search events (arrive WITHOUT choices) ──
  const search = obj.search;
  if (obj.choices == null && search) {
    const st = search.status || {};
    const action = st.action || '';
    const desc = st.description || '';
    const rawSq = search.search_queries;

    if (action === 'search_start') {
      let query = '';
      if (Array.isArray(rawSq) && rawSq.length) query = rawSq[0].query || '';
      events.push(['s-start', query]);
    } else if (action === 'search_finish') {
      if (rawSq) events.push(['source', JSON.stringify(rawSq)]);
    } else if (action === 'summarizing') {
      events.push(['s-summary', desc]);
    }
  } else if (Array.isArray(obj.choices) && obj.choices.length) {
    // ── content / thinking chunks ──
    const delta = obj.choices[0].delta || {};

    const rc = delta.reasoning_content || '';
    if (rc) events.push(['r-delta', rc]);

    const text = delta.content || '';
    if (text) events.push(['t-delta', text]);
  }

  // ── usage only when non-zero ──
  const usage = obj.usage;
  if (
    usage &&
    typeof usage === 'object' &&
    (usage.prompt_tokens || usage.completion_tokens || usage.total_tokens)
  ) {
    events.push(['usage', JSON.stringify(usage)]);
  }

  // ── done LAST so same-line usage isn't skipped ──
  if (
    Array.isArray(obj.choices) &&
    obj.choices.length &&
    obj.choices[0].finish_reason === 'stop'
  ) {
    events.push(['done', '']);
  }

  return events;
}

// ═══════════════════════════════════════════════════════════
// SOURCES
// ═══════════════════════════════════════════════════════════
export class Sources {
  static parse(rawJsonList) {
    const seen = new Set();
    const result = [];
    let idx = 0;

    for (const raw of rawJsonList || []) {
      let queries;
      try {
        queries = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        continue;
      }
      if (!Array.isArray(queries)) continue;

      for (const qData of queries) {
        const queryText = qData.query || '';
        const rawResults = qData.results;
        if (!Array.isArray(rawResults)) continue;

        for (const r of rawResults) {
          const url = String(r.url || '').trim();
          const title = String(r.title || '').trim();
          let score = Number(r.score ?? 0);
          if (!Number.isFinite(score)) score = 0;
          const content = String(r.content || '').trim();

          if (!url || seen.has(url)) continue;
          seen.add(url);
          idx += 1;

          let snippet = content.slice(0, 200).replace(/\n/g, ' ').trim();
          if (content.length > 200) snippet += '...';

          result.push({
            index: idx,
            query: queryText,
            title: title || 'Untitled',
            url,
            score,
            snippet,
          });
        }
      }
    }
    return result;
  }

  static formatText(sources) {
    if (!sources?.length) return '';
    const lines = [
      '',
      '  ┌─────────────────────────────────────────',
      `  │ 📚 Sources (${sources.length})`,
    ];
    for (const s of sources) {
      lines.push(`  │  [${s.index ?? '?'}] ${s.title ?? ''}`);
      lines.push(`  │      ${s.url ?? ''}`);
      if (s.score) {
        lines.push(`  │      Score: ${Number(s.score).toFixed(4)}`);
      }
    }
    lines.push('  └─────────────────────────────────────────');
    return lines.join('\n');
  }

  static formatJson(sources) {
    const clean = (sources || []).map((s) => ({
      title: s.title || '',
      url: s.url || '',
      score: s.score || 0,
    }));
    return JSON.stringify({ sources: clean });
  }
}

// ═══════════════════════════════════════════════════════════
// THINK SPLITTER
// ═══════════════════════════════════════════════════════════
/**
 * Content deltas may inline <think>…## markup, and tags can split
 * across tokens. Feed raw tokens; get [kind, segment] pairs with
 * kind ∈ {content, thinking}. Partial tags are held until decided;
 * flush() releases the remainder at stream end.
 */
export class ThinkSplitter {
  constructor(openTag = OPEN_THINK, closeTag = CLOSE_THINK) {
    this._open = openTag;
    this._close = closeTag;
    this._buf = '';
    this._in = false;
  }

  feed(text) {
    const out = [];
    this._buf += text;
    for (;;) {
      if (this._in) {
        const j = this._buf.indexOf(this._close);
        if (j === -1) {
          const hold = this._close.length - 1;
          let seg = '';
          if (this._buf.length > hold) {
            seg = this._buf.slice(0, this._buf.length - hold);
            this._buf = this._buf.slice(this._buf.length - hold);
          }
          if (seg) out.push(['thinking', seg]);
          break;
        }
        const seg = this._buf.slice(0, j);
        if (seg) out.push(['thinking', seg]);
        this._in = false;
        this._buf = this._buf.slice(j + this._close.length);
      } else {
        const i = this._buf.indexOf(this._open);
        if (i === -1) {
          const hold = this._open.length - 1;
          let seg = '';
          if (this._buf.length > hold) {
            seg = this._buf.slice(0, this._buf.length - hold);
            this._buf = this._buf.slice(this._buf.length - hold);
          }
          if (seg) out.push(['content', seg]);
          break;
        }
        const seg = this._buf.slice(0, i);
        if (seg) out.push(['content', seg]);
        this._in = true;
        this._buf = this._buf.slice(i + this._open.length);
      }
    }
    return out;
  }

  flush() {
    if (!this._buf) return [];
    const kind = this._in ? 'thinking' : 'content';
    const seg = this._buf;
    this._buf = '';
    return [[kind, seg]];
  }
}

// ═══════════════════════════════════════════════════════════
// STREAM EVENT + USAGE DEPARTMENT
// ═══════════════════════════════════════════════════════════
/** @typedef {{kind: 'sources'|'thinking'|'content'|'done', text: string}} StreamEvent */

export class TurnUsage {
  constructor(init = {}) {
    this.model = init.model ?? 'solar-pro3';
    this.ok = init.ok ?? true;
    this.error = init.error ?? '';
    this.prompt_chars = init.prompt_chars ?? 0;
    this.thinking_chars = init.thinking_chars ?? 0;
    this.content_chars = init.content_chars ?? 0;
    this.n_sources = init.n_sources ?? 0;
    this.api_usage = init.api_usage ?? null;
    this.elapsed_s = init.elapsed_s ?? 0;
    this.first_token_s = init.first_token_s ?? null;
  }

  get tokens_estimated() {
    return !(this.api_usage && (this.api_usage.total_tokens || 0) > 0);
  }

  get tokens() {
    if (!this.tokens_estimated) return Number(this.api_usage.total_tokens) || 0;
    const chars = this.thinking_chars + this.content_chars;
    return chars > 0 ? Math.max(1, Math.round(chars / 4)) : 0;
  }

  get tokens_per_s() {
    if (this.elapsed_s <= 0) return null;
    return this.tokens / this.elapsed_s;
  }

  to_dict() {
    return {
      model: this.model,
      ok: this.ok,
      error: this.error,
      prompt_chars: this.prompt_chars,
      thinking_chars: this.thinking_chars,
      content_chars: this.content_chars,
      n_sources: this.n_sources,
      api_usage: this.api_usage,
      elapsed_s: Math.round(this.elapsed_s * 10000) / 10000,
      first_token_s:
        this.first_token_s == null
          ? null
          : Math.round(this.first_token_s * 10000) / 10000,
      tokens: this.tokens,
      tokens_estimated: this.tokens_estimated,
    };
  }

  formatLine() {
    const bits = [`⏱ ${this.elapsed_s.toFixed(1)}s`];
    if (this.first_token_s != null) {
      bits.push(`first token ${this.first_token_s.toFixed(2)}s`);
    }
    if (this.tokens) {
      const est = this.tokens_estimated ? ' (est)' : '';
      bits.push(`~${this.tokens} tok${est}`);
      if (this.tokens_per_s) bits.push(`${Math.round(this.tokens_per_s)} tok/s`);
    }
    if (this.thinking_chars) bits.push(`💭 ${this.thinking_chars}c`);
    bits.push(this.model);
    if (this.n_sources) bits.push(`📚 ${this.n_sources}`);
    if (!this.ok) bits.push(`✗ ${this.error.slice(0, 40)}`);
    return bits.join(' · ');
  }
}

export class SessionUsage {
  constructor() {
    this.turns = [];
  }

  add(turn) {
    this.turns.push(turn);
  }

  clear() {
    this.turns = [];
  }

  totals() {
    const ok = this.turns.filter((t) => t.ok);
    return {
      turns: this.turns.length,
      ok: ok.length,
      failed: this.turns.length - ok.length,
      elapsed_s: Math.round(ok.reduce((s, t) => s + t.elapsed_s, 0) * 100) / 100,
      tokens: ok.reduce((s, t) => s + t.tokens, 0),
      thinking_chars: ok.reduce((s, t) => s + t.thinking_chars, 0),
      content_chars: ok.reduce((s, t) => s + t.content_chars, 0),
      sources: ok.reduce((s, t) => s + t.n_sources, 0),
    };
  }

  formatReport() {
    if (!this.turns.length) return '  (no turns yet)';
    const lines = [
      '',
      '  ┌──────────────────────────────────────────────────────────────────',
      '  │ 📊 Session usage',
      '  │  turn  status      time     tokens   thinking  answer   src  model',
      '  │  ──────  ─────────  ──────  ────────  ────────  ──────  ───  ─────',
    ];
    this.turns.forEach((t, i) => {
      const status = t.ok ? '✓' : `✗ ${t.error.slice(0, 14)}`;
      lines.push(
        `  │  ${String(i + 1).padEnd(6)} ${status.padEnd(11)} ` +
          `${t.elapsed_s.toFixed(1).padStart(5)}s  ${String(t.tokens).padStart(6)}  ` +
          `${String(t.thinking_chars).padStart(6)}    ${String(t.content_chars).padStart(4)}   ` +
          `${String(t.n_sources).padStart(2)}  ${t.model}`,
      );
    });
    const tt = this.totals();
    lines.push(
      '  │  ──────  ─────────  ──────  ────────  ────────  ──────  ───  ─────',
    );
    lines.push(
      `  │  TOTAL  ${tt.turns} turns (${tt.ok} ok, ${tt.failed} failed) · ` +
        `${tt.elapsed_s.toFixed(1)}s · ~${tt.tokens} tokens · ${tt.sources} sources`,
    );
    lines.push('  └──────────────────────────────────────────────────────────────────');
    return lines.join('\n');
  }
}

/**
 * Build the playground completions payload (pure).
 * Priority: explicit args > instance defaults > model config.
 * search on → reasoning high + tavily + mode:["search"] on last user msg.
 */
export function buildPayload({
  messages,
  model,
  search,
  reasoning,
  temperature,
  maxTokens,
  system = '',
  instanceTemperature = null,
  instanceMaxTokens = null,
}) {
  const cfg = MODELS[model] || MODELS['solar-pro3'];
  const temp =
    temperature != null
      ? temperature
      : instanceTemperature != null
        ? instanceTemperature
        : cfg.temperature;
  const tok =
    maxTokens != null
      ? maxTokens
      : instanceMaxTokens != null
        ? instanceMaxTokens
        : cfg.max_tokens;

  const msgs = messages.map((m) => ({ ...m }));

  if (!msgs.length || msgs[0].role !== 'system') {
    const sysContent = system || cfg.system || '';
    if (sysContent) msgs.unshift({ role: 'system', content: sysContent });
  }

  if (search && cfg.search) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        msgs[i].mode = ['search'];
        break;
      }
    }
  }

  const payload = {
    conversation_id: crypto.randomUUID(),
    stream: true,
    log_enabled: true,
    messages: msgs,
    model,
    temperature: temp,
    max_tokens: tok,
  };

  if (cfg.reasoning) {
    const valid = cfg.reasoning;
    let effort = search
      ? valid.includes('high')
        ? 'high'
        : valid[valid.length - 1]
      : valid.includes('low')
        ? 'low'
        : valid[0];
    if (reasoning && valid.includes(reasoning)) effort = reasoning;
    payload.reasoning_effort = effort;
  }

  if (cfg.metadata) payload.metadata = cfg.metadata;
  if (search && cfg.search) payload.search_provider = 'tavily';

  return payload;
}

export { MODELS, resolveModel };
