/* ═══ SILK — chat client ═══════════════════════════════════════════════════
 * Talks to ONE origin: this server. No direct upstream call, no API keys, no
 * session token in the browser. All rendering is escape-first: the model's
 * output can never inject markup.
 */
'use strict';

const SS_KEY = 'silk.session';

const el = {
  log:      document.getElementById('log'),
  empty:    document.getElementById('empty'),
  form:     document.getElementById('form'),
  input:    document.getElementById('input'),
  send:     document.getElementById('send'),
  stop:     document.getElementById('stop'),
  search:   document.getElementById('t-search'),
  think:    document.getElementById('t-think'),
  reset:    document.getElementById('reset'),
  count:    document.getElementById('count'),
  hint:     document.getElementById('hint'),
  status:   document.getElementById('status'),
  pIp:      document.getElementById('p-ip'),
  pRate:    document.getElementById('p-rate'),
  pModel:   document.getElementById('p-model'),
};

const state = {
  session: localStorage.getItem(SS_KEY) || null,
  busy: false,
  abort: null,
};

// ── safety ────────────────────────────────────────────────────────────────
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const linkifySafe = (text) =>
  esc(text).replace(
    /(https?:\/\/[^\s<>"')\]]+)/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer nofollow">${m}</a>`
  );

/**
 * Minimal, injection-safe markdown: fenced code, inline code, bold, italics,
 * `-` lists, links. Deliberately tiny — a real parser is a dependency and an
 * attack surface, and this is all the answer needs.
 */
function md(raw) {
  const fences = [];
  let src = String(raw).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, body) => {
    fences.push(`<pre><code data-lang="${esc(lang)}">${esc(body.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });

  src = linkifySafe(src);

  src = src
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');

  const out = [];
  let list = null;
  for (const block of src.split(/\n{2,}/)) {
    if (/^\s*[-*]\s+/m.test(block)) {
      const items = block.split('\n').filter((l) => /^\s*[-*]\s+/.test(l))
        .map((l) => `<li>${l.replace(/^\s*[-*]\s+/, '')}</li>`).join('');
      const type = /^\s*\d+\./.test(block) ? 'ol' : 'ul';
      out.push(`<${type}>${items}</${type}>`);
      continue;
    }
    if (list === null && block.trim() === '') continue;
    out.push(`<p>${block.replace(/\n/g, '<br>')}</p>`);
  }
  let html = out.join('');
  html = html.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[+i]);
  return html || '<p></p>';
}

// ── DOM ────────────────────────────────────────────────────────────────────
function scroll() {
  el.log.scrollTop = el.log.scrollHeight;
}

function addUser(text) {
  el.empty?.remove();
  const row = document.createElement('div');
  row.className = 'row user';
  row.innerHTML = `<div class="bubble">${linkifySafe(text)}</div>`;
  el.log.append(row);
  scroll();
}

function addAssistant() {
  el.empty?.remove();
  const row = document.createElement('div');
  row.className = 'row assistant';
  row.innerHTML = `
    <div class="avatar">S</div>
    <div class="bubble">
      <details class="think" hidden>
        <summary>Thinking</summary>
        <div class="body"></div>
      </details>
      <div class="text"><span class="cursor"></span></div>
      <div class="srcs" hidden><h4>Sources</h4><div class="list"></div></div>
      <div class="meta" hidden></div>
    </div>`;
  el.log.append(row);
  scroll();
  const text = row.querySelector('.text');
  return {
    row,
    text,
    thinkBox: row.querySelector('.think'),
    think: row.querySelector('.think .body'),
    srcs: row.querySelector('.srcs'),
    srcList: row.querySelector('.srcs .list'),
    meta: row.querySelector('.meta'),
    appendText(t) {
      text.querySelector('.cursor')?.remove();
      text.dataset.buf = (text.dataset.buf || '') + t;
      text.innerHTML = md(text.dataset.buf) + '<span class="cursor"></span>';
      scroll();
    },
    appendThink(t) {
      this.thinkBox.hidden = false;
      this.think.textContent += t;
    },
    finish(info = {}) {
      text.querySelector('.cursor')?.remove();
      const bits = [];
      if (info.elapsed_ms != null) bits.push(`${(info.elapsed_ms / 1000).toFixed(1)}s`);
      if (info.first_token_ms != null) bits.push(`ttft ${info.first_token_ms}ms`);
      if (info.chars != null) bits.push(`${info.chars} chars`);
      if (info.error) bits.push(`<span class="e">${esc(info.error)}</span>`);
      if (bits.length) {
        this.meta.hidden = false;
        this.meta.innerHTML = bits.join(' · ');
      }
    },
  };
}

function setStatus(text, kind) {
  el.status.className = 'dot ' + (kind || '');
  el.hint.textContent = text;
}

// ── SSE parsing (server → browser) ─────────────────────────────────────────
async function readSse(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let payload = {};
      try { payload = JSON.parse(dataLines.join('\n')); } catch { payload = { _raw: dataLines.join('\n') }; }
      onEvent(event, payload);
    }
  }
}

