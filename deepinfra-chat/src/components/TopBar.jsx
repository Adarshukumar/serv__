import { useEffect, useState } from 'react'
import { MODES } from '../lib/deepinfra/transport.js'
import { lookupModel } from '../lib/deepinfra/models.js'
import { RefreshIcon, PulseIcon, GearIcon, SparkIcon } from './Icons.jsx'

function Chip({ tone = 'neutral', children, title }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  )
}

export default function TopBar({
  active,
  settings,
  lastRun,
  streaming,
  onRename,
  onSync,
  onOpenDrawer,
  liveModels,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const mode = MODES.find((m) => m.id === settings.mode) ?? MODES[0]
  const model = lookupModel(settings.model)

  useEffect(() => setEditing(false), [active?.id])

  const tokPerSec =
    lastRun?.usage && lastRun?.totalMs
      ? (
          (lastRun.usage.completion_tokens ?? 0) /
          Math.max(0.4, (lastRun.totalMs - (lastRun.ttfbMs ?? 0)) / 1000)
        ).toFixed(1)
      : null

  const commit = () => {
    const title = draft.trim()
    if (title) onRename(active.id, title)
    setEditing(false)
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        {editing ? (
          <input
            className="title-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <button
            className="title"
            onClick={() => {
              if (!active) return
              setDraft(active.title)
              setEditing(true)
            }}
            title="click to rename"
          >
            {active?.title ?? 'NovaChat'}
          </button>
        )}
      </div>

      <div className="topbar-chips">
        <Chip tone="model" title={settings.model}>
          {model?.label ?? settings.model}
          {model?.reasoning && <SparkIcon width={12} height={12} />}
        </Chip>
        <Chip tone={`mode-${mode.id}`} title={mode.blurb}>
          {mode.icon} {mode.label}
        </Chip>

        {streaming ? (
          <Chip tone="live">
            <span className="dot-pulse" /> streaming
          </Chip>
        ) : lastRun?.rung && lastRun.rung !== 'failed' ? (
          <Chip tone="ok" title={`${lastRun.rung}\n${lastRun.attempts?.length ?? 0} attempt(s)`}>
            ✓ {lastRun.rungId ?? 'ok'}
          </Chip>
        ) : null}

        {!streaming && lastRun?.ttfbMs ? (
          <Chip tone="stat" title="time to first token / tokens per second">
            {lastRun.ttfbMs} ms · {tokPerSec ?? '—'} tok/s
          </Chip>
        ) : null}

        {liveModels?.ids?.length ? (
          <Chip tone="neutral" title={`synced ${new Date(liveModels.at).toLocaleString()}`}>
            {liveModels.ids.length} live ids
          </Chip>
        ) : null}
      </div>

      <div className="topbar-right">
        <button className="icon-btn" onClick={onSync} title="Sync model catalogue (live)">
          <RefreshIcon width={16} height={16} />
        </button>
        <button className="icon-btn" onClick={() => onOpenDrawer('diagnostics')} title="Diagnostics">
          <PulseIcon width={16} height={16} />
        </button>
        <button className="icon-btn" onClick={() => onOpenDrawer('settings')} title="Settings">
          <GearIcon width={16} height={16} />
        </button>
      </div>
    </header>
  )
}
