import { useEffect, useRef, useState } from 'react'
import { SendIcon, StopIcon, TrashIcon } from './Icons.jsx'
import { MODES } from '../lib/deepinfra/transport.js'

export default function Composer({ onSend, onStop, streaming, settings, onClearHistory, hasMessages }) {
  const [text, setText] = useState('')
  const areaRef = useRef(null)
  const mode = MODES.find((m) => m.id === settings.mode) ?? MODES[0]

  // auto-grow
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const submit = () => {
    if (!text.trim() || streaming) return
    onSend(text)
    setText('')
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
    if (e.key === 'Escape' && streaming) onStop()
  }

  const estTokens = Math.max(0, Math.round(text.length / 4))

  return (
    <div className="composer-wrap">
      <div className={`composer ${streaming ? 'is-streaming' : ''}`}>
        <textarea
          ref={areaRef}
          className="composer-input"
          rows={1}
          placeholder={streaming ? 'streaming… press Esc to stop' : 'Ask anything — Enter sends, Shift+Enter adds a line'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck
        />

        <div className="composer-actions">
          {hasMessages && (
            <button className="mini-btn" onClick={onClearHistory} title="clear this conversation">
              <TrashIcon width={15} height={15} />
            </button>
          )}
          {streaming ? (
            <button className="send-btn stop" onClick={onStop} title="stop (Esc)">
              <StopIcon width={18} height={18} />
            </button>
          ) : (
            <button className="send-btn" onClick={submit} disabled={!text.trim()} title="send (Enter)">
              <SendIcon width={18} height={18} />
            </button>
          )}
        </div>
      </div>

      <div className="composer-foot">
        <span className={`route-pill route-${mode.id}`}>
          {mode.icon} {mode.label}
        </span>
        <span className="foot-sep">·</span>
        <span>{settings.model.split('/').pop()}</span>
        <span className="foot-sep">·</span>
        <span>temp {settings.temperature}</span>
        <span className="foot-sep">·</span>
        <span>max {settings.maxTokens}</span>
        {estTokens > 0 && (
          <>
            <span className="foot-sep">·</span>
            <span>~{estTokens} tok in</span>
          </>
        )}
        <span className="foot-spacer" />
        {settings.apiKey ? (
          <span className="foot-key keyed">key set</span>
        ) : (
          <span className="foot-key">keyless</span>
        )}
      </div>
    </div>
  )
}
