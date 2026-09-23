// ══════════════════════════════════════════════════════════════
//  App — one page. Sidebar (models by provider) + thread + composer.
//
//  All provider differences are absorbed below this component: it dispatches a
//  ChatRequest to the bridge and folds unified StreamEvents into a message.
// ══════════════════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatRequest, Source, StreamEvent } from './types';
import { MODELS } from './data/models';
import { PROVIDERS, providerMeta } from './data/providers';
import { streamChat, bridgeHealth } from './lib/bridge.ts';
import Sidebar, { type Selection } from './components/Sidebar.tsx';
import Message from './components/Message.tsx';
import Composer from './components/Composer.tsx';

// Carried over from the Python server's Dockerfile (SERVER_SYSTEM_PROMPT).
const DEFAULT_SYSTEM = 'You are a so powerful assistant powered by Adarsh Kumar.';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const SUGGESTIONS = [
  'Why can’t a browser call these provider APIs directly?',
  'Explain the four SSE wire formats these providers use',
  'What does the local egress bridge actually do?',
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
  const [bridgeUp, setBridgeUp] = useState<boolean | null>(null);
  const [bridgeErr, setBridgeErr] = useState<string | null>(null);
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

  // ── bridge health ──
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const h = await bridgeHealth();
      if (!alive) return;
      setBridgeUp(h.ok);
      setBridgeErr(h.ok ? null : (h.error ?? 'unreachable'));
    };
    void check();
    const t = setInterval(check, 8000);
    return () => {
      alive = false;
      clearInterval(t);
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
      for await (const ev of streamChat(request, { signal: ctrl.signal })) {
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
        bridgeUp={bridgeUp}
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
            {provider.transport === 'bridge' ? '⇄ local bridge' : '→ direct'}
          </span>
          <button className="icon-btn danger" onClick={clear} disabled={!messages.length}>
            Clear
          </button>
        </div>

        {messages.length === 0 ? (
          <div className="empty">
            <h2>Pick a model, start chatting</h2>
            <p>
              {MODELS.length} models across {PROVIDERS.length - 1} providers, grouped in the sidebar.
              Requests leave through a bridge running on <b>your</b> machine, so providers see
              <b> your IP</b> — no hosted server between you and them.
            </p>
            <div className="suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => useSuggestion(s)}>{s}</button>
              ))}
            </div>
            {bridgeUp === false && (
              <div className="notice">
                <b>Bridge offline.</b> The SPA cannot reach providers on its own — a browser is not
                allowed to set the <code>Origin</code>, <code>Referer</code> or <code>Sec-Fetch-*</code>{' '}
                headers every one of these providers requires.
                <br />
                <br />
                Start it with <code>npm run bridge</code>, then refresh. Until then, switch to the{' '}
                <b>Offline Simulator</b> provider in the sidebar to exercise the full pipeline —
                streaming, thinking blocks, search lifecycle and usage — with no network at all.
                {bridgeErr ? <><br /><br /><code>{bridgeErr}</code></> : null}
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
