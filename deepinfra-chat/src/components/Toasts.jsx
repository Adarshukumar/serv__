import { CloseIcon } from './Icons.jsx'

const GLYPH = { ok: '✓', warn: '!', error: '×', info: 'i' }

export default function Toasts({ toasts, onDismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t, i) => (
        <div key={t.id} className={`toast toast-${t.kind}`} style={{ '--i': i }}>
          <span className="toast-glyph">{GLYPH[t.kind] ?? 'i'}</span>
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.body && <span>{t.body}</span>}
          </div>
          <button className="toast-x" onClick={() => onDismiss(t.id)} aria-label="dismiss">
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