// ── send ───────────────────────────────────────────────────────────────────
async function send(message) {
  const view = addAssistant();
  const seenUrls = new Set();
  let errorMsg = '';
  let doneInfo = {};

  state.busy = true;
  state.abort = new AbortController();
  el.send.disabled = true;
  el.stop.hidden = false;
  setStatus('streaming…', 'live');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.abort.signal,
      body: JSON.stringify({
        message,
        session_id: state.session,
        stream: true,
        search: el.search.getAttribute('aria-pressed') === 'true',
        thinking: el.think.getAttribute('aria-pressed') === 'true',
      }),
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.error === 'rate_limited') detail = `rate limited — retry in ${j.retry_after}s`;
        else if (j.error) detail = j.error;
      } catch { /* keep status text */ }
      view.text.innerHTML = `<p style="opacity:.7">${esc(detail)}</p>`;
      view.finish({ error: detail });
      setStatus(detail, 'err');
      return;
    }

    const sid = res.headers.get('x-session-id');
    if (sid) { state.session = sid; localStorage.setItem(SS_KEY, sid); }

    await readSse(res.body, (event, p) => {
      switch (event) {
        case 'start':
          if (p.session_id) { state.session = p.session_id; localStorage.setItem(SS_KEY, p.session_id); }
          break;
        case 'reasoning':
          view.appendThink(p.text || '');
          break;
        case 'token':
          view.appendText(p.text || '');
          break;
        case 'sources': {
          const s = p.source || {};
          if (!s.url || seenUrls.has(s.url)) break;
          seenUrls.add(s.url);
          view.srcs.hidden = false;
          const a = document.createElement('a');
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer nofollow';
          let host = '';
          try { host = new URL(s.url).host; } catch { host = s.url; }
          a.innerHTML = `<span class="n">${seenUrls.size}</span>
                         <span>${esc(s.title || 'Untitled')}</span>
                         <span class="host">${esc(host)}</span>`;
          view.srcList.append(a);
          break;
        }
        case 'done':
          doneInfo = p;
          break;
        case 'error':
          errorMsg = p.message || p.code || 'stream error';
          break;
      }
    });

    if (errorMsg) {
      view.text.innerHTML = view.dataset.buf
        ? view.text.innerHTML
        : `<p style="opacity:.7">${esc(errorMsg)}</p>`;
    }
    view.finish({ ...doneInfo, error: errorMsg || undefined });
    setStatus(errorMsg ? errorMsg : 'idle', errorMsg ? 'err' : 'live');
  } catch (err) {
    if (err.name === 'AbortError') {
      view.finish({ error: 'stopped' });
      setStatus('stopped', '');
    } else {
      view.text.innerHTML = `<p style="opacity:.7">${esc(String(err.message || err))}</p>`;
      view.finish({ error: 'connection lost' });
      setStatus('connection lost — is the server running?', 'err');
    }
  } finally {
    state.busy = false;
    state.abort = null;
    el.send.disabled = false;
    el.stop.hidden = true;
    el.input.focus();
    autoresize();
  }
}

// ── chrome ─────────────────────────────────────────────────────────────────
function autoresize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 210) + 'px';
  el.count.textContent = el.input.value.length ? `${el.input.value.length}` : '';
}

function toggle(btn) {
  const on = btn.getAttribute('aria-pressed') === 'true';
  btn.setAttribute('aria-pressed', String(!on));
  localStorage.setItem(btn.id, String(!on));
}

async function loadConfig() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    el.pModel.textContent = cfg.model || '—';
    el.pRate.textContent = `${cfg.rate_limit?.requests ?? '?'}/${cfg.rate_limit?.window_seconds ?? '?'}s`;

    const you = cfg.you || {};
    const mode = you.via_trusted_proxy ? 'via proxy' : (you.socket_peer ? 'direct' : 'unknown');
    el.pIp.textContent = `${you.resolved_ip || '?'} · ${mode}`;
    if (you.unverified) {
      // no reverse proxy in front, yet forwarded headers existed → the address
      // we attribute is self-reported (or was rewritten by uvicorn). Warn,
      // because per-user rate limits built on this are advisory only.
      el.pIp.classList.add('warn');
      el.pIp.textContent = `${you.resolved_ip || '?'} · unverifiable`;
      el.pIp.title = 'Forwarded headers are present but no trusted proxy reported them, so per-IP limits are advisory here. Set TRUSTED_PROXIES to your proxy address.';
    } else {
      el.pIp.title = you.label || '';
    }

    // prefill the search toggle from the server default on first visit
    if (localStorage.getItem('t-search') === null && cfg.search_default != null) {
      el.search.setAttribute('aria-pressed', String(!!cfg.search_default));
    }
    setStatus('ready', 'live');
  } catch {
    setStatus('offline — server not reachable', 'err');
  }
}

// restore toggles
for (const id of ['t-search', 't-think']) {
  const b = document.getElementById(id);
  const saved = localStorage.getItem(id);
  if (saved !== null) b.setAttribute('aria-pressed', saved);
  b.addEventListener('click', () => toggle(b));
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = el.input.value.trim();
  if (!v || state.busy) return;
  addUser(v);
  el.input.value = '';
  autoresize();
  send(v);
});

el.input.addEventListener('input', autoresize);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el.form.requestSubmit();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.busy) state.abort?.abort();
});

el.stop.addEventListener('click', () => state.abort?.abort());
el.reset.addEventListener('click', async () => {
  if (state.session) {
    await fetch(`/api/session/reset?session_id=${encodeURIComponent(state.session)}`, { method: 'POST' })
      .catch(() => {});
  }
  state.session = null;
  localStorage.removeItem(SS_KEY);
  el.log.innerHTML = '';
  const fresh = document.createElement('div');
  fresh.className = 'empty';
  fresh.innerHTML = el.empty ? el.empty.innerHTML : '';
  el.log.append(fresh);
  el.empty = fresh;
  setStatus('new session', 'live');
});

loadConfig();
autoresize();
el.input.focus();
