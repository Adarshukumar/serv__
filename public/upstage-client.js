/**
 * upstage-client.js — browser-side Upstage client (user's IP, no server hop).
 *
 * Everything that touches console.upstage.ai / ap-northeast-2.apistage.ai
 * for CONNECT + STREAM runs here, in the page, with the visitor's own
 * network identity. The Node process only serves static files + optional
 * status — it is NOT in the credential/stream path.
 *
 * Flow (same wire protocol as the Python v3 provider):
 *   1. GET  console/playground/chat              → cookies + chunk list
 *   2. GET  _next/static/chunks/*.js             → action id by name
 *   3. POST console/playground/chat next-action  → {"token": csrf}
 *   4. POST apistage .../chat/completions        → SSE (user IP)
 */
(function () {
  'use strict';

  const DEFAULTS = {
    console: 'https://console.upstage.ai',
    api: 'https://ap-northeast-2.apistage.ai',
    chatPath: '/playground/chat',
  };

  /** Mutable endpoints — server may override via /api/health. */
  const cfg = { ...DEFAULTS };
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

  const OPEN_THINK = '<' + 'think' + '>';
  const CLOSE_THINK = '</' + 'think' + '>';
  const CHUNK_RE = /static\/chunks\/[^"\s\],]+\.js/g;

  // ── tiny event log the UI can render ──
  const listeners = [];
  function log(event, detail) {
    const entry = { t: new Date().toISOString(), event, detail };
    (window.__UPSTAGE_NET_LOG = window.__UPSTAGE_NET_LOG || []).push(entry);
    if (window.__UPSTAGE_NET_LOG.length > 200) window.__UPSTAGE_NET_LOG.shift();
    console.log('[upstage-browser]', event, detail);
    listeners.forEach((fn) => {
      try {
        fn(entry);
      } catch {
        /* ignore */
      }
    });
    return entry;
  }
  function onNetLog(fn) {
    listeners.push(fn);
  }

  // ═══════════════════════════════════════════════════════
  // pure helpers (ported)
  // ═══════════════════════════════════════════════════════
  function findActionId(jsText, actionName) {
    const re = new RegExp(
      'createServerReference\\)\\("([a-f0-9]{32,80})"(?:,[^,"]+){3},"' +
        actionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '"\\)',
    );
    const m = jsText.match(re);
    return m ? m[1] : null;
  }

  function parseSSELine(line) {
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
    const search = obj.search;
    if (obj.choices == null && search) {
      const action = (search.status || {}).action || '';
      const rawSq = search.search_queries;
      if (action === 'search_start') {
        let q = '';
        if (Array.isArray(rawSq) && rawSq.length) q = rawSq[0].query || '';
        events.push(['s-start', q]);
      } else if (action === 'search_finish') {
        if (rawSq) events.push(['source', JSON.stringify(rawSq)]);
      } else if (action === 'summarizing') {
        events.push(['s-summary', (search.status || {}).description || '']);
      }
    } else if (Array.isArray(obj.choices) && obj.choices.length) {
      const delta = obj.choices[0].delta || {};
      if (delta.reasoning_content) events.push(['r-delta', delta.reasoning_content]);
      if (delta.content) events.push(['t-delta', delta.content]);
    }
    const usage = obj.usage;
    if (
      usage &&
      typeof usage === 'object' &&
      (usage.prompt_tokens || usage.completion_tokens || usage.total_tokens)
    ) {
      events.push(['usage', JSON.stringify(usage)]);
    }
    if (
      Array.isArray(obj.choices) &&
      obj.choices.length &&
      obj.choices[0].finish_reason === 'stop'
    ) {
      events.push(['done', '']);
    }
    return events;
  }

  class ThinkSplitter {
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

  // ═══════════════════════════════════════════════════════
  // browser session state (cookies we can see + csrf)
  // ═══════════════════════════════════════════════════════
  const state = {
    actionToken: null,
    actionInit: null,
    csrf: null,
    sessionId: null,
    cookies: {}, // name=value we learn from JS-readable sources / storage
    history: [],
    connected: false,
    via: null, // 'browser' | 'server' | null
  };

  function cookieHeader() {
    const parts = Object.entries(state.cookies).map(([k, v]) => `${k}=${v}`);
    // also merge document.cookie if same-site (local npm use)
    if (document.cookie) parts.push(document.cookie);
    return parts.join('; ');
  }

  function rememberCookiesFromResponse(res) {
    // Set-Cookie is a forbidden header in browsers — we can only persist
    // cookies the browser auto-attached (credentials:'include') or that
    // we already had. We still track explicit session_id if the API echoes it.
    try {
      const sc = res.headers.get('set-cookie'); // usually null cross-origin
      if (sc) {
        const m = /session_id=([^;]+)/.exec(sc);
        if (m) state.sessionId = m[1];
      }
    } catch {
      /* forbidden */
    }
  }

  function corsError(err) {
    const msg = String(err && err.message ? err.message : err);
    const isCors =
      msg.includes('Failed to fetch') ||
      msg.includes('NetworkError') ||
      msg.includes('CORS') ||
      err?.name === 'TypeError';
    return { msg, isCors };
  }

  // ═══════════════════════════════════════════════════════
  // 1) CREDENTIAL CAPTURE — browser → console (user IP)
  // ═══════════════════════════════════════════════════════
  async function captureCredentials() {
    const consoleBase = cfg.console;
    const chatUrl = consoleBase + cfg.chatPath;
    log('capture-start', { console: consoleBase, note: 'browser-direct, user IP' });

    const baseHeaders = {
      'user-agent': UA, // ignored by browsers; harmless
      accept: '*/*',
    };

    // 1) page load — browser stores any cookies (credentials include)
    let pageRes;
    try {
      pageRes = await fetch(chatUrl, {
        method: 'GET',
        credentials: 'include',
        headers: baseHeaders,
        mode: 'cors',
      });
    } catch (err) {
      const c = corsError(err);
      log('capture-page-fail', {
        error: c.msg,
        cors: c.isCors,
        hint: c.isCors
          ? 'browser blocked cross-origin read of console.upstage.ai — fall back to local npm process (still user IP when run on your machine)'
          : undefined,
      });
      throw new Error(
        c.isCors
          ? 'CORS: browser cannot read console.upstage.ai from this origin. Use npm start on your machine (same IP) or allow the origin.'
          : c.msg,
      );
    }
    if (!pageRes.ok) {
      log('capture-page-http', { status: pageRes.status });
      throw new Error('playground HTTP ' + pageRes.status);
    }
    rememberCookiesFromResponse(pageRes);
    const html = await pageRes.text();
    log('capture-page-ok', { bytes: html.length });

    // 2) RSC variant (extra chunk refs)
    const chunkRefs = new Set(html.match(CHUNK_RE) || []);
    try {
      const rsc = await fetch(chatUrl, {
        credentials: 'include',
        headers: { ...baseHeaders, RSC: '1' },
        mode: 'cors',
      });
      if (rsc.ok) {
        const body = await rsc.text();
        for (const ref of body.match(CHUNK_RE) || []) chunkRefs.add(ref);
        rememberCookiesFromResponse(rsc);
      }
    } catch {
      /* insurance only */
    }

    // 3) scan JS chunks for action id
    let actionToken = null;
    let actionInit = null;
    let scanned = 0;
    for (const ref of [...chunkRefs].sort().slice(0, 80)) {
      scanned += 1;
      let js;
      try {
        const r = await fetch(consoleBase + '/_next/' + ref, {
          credentials: 'include',
          headers: baseHeaders,
          mode: 'cors',
        });
        if (!r.ok) continue;
        js = await r.text();
      } catch {
        continue;
      }
      if (!actionToken && js.includes('getConsoleCsrfToken')) {
        actionToken = findActionId(js, 'getConsoleCsrfToken');
      }
      if (!actionInit && js.includes('authAction')) {
        actionInit = findActionId(js, 'authAction');
      }
      if (actionToken) break;
    }

    if (!actionToken) {
      log('capture-action-fail', { scanned, chunks: chunkRefs.size });
      throw new Error(
        `getConsoleCsrfToken not found in ${scanned} chunks (origin may block JS reads)`,
      );
    }
    log('capture-action-ok', { action: actionToken.slice(0, 12) + '…', scanned });

    // 4) RSC POST → token
    const tokenRes = await fetch(chatUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...baseHeaders,
        accept: 'text/x-component',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': actionToken,
        origin: consoleBase,
        referer: chatUrl,
      },
      body: '[]',
      mode: 'cors',
    });
    rememberCookiesFromResponse(tokenRes);
    if (!tokenRes.ok) {
      log('capture-token-http', { status: tokenRes.status });
      throw new Error('token action HTTP ' + tokenRes.status);
    }
    const flight = await tokenRes.text();
    let csrf = null;
    for (const line of flight.split(/\r?\n/)) {
      if (line.includes('"token"')) {
        const idx = line.indexOf('{');
        if (idx === -1) continue;
        try {
          const obj = JSON.parse(line.slice(idx));
          if (obj.token) {
            csrf = obj.token;
            break;
          }
        } catch {
          /* next */
        }
      }
    }
    if (!csrf) {
      log('capture-token-missing', { len: flight.length });
      throw new Error('token action answered but no token in response');
    }

    state.actionToken = actionToken;
    state.actionInit = actionInit;
    state.csrf = csrf;
    state.connected = true;
    state.via = 'browser';
    if (!state.sessionId) {
      // best-effort: many consoles accept x-session-id we invent
      state.sessionId =
        state.sessionId ||
        (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    }
    try {
      localStorage.setItem(
        'upstage_browser_creds',
        JSON.stringify({
          actionToken,
          actionInit,
          sessionId: state.sessionId,
          savedAt: Date.now(),
        }),
      );
    } catch {
      /* ignore */
    }
    log('capture-ok', {
      csrf: csrf.slice(0, 16) + '…',
      session: state.sessionId,
      ip_path: 'browser → console (your IP)',
    });
    return csrf;
  }

  async function ensureCreds() {
    if (state.csrf && state.actionToken) return state.csrf;
    try {
      const raw = localStorage.getItem('upstage_browser_creds');
      if (raw) {
        const j = JSON.parse(raw);
        if (j.actionToken && Date.now() - (j.savedAt || 0) < 6 * 3600e3) {
          state.actionToken = j.actionToken;
          state.actionInit = j.actionInit || null;
          state.sessionId = j.sessionId || state.sessionId;
        }
      }
    } catch {
      /* ignore */
    }
    return captureCredentials();
  }

  // ═══════════════════════════════════════════════════════
  // 2) SSE COMPLETIONS — browser → ap-northeast-2 (user IP)
  // ═══════════════════════════════════════════════════════
  function buildPayload({ messages, model, search, reasoning, maxTokens, temperature, system }) {
    const MODELS = window.__UPSTAGE_MODELS__ || {};
    const m = model || 'solar-pro3';
    const cfgM = MODELS[m] || { temperature: 0.8, max_tokens: 65536, reasoning: ['low', 'medium', 'high'], search: true };
    const msgs = messages.map((x) => ({ ...x }));
    if (system && (!msgs.length || msgs[0].role !== 'system')) {
      msgs.unshift({ role: 'system', content: system });
    }
    if (search) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          msgs[i].mode = ['search'];
          break;
        }
      }
    }
    const payload = {
      conversation_id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      stream: true,
      log_enabled: true,
      messages: msgs,
      model: m,
      temperature: temperature != null ? temperature : cfgM.temperature,
      max_tokens: maxTokens || cfgM.max_tokens || 512,
    };
    if (cfgM.reasoning) {
      let effort = search ? 'high' : 'low';
      if (reasoning && cfgM.reasoning.includes(reasoning)) effort = reasoning;
      payload.reasoning_effort = effort;
    }
    if (cfgM.metadata) payload.metadata = cfgM.metadata;
    if (search) payload.search_provider = 'tavily';
    return payload;
  }

  /**
   * Stream one chat turn. Yields {kind,text}.
   * kind ∈ sources | thinking | content | done
   * Uses browser fetch → apistage directly (user IP).
   */
  async function* streamChat(opts) {
    const csrf = await ensureCreds();
    const payload = buildPayload(opts);
    const url =
      cfg.api + '/v1/web/demo/chat/completions?include_think=true';

    log('outbound-completions', {
      url,
      source: 'browser (your IP)',
      model: payload.model,
      search: Boolean(payload.search_provider),
    });

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        mode: 'cors',
        headers: {
          'content-type': 'application/json',
          accept: '*/*',
          origin: cfg.console,
          referer: cfg.console + '/',
          'x-csrf-token': csrf,
          'x-session-id': state.sessionId || '',
          'x-upstage-logging-enabled': 'true',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const c = corsError(err);
      log('completions-fetch-fail', { error: c.msg, cors: c.isCors });
      throw new Error(
        c.isCors
          ? 'CORS blocked browser → apistage. Local npm process path uses your IP too — enable server fallback.'
          : c.msg,
      );
    }

    if (res.status === 401 || res.status === 403) {
      log('completions-auth', { status: res.status });
      // re-capture once
      state.csrf = null;
      const fresh = await captureCredentials();
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        mode: 'cors',
        headers: {
          'content-type': 'application/json',
          accept: '*/*',
          origin: cfg.console,
          referer: cfg.console + '/',
          'x-csrf-token': fresh,
          'x-session-id': state.sessionId || '',
          'x-upstage-logging-enabled': 'true',
        },
        body: JSON.stringify(payload),
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('completions-http', { status: res.status, body: body.slice(0, 160) });
      throw new Error('completions HTTP ' + res.status + ': ' + body.slice(0, 160));
    }
    if (!res.body) throw new Error('completions response has no body stream');

    const splitter = new ThinkSplitter();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let doneEarly = false;

    const emitLines = function* (textChunk) {
      buf += textChunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        for (const ev of parseSSELine(line)) {
          yield ev;
          if (ev[0] === 'done') {
            doneEarly = true;
            return;
          }
        }
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        for (const [etype, econtent] of emitLines(text)) {
          if (etype === 'done') break;
          if (etype === 'source') {
            yield { kind: 'sources', text: econtent };
          } else if (etype === 'r-delta') {
            yield { kind: 'thinking', text: econtent };
          } else if (etype === 't-delta') {
            for (const [k, seg] of splitter.feed(econtent)) {
              yield { kind: k, text: seg };
            }
          } else if (etype === 'usage') {
            // stash for caller
            window.__UPSTAGE_LAST_USAGE__ = JSON.parse(econtent);
          }
        }
        if (doneEarly) break;
      }
      for (const [k, seg] of splitter.flush()) yield { kind: k, text: seg };
      yield { kind: 'done', text: '' };
      log('stream-done', { model: payload.model });
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // public API
  // ═══════════════════════════════════════════════════════
  window.UpstageBrowser = {
    cfg,
    state,
    log,
    onNetLog,
    captureCredentials,
    ensureCreds,
    streamChat,
    ThinkSplitter,
    parseSSELine,
    findActionId,
    get history() {
      return state.history;
    },
    resetHistory() {
      state.history = [];
    },
    configure({ console: c, api: a, models } = {}) {
      if (c) cfg.console = c;
      if (a) cfg.api = a;
      if (models) window.__UPSTAGE_MODELS__ = models;
      log('configure', { console: cfg.console, api: cfg.api });
    },
  };
})();
