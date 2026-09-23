// ══════════════════════════════════════════════════════════════
//  App — one page. Sidebar (models by provider) + thread + composer.
//
//  All provider differences are absorbed below this component: it dispatches a
//  ChatRequest and folds unified StreamEvents into a message. The default
//  transport is DIRECT — the browser builds the request and hits the provider's
//  real URL, so that URL is what appears in the DevTools network log.
// ══════════════════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatRequest, Source, StreamEvent } from './types';
import { MODELS } from './data/models';
import { PROVIDERS, providerMeta } from './data/providers';
import { streamChat, connectivity } from './lib/stream.ts';
import {
  getUpstageCsrf,
  setUpstageCsrf,
  getMercuryToken,
  setMercuryToken,
  setUpstageSessionId,
  getUpstageSessionId,
  fetchMercurySession,
  mercuryProxyNotice,
} from './lib/direct.ts';
import { getCsrf, clearCreds } from './lib/upstageSession.ts';
import type { WireFormat } from './types';
import Sidebar, { type Selection } from './components/Sidebar.tsx';
import Message from './components/Message.tsx';
import Composer from './components/Composer.tsx';

// Carried over from the Python server's Dockerfile (SERVER_SYSTEM_PROMPT).
const DEFAULT_SYSTEM = 'You are a so powerful assistant powered by Adarsh Kumar.';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const SUGGESTIONS = [
  'Which headers is a browser forbidden from setting, and why?',
  'Explain the four SSE wire formats these providers use',
  'How does Upstage v3 split <think> tags across stream chunks?',
  'Compare solar-pro3 and kimi-k2.5 for reasoning tasks',
];

function emptyMessage(role: 'user' | 'assistant', text = ''): ChatMessage {
  return {
    id: uid(),
    role,
    content: text,
    thinking: '',
    sources: [],
    createdAt: Date.now(),
  };
}

