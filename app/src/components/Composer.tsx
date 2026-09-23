// ══════════════════════════════════════════════════════════════
//  Composer — input plus the per-provider controls that actually exist.
//
//  Controls are driven by the capability model, not hardcoded: the search toggle
//  only appears when the SELECTED model on the SELECTED provider reports
//  `search`, and the effort segmented control only lists the levels that model
//  accepts (solar-pro3 takes low/medium/high; pro2 and syn-pro only low/high;
//  solar-mini has no reasoning at all).
// ══════════════════════════════════════════════════════════════
import { useEffect, useRef } from 'react';
import type { ModelRecord, ProviderMeta } from '../types';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  provider: ProviderMeta;
  model: ModelRecord | null;
  search: boolean;
  onSearch: (v: boolean) => void;
  reasoning: string;
  onReasoning: (v: string) => void;
  efforts: string[];
  canThink: boolean;
}

export default function Composer(p: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with content, capped by CSS max-height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
  }, [p.value]);

  const canSearch = Boolean(p.model?.capabilities[p.provider.id]?.search) && p.provider.supports.search;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!p.streaming && p.value.trim()) p.onSend();
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <div className="toggles">
          <button
            className={`toggle${p.search && canSearch ? ' on' : ''}`}
            disabled={!canSearch}
            onClick={() => p.onSearch(!p.search)}
            title={canSearch ? 'Web search (Upstage: also raises reasoning to high)' : 'This model does not support web search'}
          >
            ⌕ Web search
          </button>

          {p.efforts.length > 0 && (
            <span className="seg" title="Reasoning effort">
              {p.efforts.map((e) => (
                <button key={e} className={p.reasoning === e ? 'on' : ''} onClick={() => p.onReasoning(e)}>
                  {e}
                </button>
              ))}
            </span>
          )}

          {p.canThink && (
            <span className="chip think" title="This provider emits reasoning tokens">
              ✦ thinking
            </span>
          )}
          {p.provider.supports.attachments && (
            <span className="chip attach" title="Attachments designed for; UI not yet wired">
              ⇪ attachments
            </span>
          )}
          {p.provider.supports.credentials && (
            <span className="chip cred" title="Needs captured session credentials supplied to the bridge">
              ⚿ credentials
            </span>
          )}
          <span className="chip wire" title="Wire format this provider speaks">{p.provider.wire}</span>
        </div>

        <div className="input-row">
          <textarea
            ref={ref}
            className="input"
            rows={1}
            placeholder={`Message ${p.provider.label}…`}
            value={p.value}
            onChange={(e) => p.onChange(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          {p.streaming ? (
            <button className="send stop" onClick={p.onStop} title="Stop generating" aria-label="Stop">
              ■
            </button>
          ) : (
            <button
              className="send"
              onClick={p.onSend}
              disabled={!p.value.trim()}
              title="Send (Enter)"
              aria-label="Send"
            >
              ↑
            </button>
          )}
        </div>

        <div className="hint">
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          {p.model?.maxTokens?.[p.provider.id] != null && (
            <> · context {Number(p.model.maxTokens[p.provider.id]).toLocaleString()}</>
          )}
        </div>
      </div>
    </div>
  );
}
