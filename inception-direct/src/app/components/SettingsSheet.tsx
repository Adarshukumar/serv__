import { useEffect, useState } from 'react';
import { THINKING_LABELS, THINKING_MODES } from '../../site/config';
import { connect, deleteAllChats, setUi, store, updateSettings, verify } from '../controller';
import { formatAgo } from '../format';
import { useStore } from '../store';
import type { ReadingFace, ThemeChoice, ConnectionState } from '../types';
import { CloseIcon } from './Icons';

function Segmented<T extends string>({
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
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)}>
        <span />
      </button>
    </label>
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
  connecting: 'Connecting…', live: 'Live', challenge: 'Needs a security check',
  offline: 'Offline', error: 'Error', preview: 'Hosted preview · no chat',
};

export function SettingsSheet() {
  const open = useStore(store, (s) => s.ui.settingsOpen);
  const settings = useStore(store, (s) => s.settings);
  const connection = useStore(store, (s) => s.connection);
  const [system, setSystem] = useState(settings.system);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) setSystem(settings.system);
    else setConfirmDelete(false);
  }, [open, settings.system]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUi({ settingsOpen: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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
              <span className="field-label">Thinking mode</span>
              <Segmented
                label="Thinking mode"
                value={settings.thinking}
                options={THINKING_MODES.map((m) => ({ value: m, label: THINKING_LABELS[m] }))}
                onChange={(thinking) => updateSettings({ thinking })}
              />
            </div>
            <Switch label="Search the web" checked={settings.webSearch} onChange={(webSearch) => updateSettings({ webSearch })} />
            <Switch label="Suggest follow-up questions" checked={settings.followUps} onChange={(followUps) => updateSettings({ followUps })} />
            <div className="field">
              <label className="field-label" htmlFor="system-input">
                Custom instructions
              </label>
              <textarea
                id="system-input"
                className="field-textarea"
                rows={4}
                value={system}
                placeholder="Optional. Sent at the start of each conversation."
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
                <dd>{connection.status === 'preview' ? 'Hosted preview (local companion not running)' : 'Your computer → dedicated Chrome → chat.inceptionlabs.ai'}</dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd>
                  {connection.fetchedAt ? `created ${formatAgo(connection.fetchedAt)} · renews automatically` : 'none yet'}
                </dd>
              </div>
              <div>
                <dt>Tokens issued</dt>
                <dd>{connection.refreshCount}</dd>
              </div>
            </dl>
            {connection.status !== 'preview' && (
              <div className="notice-actions">
                <button type="button" className="button" onClick={() => void connect()}>Reconnect now</button>
                <button type="button" className="button" onClick={() => void verify()}>Show site window</button>
              </div>
            )}
            <p className="field-help">No API key or remote proxy. The site token and cookies stay in a dedicated Chrome profile on this computer. The companion only serves this UI on loopback.</p>
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
