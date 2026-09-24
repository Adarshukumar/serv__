import { useMemo, useState } from 'react'
import { CATALOG, lookupModel, resolveModel } from '../lib/deepinfra/models.js'
import { SparkIcon, BrainIcon } from './Icons.jsx'

/**
 * Searchable model list. Each row shows where the id came from:
 *   provider → verbatim alias in the Python DeepInfra.py
 *   docs     → documented / used by g4f's DeepInfraChat
 * and, once Settings → Sync ran, whether the live catalogue still has it.
 */
export default function ModelPicker({ value, onChange, liveModels, modelIsLive, onOpen }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = CATALOG.map((m) => ({ ...m, live: modelIsLive(m.id) }))
    if (!q) return all
    return all.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.alias.includes(q) ||
        m.label.toLowerCase().includes(q) ||
        m.family.toLowerCase().includes(q),
    )
  }, [query, modelIsLive])

  const current = lookupModel(value)
  const raw = !current ? resolveModel(value) : null

  const pick = (m) => {
    onChange(m.id)
    setOpen(false)
    setQuery('')
    onOpen?.(m)
  }

  return (
    <div className={`picker ${open ? 'is-open' : ''}`}>
      <button type="button" className="picker-current" onClick={() => setOpen((v) => !v)}>
        <span className="picker-orb" />
        <span className="picker-labels">
          <strong>{current?.label ?? raw ?? 'custom model'}</strong>
          <em>{current?.id ?? value}</em>
        </span>
        <span className="picker-caret">▾</span>
      </button>

      {open && (
        <div className="picker-panel">
          <input
            autoFocus
            className="picker-search"
            placeholder="search 30+ models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {liveModels?.ids?.length ? (
            <div className="picker-note">
              catalogue synced · {liveModels.ids.length} live ids
            </div>
          ) : (
            <div className="picker-note dim">not synced yet — Settings → Sync models</div>
          )}

          <div className="picker-list">
            {rows.map((m) => (
              <button
                type="button"
                key={m.id}
                className={`picker-row ${m.id === value ? 'is-active' : ''}`}
                onClick={() => pick(m)}
              >
                <span className="row-main">
                  <span className="row-label">
                    {m.label}
                    {m.reasoning && <BrainIcon width={13} height={13} className="tag-icon" />}
                    {m.vision && <span className="tag">vision</span>}
                  </span>
                  <span className="row-id">{m.id}</span>
                </span>
                <span className="row-tags">
                  {m.live === true && <span className="tag tag-live">live</span>}
                  {m.live === false && <span className="tag tag-gone">missing</span>}
                  <span className={`tag tag-${m.verified}`}>{m.verified === 'provider' ? 'py' : 'docs'}</span>
                </span>
              </button>
            ))}
            {!rows.length && <div className="picker-empty">no model matches “{query}”</div>}
          </div>

          <div className="picker-foot">
            <SparkIcon width={13} height={13} />
            <span>
              custom ids allowed — anything containing “/” is forwarded untouched, exactly like{' '}
              <code>_resolve()</code>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export { ModelPicker }
