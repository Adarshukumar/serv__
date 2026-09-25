import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { EFFORT_LABELS, LINKS, displayModelName, isReasoningEffort } from '../../core/config';
import { openKeyEditor, retry, send, store } from '../controller';
import { diffCanvas } from '../diffusion';
import { formatClock, formatCount, formatDuration, formatRate, formatTokenLimit } from '../format';
import { countWords } from '../markdown/render';
import { useStore } from '../store';
import type { AssistantMeta, Message } from '../types';
import { ExternalIcon } from './Icons';
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
  const meta = message.meta;
  const dropCaps = useStore(store, (s) => s.settings.dropCaps);
  const models = useStore(store, (s) => s.models);
  const firstBlockIsLongParagraph = /^[^\n#>*\-|`$\\\d][^\n]{160,}/.test(content.trimStart());
  const modelName = meta?.model ? (models.find((m) => m.id === meta.model)?.name ?? displayModelName(undefined, meta.model)) : null;
  const finished = message.status === 'done' || message.status === 'stopped';

  return (
    <section className="turn turn--assistant" aria-busy={streaming}>
      <div className="turn-label">
        <span className="turn-who">Mercury</span>
        {meta && modelName ? (
          <span className="turn-settings">
            {modelName}
            {isReasoningEffort(meta.effort) ? ` · ${EFFORT_LABELS[meta.effort]}` : ''}
            {meta.diffusing ? ' · Diffusion' : ''}
          </span>
        ) : null}
      </div>

      {!streaming && <Reasoning message={message} />}
      {streaming && !content && <Pending meta={meta} />}

      {content &&
        (streaming && meta?.diffusing ? (
          <DiffusionCanvas text={content} steps={meta.steps ?? 0} />
        ) : (
          <Markdown
            text={content}
            streaming={streaming}
            className={`prose${dropCaps && firstBlockIsLongParagraph ? ' prose--dropcap' : ''}`}
          />
        ))}

      {message.status === 'stopped' && <p className="stopped-mark">— stopped here</p>}
      {message.status === 'done' && meta?.finishReason === 'length' && (
        <p className="aside-note">
          Mercury reached the length limit{meta.maxTokens ? ` (${formatTokenLimit(meta.maxTokens)} tokens)` : ''}. Ask it to continue, or raise the
          limit in Settings.
        </p>
      )}
      {message.status === 'done' && meta?.finishReason === 'content_filter' && (
        <p className="aside-note">Inception’s content filter ended this answer early.</p>
      )}
      {message.status === 'error' && message.error && <ErrorNote message={message} />}

      {finished && <Colophon message={message} isLast={isLast} />}

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

/** Before the first word: a live timer — or, while backing off, why and for how long. */
function Pending({ meta }: { meta?: AssistantMeta }) {
  const retryNote = useStore(store, (s) => s.retry);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 100);
    return () => window.clearInterval(timer);
  }, []);

  if (retryNote) {
    const seconds = Math.max(0, Math.ceil((retryNote.until - Date.now()) / 1000));
    const why =
      retryNote.kind === 'rate-limit'
        ? 'Inception is rate-limiting'
        : retryNote.kind === 'network'
          ? 'The connection hiccuped'
          : 'Inception is busy';
    return (
      <p className="status-line status-line--retry" role="status">
        {why} — retrying {seconds > 0 ? `in ${seconds} s` : 'now'}
        <span className="status-count">
          {' '}
          · attempt {retryNote.attempt} of {retryNote.of}
        </span>
      </p>
    );
  }

  const elapsed = meta ? Date.now() - meta.startedAt : 0;
  const label = meta?.effort === 'instant' ? (meta?.diffusing ? 'Diffusing' : 'Writing') : 'Thinking';
  return (
    <p className="status-line" role="status">
      {label}
      <span className="dots" aria-hidden="true" />
      <span className="status-timer">{(elapsed / 1000).toFixed(1)} s</span>
    </p>
  );
}

/**
 * Diffusing mode: the whole answer, redrawn at every denoising step. Words that
 * changed since the previous frame are inked in the accent colour as they settle.
 */
