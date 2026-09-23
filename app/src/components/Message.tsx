// ══════════════════════════════════════════════════════════════
//  Message — renders ONE unified ChatMessage.
//
//  It never branches on provider or wire format. Thinking, sources, usage and
//  status arrive as normalised fields, so a provider added tomorrow renders
//  correctly with no change here (ARCHITECTURE.md §4).
// ══════════════════════════════════════════════════════════════
import { useState } from 'react';
import type { ChatMessage } from '../types';
import { providerMeta } from '../data/providers';
import { MODELS } from '../data/models';
import { Markdown } from '../lib/markdown';

const fmtMs = (ms?: number) => (ms == null ? null : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

function Usage({ m }: { m: ChatMessage }) {
  const u = m.usage;
  const parts: string[] = [];
  if (m.ttftMs != null) parts.push(`first token ${fmtMs(m.ttftMs)}`);
  if (m.elapsedMs != null) parts.push(`total ${fmtMs(m.elapsedMs)}`);
  if (u) {
    if (u.promptTokens != null) parts.push(`in ${u.promptTokens.toLocaleString()}`);
    if (u.completionTokens != null) parts.push(`out ${u.completionTokens.toLocaleString()}`);
    if (u.totalTokens != null) parts.push(`Σ ${u.totalTokens.toLocaleString()}`);
    if (u.completionTokens && m.elapsedMs) {
      const tps = u.completionTokens / (m.elapsedMs / 1000);
      if (Number.isFinite(tps) && tps > 0) parts.push(`${tps.toFixed(0)} tok/s`);
    }
    if (u.estimated) parts.push('estimated');
  }
  if (m.finishReason && m.finishReason !== 'stop' && m.finishReason !== '[DONE]') {
    parts.push(`finish: ${m.finishReason}`);
  }
  if (!parts.length) return null;
  return (
    <div className="usage">
      {parts.map((p, i) => (
        <span key={i}><b>{p.split(' ')[0]}</b> {p.split(' ').slice(1).join(' ')}</span>
      ))}
    </div>
  );
}

export default function Message({ m }: { m: ChatMessage }) {
  const [thinkOpen, setThinkOpen] = useState(true);
  const meta = m.provider ? providerMeta(m.provider) : null;
  const record = m.model ? MODELS.find((x) => x.name === m.model) : null;
  const isUser = m.role === 'user';

  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="msg-head">
        {meta && <span className="swatch" style={{ background: meta.accent }} />}
        <span className="who">{isUser ? 'You' : (record?.display ?? m.model ?? meta?.label ?? 'Assistant')}</span>
        {!isUser && meta && <span>{meta.label}</span>}
        {m.streaming && <span className="pulse" />}
      </div>

      {isUser ? (
        <div className="bubble">{m.content}</div>
      ) : (
        <div className="bubble">
          {m.thinking && (
            <div className="think-block">
              <button className="think-head" onClick={() => setThinkOpen((o) => !o)}>
                {m.streaming && !m.content ? <span className="pulse" /> : <span>{thinkOpen ? '▾' : '▸'}</span>}
                {m.streaming && !m.content ? 'Thinking…' : `Thought process · ${m.thinking.length.toLocaleString()} chars`}
              </button>
              {thinkOpen && <div className="think-body">{m.thinking}</div>}
            </div>
          )}

          {m.status && m.streaming && !m.content && (
            <div className="status-line">
              <span className="spinner" />
              {m.status}
            </div>
          )}

          {m.content ? (
            <div className="md">
              <Markdown text={m.content} streaming={Boolean(m.streaming)} />
              {m.streaming && <span className="caret" />}
            </div>
          ) : (
            m.streaming && !m.thinking && !m.status && (
              <div className="status-line"><span className="spinner" />Waiting for first token…</div>
            )
          )}

          {m.sources.length > 0 && (
            <div className="sources">
              {m.sources.map((s, i) => {
                let host = s.url;
                try {
                  host = new URL(s.url).hostname.replace(/^www\./, '');
                } catch {
                  /* keep raw */
                }
                return (
                  <a className="source" key={`${s.id ?? i}-${s.url}`} href={s.url} target="_blank" rel="noreferrer noopener" title={s.url}>
                    <span className="n">{i + 1}</span>
                    <span className="t">{s.title || host}</span>
                  </a>
                );
              })}
            </div>
          )}

          <Usage m={m} />

          {m.error && (
            <div className="err-box">
              {m.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
