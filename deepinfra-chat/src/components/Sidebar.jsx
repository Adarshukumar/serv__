import { MODES } from '../lib/deepinfra/transport.js'
import ModelPicker from './ModelPicker.jsx'
import { PlusIcon, TrashIcon, GearIcon, PulseIcon, DownloadIcon, LinkIcon } from './Icons.jsx'

function ModeSwitch({ value, onChange }) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="transport mode">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          title={m.blurb}
          className={`mode-btn ${value === m.id ? 'is-active' : ''}`}
          onClick={() => onChange(m.id)}
        >
          <span className="mode-icon">{m.icon}</span>
          <span className="mode-label">{m.label}</span>
        </button>
      ))}
    </div>
  )
}

export default function Sidebar({
  conversations,
  activeId,
  setActiveId,
  onNew,
  onDelete,
  onRename,
  settings,
  updateSettings,
  onOpenDrawer,
  liveModels,
  modelIsLive,
  onExport,
  streaming,
}) {
  const mode = MODES.find((m) => m.id === settings.mode) ?? MODES[0]

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">🔷</span>
        <span className="brand-text">
          <strong>NovaChat</strong>
          <em>browser → deepinfra</em>
        </span>
      </div>

      <button className="new-chat" onClick={onNew}>
        <PlusIcon width={16} height={16} />
        New chat
        <kbd>⌘K</kbd>
      </button>

      <div className="side-section">
        <div className="side-title">Model</div>
        <ModelPicker
          value={settings.model}
          onChange={(id) => updateSettings({ model: id })}
          liveModels={liveModels}
          modelIsLive={modelIsLive}
        />
      </div>

      <div className="side-section">
        <div className="side-title">
          Route <span className="side-hint">{mode.icon}</span>
        </div>
        <ModeSwitch value={settings.mode} onChange={(id) => updateSettings({ mode: id })} />
        <p className="mode-blurb">{mode.blurb}</p>
      </div>

      <div className="side-section convos">
        <div className="side-title">
          Chats <span className="side-hint">{conversations.length}</span>
        </div>
        <div className="convo-list">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`convo ${c.id === activeId ? 'is-active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <button
                type="button"
                className="convo-title"
                onDoubleClick={() => {
                  const next = window.prompt('Rename chat', c.title)
                  if (next != null) onRename(c.id, next.trim())
                }}
                title="double-click to rename"
              >
                {c.title || 'New chat'}
                <em>{c.messages.length} msg</em>
              </button>
              <button
                type="button"
                className="convo-del"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(c.id)
                }}
                aria-label="delete chat"
              >
                <TrashIcon width={14} height={14} />
              </button>
            </div>
          ))}
          {!conversations.length && <div className="convo-empty">no chats yet</div>}
        </div>
      </div>

      <div className="side-foot">
        <button className="ghost-btn" onClick={onExport} disabled={streaming}>
          <DownloadIcon width={15} height={15} /> export
        </button>
        <button className="ghost-btn" onClick={() => onOpenDrawer('diagnostics')}>
          <PulseIcon width={15} height={15} /> diagnostics
        </button>
        <button className="ghost-btn" onClick={() => onOpenDrawer('settings')}>
          <GearIcon width={15} height={15} /> settings
        </button>
        <a
          className="ghost-btn as-link"
          href="https://api.deepinfra.com/v1/openai/models"
          target="_blank"
          rel="noreferrer"
        >
          <LinkIcon width={15} height={15} /> upstream
        </a>
      </div>
    </aside>
  )
}