export default function App() {
  const [selection, setSelection] = useState<Selection>(() => {
    // Default to the flagship of the provider the whole migration centres on.
    const first = MODELS.find((m) => m.name === 'solar-pro3' && m.providers.includes('Upstage'));
    if (first) return { provider: 'Upstage', model: first.name, modelId: first.connection['Upstage'] };
    const any = MODELS[0];
    return { provider: any.providers[0], model: any.name, modelId: any.connection[any.providers[0]] };
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [search, setSearch] = useState(false);
  const [reasoning, setReasoning] = useState('low');
  // The real provider URL of the most recent request, so the user can confirm
  // in the UI that it matches what the network log shows.
  const [lastHit, setLastHit] = useState<{ url: string; via: string; wire: WireFormat | null } | null>(null);
  const [transportVia, setTransportVia] = useState<string>('direct');

  // ── credentials ──
  // Direct mode cannot capture a logged-in session for you: the browser will
  // not let JS read another site's cookies. Upstage's CSRF token and Mercury's
  // session token are therefore pasted in once and kept in localStorage only.
  const [keysOpen, setKeysOpen] = useState(false);
  const [csrf, setCsrf] = useState(() => getUpstageCsrf());
  const [mtok, setMtok] = useState(() => getMercuryToken());
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  const saveCsrf = (v: string) => {
    setCsrf(v);
    setUpstageCsrf(v);
    setKeyMsg(v.trim() ? 'Upstage CSRF saved to this browser only.' : 'Upstage CSRF cleared.');
  };
  const saveMtok = (v: string) => {
    setMtok(v);
    setMercuryToken(v);
    setKeyMsg(v.trim() ? 'Mercury session token saved to this browser only.' : 'Mercury token cleared.');
  };
  const [busy, setBusy] = useState<'upstage' | 'mercury' | null>(null);
  const [sid, setSid] = useState(() => getUpstageSessionId());

  // Runs the SAME Next.js RSC pipeline the Python client runs: load the console
  // page, find the getConsoleCsrfToken server-action id in its JS chunks, then
  // POST to it and read the JWT out of the flight response.
  const establishUpstage = async () => {
    setBusy('upstage');
    setKeyMsg('Establishing Upstage session \u2014 loading console.upstage.ai/playground/chat\u2026');
    const r = await getCsrf();
    if ('csrf' in r) {
      saveCsrf(r.csrf);
      setSid(r.sessionId);
      setUpstageSessionId(r.sessionId);
      setKeyMsg(`Upstage session established. CSRF captured, x-session-id = ${r.sessionId.slice(0, 8)}\u2026`);
    } else {
      setKeyMsg(r.error);
    }
    setBusy(null);
  };

  const resetUpstage = () => {
    clearCreds();
    saveCsrf('');
    setSid('');
    setUpstageSessionId('');
    setKeyMsg('Upstage credentials cleared.');
  };

  const grabMercury = async () => {
    setBusy('mercury');
    setKeyMsg('Requesting a Mercury session directly from chat.inceptionlabs.ai\u2026');
    const r = await fetchMercurySession();
    if (r.token) {
      setMtok(r.token);
      setKeyMsg('Mercury session token captured.');
    } else {
      setKeyMsg(`Could not capture a Mercury session: ${r.error}`);
    }
    setBusy(null);
  };
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const provider = providerMeta(selection.provider);
  const model = useMemo(
    () => MODELS.find((m) => m.name === selection.model && m.providers.includes(selection.provider)) ?? null,
    [selection],
  );

  const caps = model?.capabilities[selection.provider] ?? {};
  const efforts = model?.reasoningEfforts ?? (provider.reasoningEfforts && caps.reasoning ? provider.reasoningEfforts : []);
  const canThink = Boolean(caps.reasoning) || provider.supports.thinking;

  // ── transport ──
  // Direct mode has no health endpoint to poll: the provider IS the endpoint.
  useEffect(() => {
    let alive = true;
    void connectivity().then((c) => {
      if (alive) setTransportVia(c.via);
    });
    return () => {
      alive = false;
    };
  }, []);

  // ── autoscroll ──
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Keep the effort choice valid when the model changes.
  useEffect(() => {
    if (efforts.length && !efforts.includes(reasoning)) setReasoning(efforts[0]);
  }, [efforts, reasoning]);

  // Auto-search defaults to ON for Upstage, matching v3's search-first behaviour.
  useEffect(() => {
    if (!caps.search) setSearch(false);
  }, [caps.search]);

  const applyEvent = useCallback((id: string, ev: StreamEvent, startedAt: number, firstToken: { at: number | null }) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const next: ChatMessage = { ...m, sources: [...m.sources] };

        switch (ev.kind) {
          case 'thinking':
            if (firstToken.at === null) firstToken.at = performance.now() - startedAt;
            next.thinking += ev.text;
            break;
          case 'content':
            if (firstToken.at === null) firstToken.at = performance.now() - startedAt;
            next.content += ev.text;
            next.status = undefined;
            break;
          case 'source': {
            // Dedupe by URL — Upstage can repeat sources across chunks.
            const have = new Set(next.sources.map((s) => s.url));
            for (const s of ev.sources) if (!have.has(s.url)) next.sources.push(s as Source);
            break;
          }
          case 'usage':
            next.usage = ev.usage;
            break;
          case 'status':
            next.status =
              ev.phase === 'searching'
                ? ev.detail
                  ? `Searching the web · “${ev.detail}”`
                  : 'Searching the web…'
                : ev.phase === 'summarizing'
                  ? (ev.detail ?? 'Summarizing sources…')
                  : 'Connecting…';
            break;
          case 'done':
            next.streaming = false;
            next.status = undefined;
            next.finishReason = ev.finishReason;
            next.elapsedMs = performance.now() - startedAt;
            if (firstToken.at !== null) next.ttftMs = firstToken.at;
            break;
          case 'error':
            next.streaming = false;
            next.status = undefined;
            next.error = ev.message;
            next.elapsedMs = performance.now() - startedAt;
            break;
        }
        return next;
      }),
    );
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg = emptyMessage('user', text);
    const asstId = uid();
    const asstMsg: ChatMessage = {
      ...emptyMessage('assistant'),
      id: asstId,
      streaming: true,
      model: selection.model,
      provider: selection.provider,
    };

    const history = messages
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setInput('');
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const startedAt = performance.now();
    const firstToken = { at: null as number | null };

    const request: ChatRequest = {
      provider: selection.provider,
      model: selection.model,
      modelId: selection.modelId,
      messages: [...history, { role: 'user', content: text }],
      system: DEFAULT_SYSTEM,
      temperature: 0.8,
      search: Boolean(search && caps.search),
      reasoning: caps.reasoning ? reasoning : undefined,
      tag: model?.tag,
      // For the offline simulator the selected "model" IS the wire format.
      wire: selection.provider === 'mock' ? selection.modelId : undefined,
    };

    try {
      for await (const ev of streamChat(request, {
        signal: ctrl.signal,
        onMeta: (info) => {
          setLastHit({ url: info.url ?? '(unknown)', via: info.via, wire: info.wire });
          setTransportVia(info.via);
        },
      })) {
        applyEvent(asstId, ev, startedAt, firstToken);
        if (ev.kind === 'done' || ev.kind === 'error') break;
      }
    } catch (err) {
      applyEvent(
        asstId,
        { kind: 'error', message: `stream failure: ${(err as Error)?.message || err}`, retryable: false },
        startedAt,
        firstToken,
      );
    } finally {
      // Guarantee the spinner never sticks if the generator ended without `done`.
      setMessages((prev) =>
        prev.map((m) => (m.id === asstId && m.streaming ? { ...m, streaming: false, elapsedMs: performance.now() - startedAt } : m)),
      );
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, messages, selection, search, caps, reasoning, model, applyEvent]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    if (streaming) abortRef.current?.abort();
    setMessages([]);
  }, [streaming]);

  const useSuggestion = (s: string) => {
    setInput(s);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>('textarea.input');
      el?.focus();
    });
  };

  return (
    <div className="app">
      <Sidebar
        selection={selection}
        onSelect={setSelection}
        transportVia={transportVia}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="main">
        <div className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle models">
            ☰
          </button>
          <span className="prov-swatch" style={{ background: provider.accent, width: 9, height: 9 }} />
          <div>
            <div className="title">{model?.display ?? selection.model}</div>
            <div className="sub">
              {provider.label} · <code style={{ fontFamily: 'var(--mono)' }}>{selection.modelId}</code>
              {model?.tag ? ` · ${model.tag}` : ''}
            </div>
          </div>
          <div className="spacer" />
          {canThink && <span className="chip think">✦ thinking</span>}
          {caps.search && <span className="chip search">⌕ search</span>}
          <span className="chip wire">{provider.wire}</span>
          <span className="chip" title="How the provider is reached">
            {provider.transport === 'bridge' ? '⇄ via relay' : '→ direct'}
          </span>
          <button
            className={`icon-btn${provider.supports.credentials ? ' accent' : ''}`}
            onClick={() => setKeysOpen((o) => !o)}
            title="Provider credentials (Upstage CSRF, Mercury session token)"
          >
            {(provider.id === 'Upstage' && csrf.trim()) || (provider.id === 'Mercury' && mtok.trim()) ? '\u2713 keys' : '\u26bf keys'}
          </button>
          <button className="icon-btn danger" onClick={clear} disabled={!messages.length}>
            Clear
          </button>
        </div>

        {keysOpen && (
          <div className="keys">
            <div className="keys-head">
              <b>Provider credentials</b>
              <button className="icon-btn" onClick={() => setKeysOpen(false)} aria-label="Close">✕</button>
            </div>
            <p className="dim">
              Stored in this browser's localStorage only. Never sent anywhere except the provider it
              belongs to, and never through a relay. A browser cannot read another site's cookies, so
              these have to be supplied by you.
            </p>

            <label className="field">
              <span>Upstage session</span>
              <div className="row">
                <input
                  type="password"
                  value={csrf}
                  onChange={(e) => saveCsrf(e.target.value)}
                  placeholder="x-csrf-token (JWT)"
                  spellCheck={false}
                />
                <button className="btn" onClick={establishUpstage} disabled={busy !== null}>
                  {busy === 'upstage' ? 'Establishing\u2026' : 'Establish session'}
                </button>
                <button className="btn ghost" onClick={resetUpstage} disabled={busy !== null}>
                  Reset
                </button>
              </div>
              <span className="dim">
                <b>Establish session</b> runs the same pipeline your Python client runs: load{' '}
                <code>console.upstage.ai/playground/chat</code>, find the{' '}
                <code>getConsoleCsrfToken</code> server-action id inside its JS chunks, POST to it and
                read the JWT out of the flight response. Sends <code>x-csrf-token</code>,{' '}
                <code>x-session-id</code> and <code>x-upstage-logging-enabled</code>.
              </span>
              {sid && (
                <span className="dim">
                  <code>x-session-id</code> = <code>{sid}</code>
                </span>
              )}
              <span className="dim" style={{ color: 'var(--warn)' }}>
                Known limit, and it is a proof not a guess: your Python client attaches the console's
                cookies to the API request <b>manually</b>, because <code>console.upstage.ai</code> and{' '}
                <code>ap-northeast-2.apistage.ai</code> are different registrable domains
                (<code>upstage.ai</code> vs <code>apistage.ai</code>). A browser cannot read another
                site's cookies, so it cannot forward them. If the API insists on them, Upstage needs{' '}
                <code>transport:'bridge'</code> — Node holds a real cookie jar. Paste a token
                manually to try without one.
              </span>
            </label>

            <label className="field">
              <span>Mercury session token</span>
              <div className="row">
                <input
                  type="password"
                  value={mtok}
                  onChange={(e) => saveMtok(e.target.value)}
                  placeholder="x-session-token"
                  spellCheck={false}
                />
                <button className="btn" onClick={grabMercury} disabled={busy !== null}>
                  {busy === 'mercury' ? 'Fetching\u2026' : 'Fetch session'}
                </button>
              </div>
              <span className="dim">
                "Fetch session" POSTs directly to <code>chat.inceptionlabs.ai/api/session</code>. Sent
                as <code>x-session-token</code>.
              </span>
            </label>

            <div className="notice">
              <b>Not inherited from the Python code:</b> Inception.py routes Mercury credential
              capture through a hardcoded plaintext-HTTP proxy at{' '}
              <code>{mercuryProxyNotice}</code>. Its provenance is unknown and it would see session
              material in the clear, so it is <b>disabled</b> here — requests go straight to
              Inception's real host.
            </div>

            {keyMsg && <div className="keymsg">{keyMsg}</div>}
          </div>
        )}

        {messages.length === 0 ? (
          <div className="empty">
            <h2>Pick a model, start chatting</h2>
            <p>
              {MODELS.length} models across {PROVIDERS.length - 1} providers, grouped in the sidebar.
              Requests are built <b>in this browser</b> and sent straight to each provider's real
              URL — no relay, no hosted server, no Python. Providers see <b>your IP</b>, and the URL
              below is exactly what your DevTools network log will show.
            </p>
            <div className="suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => useSuggestion(s)}>{s}</button>
              ))}
            </div>
            <div className="notice">
              <b>What direct mode does and does not control.</b> The body, the endpoint and every
              settable header are built here and sent to the provider directly. But{' '}
              <code>Origin</code>, <code>Referer</code>, <code>User-Agent</code>,{' '}
              <code>Cookie</code> and anything starting with <code>Sec-</code> are{' '}
              <b>forbidden header names</b> under the Fetch spec — no JavaScript can set them, so the
              browser substitutes its own. It will report <code>Sec-Fetch-Site: cross-site</code>,
              because a provider is a different site from this page.
              <br />
              <br />
              Whether a provider answers anyway is <b>its CORS decision</b>, and it can only be
              observed from a real browser with real network access. If one refuses, the error names
              the exact host to check in DevTools. Use the <b>Offline Simulator</b> to exercise the
              full pipeline — all five wire formats, thinking blocks, search lifecycle, usage — with
              no network at all.
            </div>
            {lastHit && (
              <div className="notice">
                <b>Last request went to:</b>
                <br />
                <code>{lastHit.url}</code>
                <br />
                <span className="dim">via {lastHit.via}{lastHit.wire ? ` · wire ${lastHit.wire}` : ''}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="thread" ref={threadRef}>
            <div className="thread-inner">
              {messages.map((m) => (
                <Message key={m.id} m={m} />
              ))}
            </div>
          </div>
        )}

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          onStop={stop}
          streaming={streaming}
          provider={provider}
          model={model}
          search={search}
          onSearch={setSearch}
          reasoning={reasoning}
          onReasoning={setReasoning}
          efforts={caps.reasoning ? efforts : []}
          canThink={canThink}
        />
      </div>
    </div>
  );
}
