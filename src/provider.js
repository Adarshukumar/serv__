/**
 * provider.js — Upstage Solar async provider (v3 semantics, pure Node).
 *
 * Real-time SSE streaming over got-scraping (browser TLS) straight to
 * ap-northeast-2.apistage.ai with the console CSRF token + session cookie.
 * No mock, no offline fallback: if the network fails, you get the error.
 *
 *   const up = new UpstageProvider();
 *   for await (const tok of up.chat({ data: 'Hello!' })) process.stdout.write(tok);
 *   for await (const ev  of up.stream({ data: 'Hi' }))  console.log(ev.kind, ev.text);
 */
import {
  CONNECT_TIMEOUT,
  STREAM_TIMEOUT,
  UA,
  completionsUrl,
  consoleUrl,
} from './config.js';
import { MODELS } from './config.js';
import { Credentials } from './creds.js';
import {
  SessionUsage,
  Sources,
  ThinkSplitter,
  TurnUsage,
  buildPayload,
  parseSSELine,
  resolveModel,
} from './protocol.js';

export class UpstageError extends Error {}
export class UpstageAuthError extends UpstageError {}
export class UpstageStreamError extends UpstageError {}

export class UpstageProvider {
  /**
   * @param {object} [opts]
   * @param {string} [opts.model]
   * @param {string} [opts.system]
   * @param {boolean} [opts.search]
   * @param {number|null} [opts.maxTokens]
   * @param {number|null} [opts.temperature]
   */
  constructor(opts = {}) {
    this.model = opts.model ? resolveModel(opts.model) : 'solar-pro3';
    this.system = opts.system || '';
    this.search = Boolean(opts.search);
    this.maxTokens = opts.maxTokens ?? null;
    this.temperature = opts.temperature ?? null;

    this.history = [];
    this.last_response = '';
    this.last_reasoning = '';
    this.last_sources = [];
    this.last_sources_text = '';
    this.last_sources_json = '';
    this.last_usage = null;
    this.session_usage = new SessionUsage();

    this._creds = new Credentials();
    this._connected = false;
  }

  // ═══════════════════════════════════════════════════
  // CONNECTION PIPELINE
  // ═══════════════════════════════════════════════════
  async connect() {
    const loaded = await this._creds.load();
    if (loaded) {
      const token = await this._creds.verify();
      if (token) {
        this._connected = true;
        return token;
      }
    }
    const token = await this._creds.capture();
    this._connected = true;
    return token;
  }

  async _ensureConnected() {
    if (!this._connected) await this.connect();
  }

  async _getCsrf() {
    let token = await this._creds.verify();
    if (token) return token;
    await this._creds.capture();
    token = await this._creds.verify();
    if (token) return token;
    throw new UpstageAuthError(
      'Could not obtain CSRF token. Delete cached credentials and retry.',
    );
  }

  // ═══════════════════════════════════════════════════
  // RAW SSE STREAM (one attempt)
  // ═══════════════════════════════════════════════════
  async *_streamEvents(payload) {
    const { gotScraping } = await import('got-scraping');
    const csrf = await this._getCsrf();

    const headers = {
      accept: '*/*',
      'content-type': 'application/json',
      origin: consoleUrl(),
      referer: `${consoleUrl()}/`,
      'x-csrf-token': csrf,
      'x-session-id': this._creds.sessionId,
      'x-upstage-logging-enabled': 'true',
      'user-agent': UA,
    };

    const cookiePairs = Object.entries(this._creds.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    // gotScraping.stream → true incremental Node stream (no full buffering)
    const stream = gotScraping.stream(completionsUrl(), {
      method: 'POST',
      headers: {
        ...headers,
        ...(cookiePairs ? { cookie: cookiePairs } : {}),
      },
      json: payload,
      timeout: { request: CONNECT_TIMEOUT, response: STREAM_TIMEOUT },
      throwHttpErrors: false,
      https: { rejectUnauthorized: true },
      // direct from this machine — never via proxy/relay
      agent: undefined,
      proxy: undefined,
    });

    // wait for response headers before reading body
    const status = await new Promise((resolve, reject) => {
      stream.once('response', (res) => resolve(res.statusCode));
      stream.once('error', (err) => reject(
        err instanceof UpstageError ? err : new UpstageStreamError(String(err.message || err)),
      ));
    });

    if (status === 401 || status === 403) {
      stream.resume();
      throw new UpstageAuthError(`Auth error: HTTP ${status}`);
    }
    if (status !== 200) {
      let body = '';
      try {
        for await (const chunk of stream) body += chunk.toString('utf8');
      } catch {
        /* ignore */
      }
      throw new UpstageStreamError(`HTTP ${status}: ${body.slice(0, 200)}`);
    }

    let buf = '';
    const decoder = new TextDecoder('utf-8');
    try {
      for await (const chunk of stream) {
        const text =
          typeof chunk === 'string'
            ? chunk
            : decoder.decode(chunk, { stream: true });
        buf += text;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const rawLine = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          for (const ev of parseSSELine(rawLine)) {
            yield ev;
            if (ev[0] === 'done') return;
          }
        }
      }
      if (buf.trim()) {
        for (const ev of parseSSELine(buf.trim())) {
          yield ev;
          if (ev[0] === 'done') return;
        }
      }
    } finally {
      try {
        stream.destroy?.();
      } catch {
        /* ignore */
      }
    }
  }