function DiffusionCanvas({ text, steps }: { text: string; steps: number }) {
  const previous = useRef('');
  const segments = useMemo(() => diffCanvas(previous.current, text), [text]);
  useEffect(() => {
    previous.current = text;
  }, [text]);

  return (
    <div className="canvas">
      <p className="canvas-meter small-caps" aria-live="off">
        Denoising · step {steps}
      </p>
      <div className="canvas-text" aria-label="Mercury is writing" aria-busy="true">
        {segments.map((segment, i) =>
          segment.fresh ? (
            <span key={i} className="canvas-fresh">
              {segment.text}
            </span>
          ) : (
            <span key={i}>{segment.text}</span>
          ),
        )}
        <span className="caret" aria-hidden="true" />
      </div>
    </div>
  );
}

/** How long Mercury thought, and — if Inception returned one — a summary of its reasoning. */
function Reasoning({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const meta = message.meta;
  if (!meta || !meta.firstTokenAt || meta.effort === 'instant') return null;
  const thoughtMs = meta.firstTokenAt - meta.startedAt;
  const reasoningTokens = meta.usage?.reasoningTokens ?? 0;
  const label = `Thought for ${formatDuration(thoughtMs)}${reasoningTokens ? ` · ${formatCount(reasoningTokens)} reasoning tokens` : ''}`;
  const summary = message.reasoningSummary;

  if (!summary) return <p className="thinking-line">{label}</p>;
  return (
    <details className="thinking" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="thinking-label">{label}</span>
        <span className="thinking-hint">{open ? 'hide summary' : 'show summary'}</span>
      </summary>
      <div className="thinking-body">{summary}</div>
    </details>
  );
}

const ERROR_HINTS: Partial<Record<NonNullable<Message['error']>['kind'], string>> = {
  'rate-limit': 'Give it a few seconds, then retry.',
  overloaded: 'Try again in a moment.',
  server: 'Try again in a moment.',
  network: 'Check your connection and retry.',
  stream: 'Retry to get the whole answer.',
  auth: 'Update your API key — this answer will be retried automatically.',
  'no-key': 'Add your API key — this answer will be retried automatically.',
  billing: 'Add credit (or use another key), then retry.',
  model: 'Pick another model in Settings, then retry.',
};

function ErrorNote({ message }: { message: Message }) {
  const error = message.error!;
  const busy = useStore(store, (s) => s.streamingId !== null);
  const hint = error.kind === 'invalid' && error.code === 'context_length_exceeded' ? 'Start a new conversation to continue.' : (ERROR_HINTS[error.kind] ?? '');
  const needsKey = error.kind === 'auth' || error.kind === 'no-key';
  return (
    <div className="error-note" role="alert">
      <p>
        <strong>{error.message}</strong>
        {error.detail && error.detail !== error.message ? <span className="error-detail"> {error.detail}</span> : null}
        {hint ? <span className="error-hint"> {hint}</span> : null}
      </p>
      <div className="error-actions">
        {needsKey ? (
          <button type="button" className="text-button" onClick={openKeyEditor}>
            Update key
          </button>
        ) : null}
        {error.kind === 'billing' ? (
          <a className="text-button" href={LINKS.billing} target="_blank" rel="noopener noreferrer">
            Billing <ExternalIcon size={12} />
          </a>
        ) : null}
        {!needsKey ? (
          <button type="button" className="text-button" disabled={busy} onClick={() => void retry(message.id)}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Colophon({ message, isLast }: { message: Message; isLast: boolean }) {
  const [copied, setCopied] = useState(false);
  const busy = useStore(store, (s) => s.streamingId !== null);
  const meta = message.meta;
  const words = countWords(message.content);
  const usage = meta?.usage;
  const total = meta?.finishedAt && meta.startedAt ? meta.finishedAt - meta.startedAt : null;
  const firstWord = meta?.firstTokenAt && meta.startedAt ? meta.firstTokenAt - meta.startedAt : null;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const facts = [
    `${formatCount(words)} ${words === 1 ? 'word' : 'words'}`,
    usage ? `${formatCount(usage.completionTokens)} tokens` : '',
    // End-to-end throughput, thinking included: what it actually felt like.
    usage && total ? formatRate(usage.completionTokens, total) : '',
    firstWord !== null ? `first word ${formatDuration(firstWord)}` : '',
    total !== null ? formatDuration(total) : '',
    meta?.diffusing && meta.steps ? `${meta.steps} steps` : '',
  ].filter(Boolean);

  return (
    <footer className="colophon">
      <span className="colophon-meta" title={usage ? `${formatCount(usage.promptTokens)} prompt tokens${usage.cachedTokens ? ` (${formatCount(usage.cachedTokens)} cached)` : ''}` : undefined}>
        {facts.join(' · ')}
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
