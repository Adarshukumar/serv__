import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown.jsx'
import { CopyIcon, CheckIcon, RefreshIcon, BrainIcon, SparkIcon } from './Icons.jsx'

const SUGGESTIONS = [
  'Explain mixture-of-experts like I am five',
  'Write a React useDebounce hook with tests',
  'Compare the Python header set with what g4f really sends',
  'Turn this into a 7-day learning plan for Rust',
]

function TypingDots() {
  return (
    <span className="typing" aria-label="waiting for first token">
      <i />
      <i />
      <i />
    </span>
  )
}

function ReasoningPanel({ text, streaming }) {
  const [open, setOpen] = useState(streaming)
  useEffect(() => {
    if (streaming) setOpen(true)
    else setOpen(false)
  }, [streaming])

  if (!text) return null
  const tokens = Math.max(1, Math.round(text.length / 4))

  return (
    <div className={`thinking ${streaming ? 'is-streaming' : ''} ${open ? 'is-open' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <BrainIcon width={14} height={14} />
        <span>thinking</span>
        <em>{tokens} tok</em>
        <span className="thinking-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && <pre className="thinking-body">{text}</pre>}
    </div>
  )
}

function MetaRow({ message }) {
  if (!message.usage && !message.ttfbMs) return null
  const completion = message.usage?.completion_tokens
  const prompt = message.usage?.prompt_tokens
  const secs = message.totalMs ? (message.totalMs / 1000).toFixed(1) : null
  const tps =
    completion && message.totalMs
      ? (completion / Math.max(0.4, (message.totalMs - (message.ttfbMs ?? 0)) / 1000)).toFixed(1)
      : null

  return (
    <div className="meta-row">
      {message.usage && (
        <span title="prompt → completion tokens">
          {prompt ?? '?'} → {completion ?? '?'} tok
        </span>
      )}
      {message.ttfbMs ? <span title="time to first token">{message.ttfbMs} ms ttft</span> : null}
      {tps ? <span title="tokens / second">{tps} tok/s</span> : null}
      {secs ? <span>{secs} s</span> : null}
      {message.rung ? <span className="meta-rung">{message.rung}</span> : null}
    </div>
  )
}

function ErrorCard({ error, onOpenDrawer }) {
  return (
    <div className="error-card">
      <div className="error-top">
        <span className="error-badge">{error.kind}</span>
        <strong>{error.title}</strong>
        {error.status ? <span className="error-status">HTTP {error.status}</span> : null}
      </div>
      {error.message && <p className="error-msg">{error.message}</p>}
      {error.hint && <p className="error-hint">{error.hint}</p>}
      <button className="link-btn" onClick={() => onOpenDrawer('diagnostics')}>
        open diagnostics →
      </button>
    </div>
  )
}

function Bubble({ message, streaming, onRegenerate, onOpenDrawer, showReasoning, isLast }) {
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'
  const isStreaming = message.status === 'streaming'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content || '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-bot'} ${isStreaming ? 'is-streaming' : ''}`}>
      <div className="msg-avatar">{isUser ? '🧑' : '🔷'}</div>

      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-who">{isUser ? 'You' : 'Nova'}</span>
          {!isUser && message.model && <span className="msg-model">{message.model}</span>}
          {!isUser && (
            <span className="msg-actions">
              {message.content && (
                <button className="mini-btn" onClick={copy} title="copy">
                  {copied ? <CheckIcon width={13} height={13} /> : <CopyIcon width={13} height={13} />}
                </button>
              )}
              {isLast && !streaming && (
                <button className="mini-btn" onClick={onRegenerate} title="regenerate">
                  <RefreshIcon width={13} height={13} />
                </button>
              )}
            </span>
          )}
        </div>

        {!isUser && showReasoning && (
          <ReasoningPanel text={message.reasoning} streaming={isStreaming} />
        )}

        {isUser ? (
          <div className="user-text">{message.content}</div>
        ) : (
          <>
            {!message.content && isStreaming && <TypingDots />}
            {message.content && (
              <Markdown text={message.content} streaming={isStreaming} />
            )}
          </>
        )}

        {message.status === 'error' && message.error && (
          <ErrorCard error={message.error} onOpenDrawer={onOpenDrawer} />
        )}
        {message.status === 'stopped' && <div className="stopped-note">stopped — partial answer kept</div>}

        {!isUser && <MetaRow message={message} />}
      </div>
    </div>
  )
}

function Hero({ onPick, settings }) {
  return (
    <div className="hero">
      <div className="hero-orb">
        <span>🔷</span>
        <i className="ring ring-1" />
        <i className="ring ring-2" />
        <i className="ring ring-3" />
      </div>
      <h1>
        Say hi to <span className="grad">NovaChat</span>
      </h1>
      <p className="hero-sub">
        Your browser streams straight from <code>api.deepinfra.com</code> — the request body is identical
        to the Python provider, and the route ladder keeps it working even when CORS says no.
      </p>

      <div className="hero-modes">
        <span className="hero-chip">⚡ Auto ladder</span>
        <span className="hero-chip">🌐 real user IP</span>
        <span className="hero-chip">🛡️ proxy fallback</span>
        <span className="hero-chip">🧪 demo mode</span>
      </div>

      <div className="hero-grid">
        {SUGGESTIONS.map((s, i) => (
          <button key={s} className="hero-card" style={{ '--i': i }} onClick={() => onPick(s)}>
            <SparkIcon width={15} height={15} />
            <span>{s}</span>
          </button>
        ))}
      </div>

      <p className="hero-foot">
        current route: <strong>{settings.mode}</strong> · model <code>{settings.model}</code>
      </p>
    </div>
  )
}

export default function MessageList({
  messages,
  active,
  streaming,
  onRegenerate,
  onOpenDrawer,
  settings,
  onPick,
}) {
  const scroller = useRef(null)
  const nearBottom = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    if (nearBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  }

  const lastId = messages[messages.length - 1]?.id

  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      {!messages.length ? (
        <Hero onPick={onPick} settings={settings} />
      ) : (
        <div className="msg-column">
          {messages.map((m) => (
            <Bubble
              key={m.id}
              message={m}
              streaming={streaming}
              isLast={m.id === lastId}
              onRegenerate={onRegenerate}
              onOpenDrawer={onOpenDrawer}
              showReasoning={settings.showReasoning}
            />
          ))}
        </div>
      )}
      {active?.title === 'New chat' && messages.length > 0 && <div className="scroll-pad" />}
    </div>
  )
}
