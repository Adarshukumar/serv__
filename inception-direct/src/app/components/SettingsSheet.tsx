import { useEffect, useState } from 'react';
import { EFFORT_LABELS, LENGTH_LIMITS, LINKS, REASONING_EFFORTS } from '../../core/config';
import { connect, currentModel, deleteAllChats, forgetApiKey, openKeyEditor, setUi, store, updateSettings } from '../controller';
import { API_HOST } from '../env';
import { formatAgo, formatContext, formatPerMillion, formatTokenLimit } from '../format';
import { useStore } from '../store';
import type { ConnectionState, ReadingFace, ThemeChoice } from '../types';
import { CloseIcon, ExternalIcon } from './Icons';

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={String(option.value)} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label, help }: { checked: boolean; onChange: (value: boolean) => void; label: string; help?: string }) {
  return (
    <div className="switch-field">
      <label className="switch-row">
        <span>{label}</span>
        <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)}>
          <span />
        </button>
      </label>
      {help ? <p className="field-help">{help}</p> : null}
    </div>
  );
}

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'paper', label: 'Paper' },
  { value: 'night', label: 'Night' },
  { value: 'system', label: 'System' },
];
const FACES: { value: ReadingFace; label: string }[] = [
  { value: 'serif', label: 'Newsreader' },
  { value: 'sans', label: 'Inter' },
];
const STATUS_TEXT: Record<ConnectionState['status'], string> = {
  'no-key': 'No API key yet',
  connecting: 'Connecting…',
  live: 'Live',
  auth: 'Key rejected',
  billing: 'Out of credit',
  offline: 'Offline',
  error: 'Error',
};

