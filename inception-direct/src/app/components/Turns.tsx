import { memo, useEffect, useState } from 'react';
import { THINKING_LABELS } from '../../site/config';
import { retry, send, store, verify } from '../controller';
import { formatClock, formatDuration, hostOf } from '../format';
import { countWords } from '../markdown/render';
import { useStore } from '../store';
import type { Message } from '../types';
import { Markdown } from './Markdown';

/* ───────────────────────────── user ───────────────────────────── */

export const UserTurn = memo(function UserTurn({ message }: { message: Message }) {
  const long = message.content.length > 280 || message.content.includes('\n');
  return (
    <section className="turn turn--user">
      <div className="turn-label">
        <span className="turn-who">You</span>
        <time dateTime={new Date(message.createdAt).toISOString()}>{formatClock(message.createdAt)}</time>
      </div>
      <p className={long ? 'question question--long' : 'question'}>{message.content}</p>
    </section>
  );
});

/* ─────────────────────────── assistant ─────────────────────────── */

interface AssistantTurnProps {
  message: Message;
  isLast: boolean;
}

export const AssistantTurn = memo(function AssistantTurn({ message, isLast }: AssistantTurnProps) {
  const streaming = message.status === 'streaming';
  const content = message.content ?? '';
  const reasoning = message.reasoning ?? '';
  const meta = message.meta;
  const dropCaps = useStore(store, (s) => s.settings.dropCaps);
  const firstBlockIsLongParagraph = /^[^\n#>*\-|`$\\\d][^\n]{160,}/.test(content.trimStart());
  const thinkingNow = streaming && reasoning.length > 0 && !meta?.firstTokenAt;
  const waiting = streaming && !content && !reasoning && !message.searching;

  return (
    <section className="turn turn--assistant" aria-busy={streaming}>
      <div className="turn-label">
        <span className="turn-who">Mercury</span>
        {meta && (
          <span className="turn-settings">
            {THINKING_LABELS[meta.thinking]}
            {meta.webSearch ? ' · Web' : ''}
          </span>
        )}
      </div>

      {reasoning && <Thinking text={reasoning} live={thinkingNow} startedAt={meta?.reasoningStartedAt} endedAt={meta?.reasoningEndedAt} />}

      {message.searching && !content && (
        <p className="status-line">
          Searching the web<span className="dots" aria-hidden="true" />
        </p>
      )}
      {waiting && (
        <p className="status-line">
          Diffusing<span className="dots" aria-hidden="true" />
        </p>
      )}
      {message.searchFailed && <p className="aside-note">Web search didn’t work out this time; Mercury answered without it.</p>}

      {content && (
        <Markdown
          text={content}
          streaming={streaming}
          className={`prose${dropCaps && firstBlockIsLongParagraph ? ' prose--dropcap' : ''}`}
        />
      )}

      {message.status === 'stopped' && <p className="stopped-mark">— stopped here</p>}
      {message.status === 'error' && message.error && <ErrorNote message={message} />}

      {message.sources && message.sources.length > 0 && (
        <section className="sources" aria-label="Sources">
          <h4 className="small-caps">Sources</h4>
          <ol>
            {message.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  <span className="source-title">{source.title || hostOf(source.url)}</span>
                  <span className="source-host">{hostOf(source.url)}</span>
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}

      {!streaming && (message.status === 'done' || message.status === 'stopped') && <Colophon message={message} isLast={isLast} />}

      {isLast && !streaming && message.followUps && message.followUps.length > 0 && (
        <nav className="follow-ups" aria-label="Suggested follow-ups">
          <h4 className="small-caps">Continue</h4>
          <ul>
            {message.followUps.map((text) => (
              <li key={text}>
                <button type="button" onClick={() => void send(text)}>
                  <span aria-hidden="true">→</span> {text}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </section>
  );
});

function Thinking({ text, live, startedAt, endedAt }: { text: string; live: boolean; startedAt?: number; endedAt?: number }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n').filter((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? '';
  const seconds = startedAt && endedAt ? formatDuration(endedAt - startedAt) : '';
  return (
    <details className="thinking" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="thinking-label">{live ? 'Thinking' : seconds ? `Thought for ${seconds}` : 'Thoughts'}</span>
        {live && !open ? (
          <span className="thinking-ticker" aria-live="off">
            {lastLine}
          </span>
        ) : (
          <span className="thinking-hint">{open ? 'hide' : `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} · show`}</span>
        )}
      </summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

function ErrorNote({ message }: { message: Message }) {
  const error = message.error!;
  const busy = useStore(store, (s) => s.streamingId !== null);
  const hint =
    error.kind === 'rate-limit'
      ? 'Give it a few seconds, then retry.'
      : error.kind === 'network'
        ? 'Check your connection and retry.'
        : error.kind === 'challenge'
          ? 'Pass the security check and this answer will be retried automatically.'
          : '';
  return (
    <div className="error-note" role="alert">
      <p>
        <strong>{error.message}</strong>
        {error.detail && error.detail !== error.message ? <span className="error-detail"> {error.detail}</span> : null}
        {hint ? <span className="error-hint"> {hint}</span> : null}
      </p>
      <div className="error-actions">
        {error.kind === 'challenge' ? (
          <button type="button" className="text-button" onClick={() => void verify()}>
            Open site window
          </button>
        ) : null}
        <button type="button" className="text-button" disabled={busy} onClick={() => void retry(message.id)}>
          Retry
        </button>
      </div>
    </div>
  );
}

function Colophon({ message, isLast }: { message: Message; isLast: boolean }) {
  const [copied, setCopied] = useState(false);
  const busy = useStore(store, (s) => s.streamingId !== null);
  const meta = message.meta;
  const words = countWords(message.content);
  const total = meta?.finishedAt && meta.startedAt ? meta.finishedAt - meta.startedAt : null;
  const firstWord = meta?.firstTokenAt && meta.startedAt ? meta.firstTokenAt - meta.startedAt : null;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <footer className="colophon">
      <span className="colophon-meta">
        {words.toLocaleString()} {words === 1 ? 'word' : 'words'}
        {firstWord !== null ? ` · first word ${formatDuration(firstWord)}` : ''}
        {total !== null ? ` · ${formatDuration(total)}` : ''}
      </span>
      <span className="colophon-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => void navigator.clipboard?.writeText(message.content).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {isLast && (
          <button type="button" className="text-button" disabled={busy} onClick={() => void retry(message.id)}>
            Rewrite
          </button>
        )}
      </span>
    </footer>
  );
}
