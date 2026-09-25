import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { THINKING_LABELS, THINKING_MODES } from '../../site/config';
import { send, stop, store, updateSettings } from '../controller';
import { useStore } from '../store';
import { ArrowUpIcon, GlobeIcon, StopIcon } from './Icons';

export function Composer() {
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const streaming = useStore(store, (s) => s.streamingId !== null);
  const thinking = useStore(store, (s) => s.settings.thinking);
  const webSearch = useStore(store, (s) => s.settings.webSearch);
  const status = useStore(store, (s) => s.connection.status);
  const activeId = useStore(store, (s) => s.active?.id ?? null);
  const blocked = status !== 'live';
  const canSend = text.trim().length > 0 && !streaming && !blocked;

  // Grow with the text, up to a comfortable height.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.38))}px`;
  }, [text]);

  useEffect(() => {
    if (!blocked) area.current?.focus();
  }, [activeId, blocked]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    const value = text;
    setText('');
    void send(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && streaming) {
      event.preventDefault();
      stop();
    }
  };

  return (
    <div className="composer-dock">
      <form className="composer" onSubmit={submit} data-disabled={blocked}>
        <label htmlFor="composer-input" className="visually-hidden">
          Message Mercury
        </label>
        <textarea
          id="composer-input"
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={blocked ? (status === 'preview' ? 'Run npm start on your computer to chat.' : 'Connecting to the site…') : 'Ask Mercury anything…'}
          disabled={blocked}
          spellCheck
          autoComplete="off"
        />
        <div className="composer-bar">
          <button
            type="button"
            className="toggle"
            aria-pressed={webSearch}
            onClick={() => updateSettings({ webSearch: !webSearch })}
            title={webSearch ? 'Web search is on' : 'Web search is off'}
          >
            <GlobeIcon size={15} />
            <span>Web</span>
          </button>

          <div className="modes" role="radiogroup" aria-label="Thinking mode">
            {THINKING_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={thinking === mode}
                className="mode"
                onClick={() => updateSettings({ thinking: mode })}
              >
                {THINKING_LABELS[mode]}
              </button>
            ))}
          </div>

          <span className="composer-hint" aria-hidden="true">
            {streaming ? 'esc to stop' : '↵ send · ⇧↵ line'}
          </span>

          {streaming ? (
            <button type="button" className="send-button send-button--stop" onClick={stop} aria-label="Stop generating">
              <StopIcon size={16} />
            </button>
          ) : (
            <button type="submit" className="send-button" disabled={!canSend} aria-label="Send">
              <ArrowUpIcon size={17} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