export function SettingsSheet() {
  const open = useStore(store, (s) => s.ui.settingsOpen);
  const settings = useStore(store, (s) => s.settings);
  const connection = useStore(store, (s) => s.connection);
  const models = useStore(store, (s) => s.models);
  const [system, setSystem] = useState(settings.system);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const model = currentModel();

  useEffect(() => {
    if (open) setSystem(settings.system);
    else {
      setConfirmDelete(false);
      setConfirmForget(false);
    }
  }, [open, settings.system]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUi({ settingsOpen: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const modelFacts = [
    model.contextLength ? `${formatContext(model.contextLength)} context` : '',
    model.pricing ? `${formatPerMillion(model.pricing.prompt)} in · ${formatPerMillion(model.pricing.completion)} out` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <div className="sheet-scrim" data-open={open} onClick={() => setUi({ settingsOpen: false })} aria-hidden="true" />
      <aside className="sheet" data-open={open} aria-label="Settings" aria-hidden={!open} inert={!open}>
        <header className="sheet-head">
          <h2>Settings</h2>
          <button type="button" className="icon-button" onClick={() => setUi({ settingsOpen: false })} aria-label="Close settings">
            <CloseIcon />
          </button>
        </header>

        <div className="sheet-body">
          <section>
            <h3 className="small-caps">Answers</h3>
            <div className="field">
              <span className="field-label">Model</span>
              <Segmented label="Model" value={settings.model} options={models.map((m) => ({ value: m.id, label: m.name }))} onChange={(id) => updateSettings({ model: id })} />
              {modelFacts ? <p className="field-help">{modelFacts}</p> : null}
            </div>
            <div className="field">
              <span className="field-label">Thinking</span>
              <Segmented
                label="Thinking effort"
                value={settings.effort}
                options={REASONING_EFFORTS.map((m) => ({ value: m, label: EFFORT_LABELS[m] }))}
                onChange={(effort) => updateSettings({ effort })}
              />
            </div>
            <Switch
              label="Diffusion view"
              checked={settings.diffusing}
              onChange={(diffusing) => updateSettings({ diffusing })}
              help="Stream Mercury’s denoising steps: the whole answer, refined in place until it settles."
            />
            <Switch
              label="Reasoning summary"
              checked={settings.reasoningSummary}
              onChange={(reasoningSummary) => updateSettings({ reasoningSummary })}
              help="Ask Inception for a short summary of how Mercury reasoned, when there is one."
            />
            <Switch
              label="Suggest follow-up questions"
              checked={settings.followUps}
              onChange={(followUps) => updateSettings({ followUps })}
              help="Written by Mercury after each answer — one small extra request."
            />
            <div className="field">
              <span className="field-label">Length limit</span>
              <Segmented
                label="Length limit"
                value={settings.lengthLimit}
                options={LENGTH_LIMITS.map((n) => ({ value: n, label: formatTokenLimit(n) }))}
                onChange={(lengthLimit) => updateSettings({ lengthLimit })}
              />
              <p className="field-help">Tokens per answer, reasoning included — capped at the model’s maximum.</p>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="system-input">
                Custom instructions
              </label>
              <textarea
                id="system-input"
                className="field-textarea"
                rows={4}
                value={system}
                placeholder="Optional. Sent as the system message of every request."
                onChange={(e) => setSystem(e.target.value)}
                onBlur={() => updateSettings({ system })}
              />
            </div>
          </section>

          <section>
            <h3 className="small-caps">Reading</h3>
            <div className="field">
              <span className="field-label">Typeface</span>
              <Segmented label="Typeface" value={settings.readingFace} options={FACES} onChange={(readingFace) => updateSettings({ readingFace })} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="size-input">
                Size <span className="field-value">{settings.readingSize}px</span>
              </label>
              <input
                id="size-input"
                type="range"
                min={15}
                max={24}
                step={1}
                value={settings.readingSize}
                onChange={(e) => updateSettings({ readingSize: Number(e.target.value) })}
              />
              <p className="type-specimen" aria-hidden="true">
                Aa Gg Rr &amp; 0123456789
              </p>
            </div>
            <Switch label="Drop caps on long answers" checked={settings.dropCaps} onChange={(dropCaps) => updateSettings({ dropCaps })} />
            <div className="field">
              <span className="field-label">Theme</span>
              <Segmented label="Theme" value={settings.theme} options={THEMES} onChange={(theme) => updateSettings({ theme })} />
            </div>
          </section>

          <section>
            <h3 className="small-caps">Connection</h3>
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>{STATUS_TEXT[connection.status]}</dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>This browser → {API_HOST}, direct</dd>
              </div>
              <div>
                <dt>API key</dt>
                <dd>
                  {connection.keyHint ? (
                    <>
                      <code>{connection.keyHint}</code> · {connection.remember ? 'remembered on this device' : 'this tab only'}
                    </>
                  ) : (
                    'none'
                  )}
                </dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd>
                  {connection.checkedAt
                    ? `checked ${formatAgo(connection.checkedAt)}${connection.latencyMs ? ` · handshake ${connection.latencyMs} ms` : ''}`
                    : 'not yet'}
                </dd>
              </div>
            </dl>
            <div className="notice-actions">
              <button type="button" className="button" onClick={() => void connect()} disabled={!connection.keyHint}>
                Reconnect now
              </button>
              <button type="button" className="button" onClick={openKeyEditor}>
                {connection.keyHint ? 'Change key' : 'Add key'}
              </button>
              {connection.keyHint ? (
                confirmForget ? (
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() => {
                      forgetApiKey();
                      setConfirmForget(false);
                    }}
                  >
                    Forget it
                  </button>
                ) : (
                  <button type="button" className="button" onClick={() => setConfirmForget(true)}>
                    Forget key…
                  </button>
                )
              ) : null}
            </div>
            <p className="field-help">
              The key is stored only in this browser and sent only to {API_HOST}.{' '}
              <a href={LINKS.keys} target="_blank" rel="noopener noreferrer">
                Manage keys <ExternalIcon size={12} />
              </a>
            </p>
          </section>

          <section>
            <h3 className="small-caps">Your data</h3>
            <p className="field-help">Conversations are stored in this browser (IndexedDB) and nowhere else.</p>
            {confirmDelete ? (
              <div className="notice-actions">
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => {
                    void deleteAllChats();
                    setConfirmDelete(false);
                  }}
                >
                  Delete everything
                </button>
                <button type="button" className="button" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </div>
            ) : (
              <button type="button" className="button" onClick={() => setConfirmDelete(true)}>
                Delete all conversations…
              </button>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}