  async *_eventsWithRetry(payload) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        yield* this._streamEvents(payload);
        return;
      } catch (err) {
        if (err instanceof UpstageAuthError && attempt === 1) {
          await this._creds.capture();
          continue;
        }
        throw err;
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // ★ STREAM (typed, realtime)
  // ═══════════════════════════════════════════════════
  /**
   * Async generator of {kind, text} events.
   * kind ∈ sources | thinking | content | done
   *
   * @param {object} opts
   * @param {string} [opts.data]         simple prompt (ignored if messages)
   * @param {Array}  [opts.messages]     OpenAI-style [{role, content}]
   * @param {string} [opts.model]
   * @param {string} [opts.system]
   * @param {string} [opts.reasoning]    low|medium|high
   * @param {boolean}[opts.search]
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.temperature]
   */
  async *stream(opts = {}) {
    const {
      data,
      messages,
      model,
      system,
      reasoning,
      search,
      maxTokens,
      temperature,
    } = opts;

    if (!messages && !data && data !== '') {
      throw new ValueError("Provide 'messages' or 'data'");
    }
    if (!messages && (data == null || data === '')) {
      throw new ValueError("Provide 'messages' or 'data'");
    }

    await this._ensureConnected();

    const useModel = model ? resolveModel(model) : this.model;
    const useSearch = search != null ? Boolean(search) : this.search;
    const useSystem = system != null ? system : this.system;

    let sendMsgs = [];
    if (messages?.length) {
      const clean = [];
      let sys = useSystem;
      for (const msg of messages) {
        const role = msg.role || '';
        let content = msg.content ?? '';
        if (Array.isArray(content)) {
          content = content
            .filter((p) => p.type === 'text')
            .map((p) => p.text || '')
            .join(' ');
        }
        if (role === 'system') sys = content;
        else if (role === 'user' || role === 'assistant') {
          clean.push({ role, content });
        }
      }
      this.history = clean;
      if (sys) sendMsgs.push({ role: 'system', content: sys });
      sendMsgs.push(...clean);
    } else {
      this.history.push({ role: 'user', content: data });
      if (useSystem) sendMsgs.push({ role: 'system', content: useSystem });
      sendMsgs.push(...this.history);
    }

    const payload = buildPayload({
      messages: sendMsgs,
      model: useModel,
      search: useSearch,
      reasoning,
      temperature,
      maxTokens,
      system: '',
      instanceTemperature: this.temperature,
      instanceMaxTokens: this.maxTokens,
    });

    const t0 = Date.now();
    const usage = new TurnUsage({
      model: useModel,
      prompt_chars: JSON.stringify(sendMsgs).length,
    });
    const splitter = new ThinkSplitter();
    const reasoningParts = [];
    const contentParts = [];
    const rawSources = [];
    let sourcesYielded = false;
    let firstToken = null;
    let completed = false;

    const note = (kind, seg) => {
      if (firstToken == null) firstToken = (Date.now() - t0) / 1000;
      if (kind === 'thinking') {
        reasoningParts.push(seg);
        usage.thinking_chars += seg.length;
      } else {
        contentParts.push(seg);
        usage.content_chars += seg.length;
      }
    };

    try {
      for await (const [etype, econtent] of this._eventsWithRetry(payload)) {
        if (etype === 'done') {
          break;
        } else if (etype === 'source') {
          rawSources.push(econtent);
          if (useSearch && !sourcesYielded && rawSources.length) {
            sourcesYielded = true;
            const fmt = Sources.parse(rawSources);
            this.last_sources = fmt;
            this.last_sources_json = Sources.formatJson(fmt);
            this.last_sources_text = Sources.formatText(fmt);
            usage.n_sources = fmt.length;
            if (firstToken == null) firstToken = (Date.now() - t0) / 1000;
            yield { kind: 'sources', text: this.last_sources_json };
          }
        } else if (etype === 'usage') {
          try {
            const u = JSON.parse(econtent);
            if (u && typeof u === 'object' && Object.keys(u).length) {
              usage.api_usage = u;
            }
          } catch {
            /* ignore */
          }
        } else if (etype === 'r-delta') {
          note('thinking', econtent);
          yield { kind: 'thinking', text: econtent };
        } else if (etype === 't-delta') {
          for (const [kind, seg] of splitter.feed(econtent)) {
            note(kind, seg);
            yield { kind, text: seg };
          }
        }
        // s-start / s-summary: internal
      }

      for (const [kind, seg] of splitter.flush()) {
        note(kind, seg);
        yield { kind, text: seg };
      }

      completed = true;
      yield { kind: 'done', text: '' };
    } catch (err) {
      usage.ok = false;
      usage.error =
        (err instanceof UpstageAuthError ? 'auth: ' : '') +
        String(err.message || err).slice(0, 160);
      throw err instanceof UpstageError
        ? err
        : new UpstageStreamError(`stream failed: ${err.message || err}`);
    } finally {
      if (!completed) {
        for (const [kind, seg] of splitter.flush()) note(kind, seg);
        if (usage.ok && !usage.error) {
          usage.ok = false;
          usage.error = 'stream interrupted';
        }
      }

      usage.elapsed_s = (Date.now() - t0) / 1000;
      usage.first_token_s = firstToken;
      this.last_response = contentParts.join('');
      this.last_reasoning = reasoningParts.join('');

      if (rawSources.length) {
        const fmt = Sources.parse(rawSources);
        if (fmt.length) {
          this.last_sources = fmt;
          this.last_sources_text = Sources.formatText(fmt);
          this.last_sources_json = Sources.formatJson(fmt);
          usage.n_sources = fmt.length;
        }
      }

      this.last_usage = usage;
      this.session_usage.add(usage);

      if (usage.ok && this.last_response) {
        this.history.push({ role: 'assistant', content: this.last_response });
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // ★ CHAT (plain strings)
  // ═══════════════════════════════════════════════════
  async *chat(opts = {}) {
    for await (const ev of this.stream(opts)) yield ev.text;
  }

  // ── setters (chainable) ──────────────────────────────
  setModel(m) {
    this.model = resolveModel(m);
    return this;
  }
  setSystem(p) {
    this.system = p;
    return this;
  }
  setSearch(on) {
    this.search = Boolean(on);
    return this;
  }
  setTemperature(t) {
    this.temperature = t;
    return this;
  }
  setMaxTokens(n) {
    this.maxTokens = n;
    return this;
  }

  clearHistory() {
    this.history = [];
  }

  getHistory() {
    const out = [];
    if (this.system) out.push({ role: 'system', content: this.system });
    out.push(...this.history);
    return out;
  }

  newSession() {
    this.history = [];
    this.last_response = '';
    this.last_reasoning = '';
    this.last_sources = [];
    this.last_sources_text = '';
    this.last_sources_json = '';
    this.last_usage = null;
    this.session_usage.clear();
  }

  async refreshCredentials() {
    return this._creds.capture();
  }

  static async clearCredentials() {
    await new Credentials().clear();
  }

  listModels() {
    return Object.entries(MODELS).map(([name, cfg]) => ({
      name,
      short: name.split('/').pop(),
      label: cfg.label || name,
      reasoning: cfg.reasoning,
      search: cfg.search,
      max_tokens: cfg.max_tokens,
      active: name === this.model,
    }));
  }

  static availableModels() {
    return Object.keys(MODELS);
  }

  static modelInfo() {
    return {
      name: 'Upstage Solar',
      provider: 'Upstage AI',
      models: Object.keys(MODELS),
      thinking: true,
      search: true,
    };
  }

  toJSON() {
    return {
      model: this.model,
      connected: this._connected,
      history: this.history.length,
      turns: this.session_usage.totals().turns,
      search: this.search,
    };
  }
}

class ValueError extends Error {}
