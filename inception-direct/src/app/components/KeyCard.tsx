import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FREE_TOKENS_LABEL, LINKS } from '../../core/config';
import { saveApiKey, setUi, store } from '../controller';
import { API_HOST } from '../env';
import { useStore } from '../store';
import { ExternalIcon, EyeIcon, EyeOffIcon, KeyIcon } from './Icons';

/**
 * The one-time setup: paste an Inception API key. It is kept in this browser only and
 * sent only to Inception's API, as the Authorization header of this page's own requests.
 */
export function KeyCard() {
  const connection = useStore(store, (s) => s.connection);
  const editing = useStore(store, (s) => s.ui.keyEditor);
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(connection.remember);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLElement>(null);

  const status = connection.status;
  const rejected = status === 'auth';
  const changing = editing && !rejected && connection.keyHint !== null;

  useEffect(() => {
    if (editing || rejected) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // Don't pop the keyboard open on phones for a first visit; do focus on desktops.
    if (editing || rejected || matchMedia('(pointer: fine)').matches) input.current?.focus({ preventScroll: true });
  }, [editing, rejected]);

  const failure =
    !busy && (rejected || (editing && (status === 'offline' || status === 'error' || status === 'billing')))
      ? [connection.message, connection.detail].filter(Boolean).join(' ')
      : null;
  const error = hint ?? failure;

  // After a failed check, select the key so a corrected one can simply be pasted over it.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && failure) input.current?.select();
    wasBusy.current = busy;
  }, [busy, failure]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!value.trim()) {
      setHint('Paste your API key first.');
      input.current?.focus();
      return;
    }
    setHint(null);
    setBusy(true);
    const ok = await saveApiKey(value, remember);
    setBusy(false);
    if (ok) setValue('');
  };

  return (
    <section className="key-card" ref={card} data-tone={rejected ? 'bad' : 'default'} aria-labelledby="key-card-title">
      <p className="key-kicker small-caps">{rejected ? 'Key rejected' : changing ? 'Change key' : 'Connect'}</p>
      <h2 className="key-title" id="key-card-title">
        {rejected ? 'That key didn’t work.' : changing ? 'Use a different key.' : 'Bring your own key.'}
      </h2>
      <p className="key-lede">
        Mercury runs on Inception’s official API. This page calls <strong>{API_HOST}</strong> straight from your browser — your connection, your key,
        nothing in between. The key stays in this browser.
      </p>

      <form className="key-form" onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor="api-key" className="visually-hidden">
          Inception API key
        </label>
        <div className="key-input" data-invalid={error ? 'true' : undefined}>
          <KeyIcon size={17} />
          <input
            id="api-key"
            ref={input}
            name="inception-api-key"
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (hint) setHint(null);
            }}
            placeholder={connection.keyHint && !rejected ? `Current key ${connection.keyHint}` : 'Paste your Inception API key'}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'key-error' : 'key-foot'}
            disabled={busy}
          />
          <button type="button" className="key-reveal" onClick={() => setReveal((r) => !r)} aria-label={reveal ? 'Hide key' : 'Show key'} title={reveal ? 'Hide' : 'Show'}>
            {reveal ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
          </button>
        </div>

        <div className="key-row">
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>Remember on this device</span>
          </label>
          <div className="key-actions">
            {changing ? (
              <button type="button" className="button" onClick={() => setUi({ keyEditor: false })} disabled={busy}>
                Cancel
              </button>
            ) : null}
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </div>
        </div>

        {busy ? (
          <p className="key-status" aria-live="polite">
            Checking the key with {API_HOST}<span className="dots" aria-hidden="true" />
          </p>
        ) : error ? (
          <p className="key-error" id="key-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      <p className="key-foot" id="key-foot">
        No key yet? New Inception accounts get {FREE_TOKENS_LABEL} free tokens, no card needed.{' '}
        <a href={LINKS.keys} target="_blank" rel="noopener noreferrer">
          Get a free key <ExternalIcon size={13} />
        </a>
      </p>
    </section>
  );
}
