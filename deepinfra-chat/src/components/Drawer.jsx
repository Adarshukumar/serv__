import { useEffect, useRef, useState } from 'react'
import { MODES, planLadder } from '../lib/deepinfra/transport.js'
import { DEEPINFRA_CHAT_ENDPOINT, PROXY_CHAT_ENDPOINT, FORBIDDEN_IN_BROWSER } from '../lib/deepinfra/headers.js'
import ModelPicker from './ModelPicker.jsx'
import { CloseIcon, RefreshIcon, PulseIcon, TrashIcon, CheckIcon, SparkIcon, GearIcon } from './Icons.jsx'

const TABS = [
  { id: 'settings', label: 'Settings', icon: <GearIcon width={15} height={15} /> },
  { id: 'diagnostics', label: 'Diagnostics', icon: <PulseIcon width={15} height={15} /> },
  { id: 'learn', label: 'How it works', icon: <SparkIcon width={15} height={15} /> },
]

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      {children}
    </label>
  )
}

function Slider({ value, min, max, step, onChange, format }) {
  return (
    <div className="slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{format ? format(value) : value}</output>
    </div>
  )
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <button type="button" className={`toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="knob" />
      <span className="toggle-text">
        <strong>{label}</strong>
        {hint && <em>{hint}</em>}
      </span>
    </button>
  )
}

function SettingsTab({
  settings,
  updateSettings,
  liveModels,
  modelIsLive,
  syncModels,
  onClearAll,
  checkProxy,
  proxyHealth,
}) {
  const [showKey, setShowKey] = useState(false)

  return (
    <div className="tab-body">
      <section className="card">
        <h3>Route</h3>
        <div className="mode-grid">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`mode-card ${settings.mode === m.id ? 'is-active' : ''}`}
              onClick={() => updateSettings({ mode: m.id })}
            >
              <span className="mode-card-icon">{m.icon}</span>
              <strong>{m.label}</strong>
              <em>{m.blurb}</em>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Model</h3>
        <ModelPicker
          value={settings.model}
          onChange={(id) => updateSettings({ model: id })}
          liveModels={liveModels}
          modelIsLive={modelIsLive}
        />
        <div className="row">
          <button className="btn" onClick={syncModels}>
            <RefreshIcon width={15} height={15} /> Sync live catalogue
          </button>
          {liveModels?.ids?.length ? (
            <span className="ok-note">
              <CheckIcon width={13} height={13} /> {liveModels.ids.length} ids ·{' '}
              {new Date(liveModels.at).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
      </section>

      <section className="card">
        <h3>DeepInfra API key <em className="dim">(optional)</em></h3>
        <p className="card-note">
          Keyless is the whole point of the web-embed rung — add a key only if anonymous access stops
          working (401). It is kept in <strong>your</strong> localStorage and sent only to
          deepinfra.com, either directly or through the local proxy header <code>x-deepinfra-key</code>.
        </p>
        <Field label="Bearer token">
          <div className="key-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={settings.apiKey}
              placeholder="di_…"
              onChange={(e) => updateSettings({ apiKey: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn ghost" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'hide' : 'show'}
            </button>
          </div>
        </Field>
      </section>

      <section className="card">
        <h3>Generation</h3>
        <Field label="System prompt">
          <textarea
            rows={3}
            value={settings.system}
            onChange={(e) => updateSettings({ system: e.target.value })}
          />
        </Field>
        <Field label="Temperature" hint="0 = deterministic, 2 = unhinged (API max)">
          <Slider
            value={settings.temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => updateSettings({ temperature: v })}
            format={(v) => v.toFixed(2)}
          />
        </Field>
        <Field label="Max tokens" hint="passed straight through as max_tokens">
          <Slider
            value={settings.maxTokens}
            min={256}
            max={16384}
            step={256}
            onChange={(v) => updateSettings({ maxTokens: v })}
          />
        </Field>
        <Field label="top_p">
          <Slider
            value={settings.topP}
            min={0.1}
            max={1}
            step={0.05}
            onChange={(v) => updateSettings({ topP: v })}
            format={(v) => v.toFixed(2)}
          />
        </Field>
        <Field label="Retries per route" hint="mirrors retries=… in DeepInfra.py">
          <Slider
            value={settings.retries}
            min={0}
            max={5}
            step={1}
            onChange={(v) => updateSettings({ retries: v })}
          />
        </Field>
      </section>

      <section className="card">
        <h3>Interface</h3>
        <Toggle
          checked={settings.showReasoning}
          onChange={(v) => updateSettings({ showReasoning: v })}
          label="Show the thinking panel"
          hint="renders reasoning_content (or inline <think> blocks) separately"
        />
        <Toggle
          checked={settings.telemetry}
          onChange={(v) => updateSettings({ telemetry: v })}
          label="Collect route logs"
          hint="feeds the Diagnostics tab; nothing leaves the browser"
        />
      </section>

      <section className="card danger">
        <h3>Local proxy</h3>
        <div className="row">
          <button className="btn" onClick={checkProxy}>
            <PulseIcon width={15} height={15} /> Check /deepinfra-proxy/health
          </button>
          {proxyHealth && (
            <code className="health">
              {proxyHealth.ok ? 'ok' : 'down'} · node {proxyHealth.node ?? '?'} · serverKey{' '}
              {String(proxyHealth.serverKey ?? false)}
            </code>
          )}
        </div>
        <p className="card-note">
          Tip: export a key for the proxy with <code>DEEPINFRA_API_KEY=di_… npm run dev</code> if you
          prefer not to paste it into the browser.
        </p>
      </section>

      <section className="card danger">
        <h3>Danger zone</h3>
        <button className="btn danger-btn" onClick={onClearAll}>
          <TrashIcon width={15} height={15} /> Delete every chat + settings
        </button>
      </section>
    </div>
  )
}

function DiagnosticsTab({ settings, logs, lastRun, clearLogs, syncModels }) {
  const [ip, setIp] = useState(null)
  const [ipBusy, setIpBusy] = useState(false)
  const logBox = useRef(null)

  useEffect(() => {
    const el = logBox.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  const ladder = planLadder({ mode: settings.mode, apiKey: settings.apiKey.trim() })
  const succeeded = lastRun?.rungId

  const checkIp = async () => {
    setIpBusy(true)
    try {
      const res = await fetch('https://api.ipify.org?format=json')
      const json = await res.json()
      setIp(json.ip)
    } catch (err) {
      setIp(`unavailable (${err.message})`)
    } finally {
      setIpBusy(false)
    }
  }

  return (
    <div className="tab-body">
      <section className="card">
        <h3>Route ladder <em className="dim">({settings.mode})</em></h3>
        <ol className="ladder">
          {ladder.map((r, i) => (
            <li key={r.id} className={succeeded === r.id ? 'is-hit' : ''}>
              <span className="ladder-num">{i + 1}</span>
              <div>
                <strong>{r.label}</strong>
                <em>{r.blurb}</em>
                <code>{r.endpoint}</code>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <h3>Last run</h3>
        {lastRun ? (
          <div className="stat-grid">
            <div>
              <span>route</span>
              <strong>{lastRun.rungId ?? lastRun.rung}</strong>
            </div>
            <div>
              <span>ttfb</span>
              <strong>{lastRun.ttfbMs ?? '—'} ms</strong>
            </div>
            <div>
              <span>total</span>
              <strong>{lastRun.totalMs ?? '—'} ms</strong>
            </div>
            <div>
              <span>tokens</span>
              <strong>
                {lastRun.usage
                  ? `${lastRun.usage.prompt_tokens ?? '?'} → ${lastRun.usage.completion_tokens ?? '?'}`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>chars</span>
              <strong>{lastRun.chars ?? 0}</strong>
            </div>
            <div>
              <span>model</span>
              <strong className="ellipsis">{lastRun.model}</strong>
            </div>
            {lastRun.error && (
              <div className="full">
                <span>error</span>
                <strong className="err">{lastRun.error}</strong>
              </div>
            )}
          </div>
        ) : (
          <p className="card-note">no run yet this session.</p>
        )}
      </section>

      <section className="card">
        <h3>Live log</h3>
        <div className="log-box" ref={logBox}>
          {logs.length ? (
            logs.map((l) => (
              <div key={l.id} className={`log-line log-${l.level}`}>
                <span className="log-time">{l.stamp}</span>
                <span>{l.text}</span>
              </div>
            ))
          ) : (
            <div className="log-line dim">nothing logged yet — send a message.</div>
          )}
        </div>
        <div className="row">
          <button className="btn ghost" onClick={clearLogs}>
            clear log
          </button>
          <button className="btn ghost" onClick={syncModels}>
            sync models
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Your egress IP</h3>
        <p className="card-note">
          Direct rungs leave your machine from this IP — that is exactly why the request is not
          blocked server-side. The proxy rung goes out from the same machine too (it runs locally).
        </p>
        <div className="row">
          <button className="btn" onClick={checkIp} disabled={ipBusy}>
            {ipBusy ? 'checking…' : 'Show my public IP'}
          </button>
          {ip && <code className="health">{ip}</code>}
        </div>
      </section>

      <section className="card">
        <h3>Terminal verification</h3>
        <p className="card-note">The definitive header-by-header probe, from this same machine:</p>
        <pre className="cmd">npm run doctor</pre>
        <pre className="cmd">npm run doctor -- --key=di_xxxxxxxx</pre>
      </section>
    </div>
  )
}

function LearnTab() {
  return (
    <div className="tab-body">
      <section className="card">
        <h3>What the Python provider did</h3>
        <p className="card-note">
          <code>API/providers/DeepInfra.py</code> POSTs to{' '}
          <code>{'https://api.deepinfra.com/v1/openai/chat/completions'}</code> with browser-ish headers,
          no <code>Authorization</code>, and streams SSE back through cloudscraper. Two header sets
          circulate in the wild:
        </p>
        <table className="mini-table">
          <thead>
            <tr>
              <th>header</th>
              <th>Python DeepInfra.py</th>
              <th>g4f DeepInfraChat</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Origin</td>
              <td><code>https://g4f.dev</code></td>
              <td><code>https://deepinfra.com</code></td>
            </tr>
            <tr>
              <td>Referer</td>
              <td><code>https://g4f.dev</code></td>
              <td><code>https://deepinfra.com/</code></td>
            </tr>
            <tr>
              <td>X-Deepinfra-Source</td>
              <td>— missing —</td>
              <td><code>web-embed</code></td>
            </tr>
            <tr>
              <td>x-request-id</td>
              <td>frozen constant</td>
              <td>per request</td>
            </tr>
            <tr>
              <td>Authorization</td>
              <td>never</td>
              <td>never</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>What a browser is allowed to say</h3>
        <p className="card-note">
          These are forbidden request headers — JS cannot set them, and any attempt is silently
          dropped or rejects the call. That is why the app cannot be <em>exactly</em> the Python client
          while also running in the browser:
        </p>
        <div className="tag-cloud">
          {FORBIDDEN_IN_BROWSER.map((h) => (
            <span key={h} className="tag tag-gone">
              {h}
            </span>
          ))}
        </div>
        <p className="card-note">
          The browser always stamps <strong>its own</strong> origin. So the two goals — “real user IP”
          and “exact header set” — are in tension, and the ladder resolves it by trying the honest
          version first:
        </p>
        <ul className="bullet">
          <li>
            <strong>direct rungs</strong> — your IP, your browser, keyless web-embed marker; blocked by
            CORS only if DeepInfra does not allow this origin.
          </li>
          <li>
            <strong>proxy rungs</strong> — a local Node middleware replays the identical body with the
            full header set (<code>server/proxy.js</code>), still from your machine.
          </li>
        </ul>
      </section>

      <section className="card">
        <h3>Retry semantics (ported, not guessed)</h3>
        <ul className="bullet">
          <li>
            retry codes <code>429,500,502,503,504,520,521,522,523,524</code> →{' '}
            <code>min(2·2ⁿ + jitter, 30 s)</code>
          </li>
          <li>
            fatal codes <code>400,401,403,404,405,422</code> → surfaced immediately, no retry
          </li>
          <li>
            the Python file's bugs are deliberately <em>not</em> ported: no blocking sleeps, UTF-8 is
            pinned, the response body is always released, and <code>reasoning_content</code> is kept.
          </li>
        </ul>
      </section>

      <section className="card">
        <h3>Endpoints used</h3>
        <pre className="cmd">{DEEPINFRA_CHAT_ENDPOINT}</pre>
        <pre className="cmd">{PROXY_CHAT_ENDPOINT}</pre>
      </section>
    </div>
  )
}

export default function Drawer({
  tab,
  onClose,
  settings,
  updateSettings,
  logs,
  clearLogs,
  lastRun,
  liveModels,
  modelIsLive,
  syncModels,
  onClearAll,
  proxyHealth,
  checkProxy,
}) {
  const [current, setCurrent] = useState(tab ?? 'settings')
  useEffect(() => {
    if (tab) setCurrent(tab)
  }, [tab])
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!tab) return null

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <header className="drawer-head">
          <div className="drawer-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`drawer-tab ${current === t.id ? 'is-active' : ''}`}
                onClick={() => setCurrent(t.id)}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            <CloseIcon width={16} height={16} />
          </button>
        </header>

        <div className="drawer-scroll">
          {current === 'settings' && (
            <SettingsTab
              settings={settings}
              updateSettings={updateSettings}
              liveModels={liveModels}
              modelIsLive={modelIsLive}
              syncModels={syncModels}
              onClearAll={onClearAll}
              proxyHealth={proxyHealth}
              checkProxy={checkProxy}
            />
          )}
          {current === 'diagnostics' && (
            <DiagnosticsTab
              settings={settings}
              logs={logs}
              lastRun={lastRun}
              clearLogs={clearLogs}
              syncModels={syncModels}
            />
          )}
          {current === 'learn' && <LearnTab />}
        </div>
      </aside>
    </div>
  )
}
